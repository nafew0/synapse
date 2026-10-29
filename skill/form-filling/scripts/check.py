"""Gate a filled form against its mapping before it is delivered.

Usage: python check.py FORM OUT MAPPING.json [--render DIR]

Checks: every mapped id exists in the blank form; every mapped value is present in the filled copy;
every required field is filled or explained in blank_reasons; Bangla runs in Word carry the
complex-script font; text fits its PDF box; fields nobody mapped were not changed; overlay text sits
on the page and clear of printed words. --render writes a PNG of each page that received values
(needs pdftoppm, and LibreOffice for Word); it is skipped with a note when they are missing.

Exit codes: 0 pass, 2 defects listed, 1 bad arguments or unreadable files.
"""
import argparse
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from docx import Document
from docx.oxml.ns import qn
from fields import (
    BANGLA,
    CHECKED_BOXES,
    W14,
    all_sdts,
    docx_fields,
    docx_target,
    form_kind,
    marks,
    paragraph_text,
    pdf_form_fields,
)
from fill import (
    is_blank,
    label_of,
    load_mapping,
    overlay_entry,
    overlay_overflow,
    pdf_overflow,
    pdf_value,
    text_width,
    truthy,
    wrap,
)
from pypdf import PdfReader


def normal(text):
    return re.sub(r"\s+", " ", str(text)).strip().casefold()


class Result:
    def __init__(self):
        self.defects, self.warnings, self.passed = [], [], 0
        self.pages = set()

    def lines(self):
        verdict = "PASS" if not self.defects else f"FAIL: {len(self.defects)} defects"
        out = [f"{verdict} ({self.passed} values verified, {len(self.warnings)} warnings)"]
        out += [f"  defect: {d}" for d in self.defects]
        out += [f"  warning: {w}" for w in self.warnings]
        return out


def check_mapping(mapping, known, result):
    reasons = mapping["blank_reasons"]
    for entry in mapping["fields"]:
        if known is not None and entry["id"] not in known:
            result.defects.append(f"{entry['id']}: no such field in the form (run fields.py again)")
        if is_blank(entry.get("value")) and entry.get("required") and not reasons.get(entry["id"]):
            result.defects.append(f"{label_of(entry)}: required but blank, and no reason in blank_reasons")
    if known is not None:
        mapped = {entry["id"] for entry in mapping["fields"]}
        left = [field_id for field_id in known if field_id not in mapped]
        if left:
            result.warnings.append(f"{len(left)} form fields are not in the mapping: {', '.join(left[:12])}"
                                   + (" ..." if len(left) > 12 else ""))


# ---------------------------------------------------------------- Word


def bangla_runs_without_font(element):
    missing = 0
    for r in element.iter(qn("w:r")):
        text = "".join(t.text or "" for t in r.iter(qn("w:t")))
        fonts = r.find(f"{qn('w:rPr')}/{qn('w:rFonts')}")
        if BANGLA.search(text) and (fonts is None or not fonts.get(qn("w:cs"))):
            missing += 1
    return missing


def docx_value_present(target, field, value):
    if target.kind == "cell":
        return normal(value) in normal(target.element.text), target.element._tc
    if target.kind == "sdt":
        if field["type"] == "checkbox":
            state = target.element.find(f"{qn('w:sdtPr')}/{W14}checkbox/{W14}checked")
            return (state is not None and state.get(f"{W14}val") in ("1", "true")) == truthy(value), target.element
        content = target.element.find(qn("w:sdtContent"))
        text = "".join(t.text or "" for t in content.iter(qn("w:t")))
        wanted = [normal(value)] + [normal(o["text"]) for o in field.get("options", [])
                                    if normal(value) in (normal(o["value"]), normal(o["text"]))]
        return any(w and w in normal(text) for w in wanted), target.element
    text = paragraph_text(target.element)
    if target.kind == "box":
        boxes = [start for kind, start, _ in marks(text) if kind == "box"]
        number = target.mark[1]
        return number < len(boxes) and (text[boxes[number]] in CHECKED_BOXES) == truthy(value), target.element
    return normal(value) in normal(text), target.element


def check_docx(form, out, mapping, result):
    known = {f["id"]: f for f in docx_fields(form)["fields"]}
    check_mapping(mapping, known, result)
    doc = Document(str(out))
    sdts = all_sdts(doc)
    for entry in mapping["fields"]:
        if is_blank(entry.get("value")) or entry["id"] not in known:
            continue
        try:
            target = docx_target(doc, entry["id"], sdts, spans=False)
        except KeyError:
            result.defects.append(f"{label_of(entry)}: cannot find this place in the filled copy")
            continue
        present, element = docx_value_present(target, known[entry["id"]], entry["value"])
        if not present:
            result.defects.append(f"{label_of(entry)}: value {str(entry['value'])[:40]!r} is not in the filled copy")
            continue
        if bangla_runs_without_font(element):
            result.defects.append(f"{label_of(entry)}: Bangla text without a complex-script (w:cs) font")
            continue
        result.passed += 1


# ---------------------------------------------------------------- PDF


def check_pdf_form(form, out, mapping, result):
    before = {f["id"]: f for f in pdf_form_fields(form)["fields"]}
    after = {f["id"]: f for f in pdf_form_fields(out)["fields"]}
    check_mapping(mapping, before, result)
    mapped = set()
    for entry in mapping["fields"]:
        mapped.add(entry["id"])
        field = before.get(entry["id"])
        if is_blank(entry.get("value")) or field is None:
            continue
        try:
            expected = pdf_value(field, entry["value"])
        except ValueError as error:
            result.defects.append(f"{label_of(entry)}: {entry['value']!r} {error}")
            continue
        got = after.get(entry["id"], {}).get("value", "")
        if normal(got) != normal(expected):
            result.defects.append(f"{label_of(entry)}: expected {expected!r}, the filled copy has {got!r}")
            continue
        overflow = pdf_overflow(field, expected)
        if overflow:
            result.defects.append(f"{label_of(entry)}: overflow, {overflow}")
            continue
        result.pages.add(field["page"])
        result.passed += 1
    for field_id, field in before.items():
        if field_id not in mapped and after.get(field_id, {}).get("value") != field.get("value"):
            result.defects.append(f"{field_id}: changed although it is not in the mapping")


def printed_words(form):
    import pdfplumber

    with pdfplumber.open(str(form)) as pdf:
        return [[w for w in page.extract_words() if not re.fullmatch(r"[_.…\s]+", w["text"])] for page in pdf.pages]


def check_overlay(form, out, mapping, result):
    check_mapping(mapping, None, result)
    reader = PdfReader(str(out))
    words = printed_words(form)
    texts = {}
    for entry in mapping["fields"]:
        if is_blank(entry.get("value")):
            continue
        page_number = int(entry.get("page", 0))
        if not 1 <= page_number <= len(reader.pages) or "x" not in entry or "y" not in entry:
            result.defects.append(f"{label_of(entry)}: needs a valid page, x and y")
            continue
        page = reader.pages[page_number - 1]
        box = [float(v) for v in page.mediabox]
        x, y, width, height = overlay_entry(entry, mapping, box)
        size = float(entry.get("size", 10))
        if not (box[0] <= x < box[2] and box[1] <= y < box[3]):
            result.defects.append(f"{label_of(entry)}: position {round(x)},{round(y)} is off the page")
            continue
        result.pages.add(page_number)
        if isinstance(entry["value"], bool) or entry.get("type") == "check":
            result.passed += 1
            continue
        lines = wrap(entry["value"], width, size) if width else str(entry["value"]).split("\n")
        overflow = overlay_overflow(lines, size, x, width, height, box)
        if overflow:
            result.defects.append(f"{label_of(entry)}: overflow, {overflow}")
        longest = width or max(text_width(line, size) for line in lines)
        clash = overlapping_word(words[page_number - 1], (x, y, longest, size, len(lines)), box)
        if clash:
            result.defects.append(f"{label_of(entry)}: drawn over the printed word {clash!r}; move it")
        if page_number not in texts:
            texts[page_number] = normal(page.extract_text() or "")
        if BANGLA.search(str(entry["value"])):
            result.warnings.append(f"{label_of(entry)}: Bangla overlay cannot be read back; confirm on the render")
        elif normal(lines[0]) not in texts[page_number]:
            result.defects.append(f"{label_of(entry)}: value not found on page {page_number}")
            continue
        if not overflow and not clash:
            result.passed += 1


def overlapping_word(words, placed, box):
    x, y, width, size, count = placed
    height = box[3] - box[1]
    top = height - (y - box[1]) - size * 0.8
    bottom = height - (y - box[1]) + size * 0.2 + (count - 1) * size * 1.2
    left, right = x - box[0], x - box[0] + width
    for word in words:
        if word["x0"] < right - 1 and word["x1"] > left + 1 and word["top"] < bottom - 1 and word["bottom"] > top + 1:
            return word["text"]
    return None


# ---------------------------------------------------------------- render


def to_pdf(out, work):
    if Path(out).suffix.lower() == ".pdf":
        return Path(out)
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from office.soffice import run_soffice

    run_soffice(["--headless", "--convert-to", "pdf", "--outdir", str(work), str(out)],
                capture_output=True, text=True, timeout=180)
    pdf = Path(work) / (Path(out).stem + ".pdf")
    return pdf if pdf.exists() else None


def pages_with_values(pdf, mapping):
    wanted = [normal(str(e["value"]))[:15] for e in mapping["fields"]
              if not is_blank(e.get("value")) and not isinstance(e["value"], bool)]
    reader = PdfReader(str(pdf))
    pages = {i for i, page in enumerate(reader.pages, start=1)
             if any(w and w in normal(page.extract_text() or "") for w in wanted)}
    return pages or {1}


def render(out, mapping, pages, directory):
    if not shutil.which("pdftoppm"):
        return ["render skipped: pdftoppm is not installed"]
    if Path(out).suffix.lower() != ".pdf" and not shutil.which("soffice"):
        return ["render skipped: LibreOffice is not installed"]
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as work:
        pdf = to_pdf(out, work)
        if pdf is None:
            return ["render skipped: LibreOffice could not convert the document"]
        pages = pages or pages_with_values(pdf, mapping)
        written = []
        for page in sorted(pages):
            stem = directory / f"{Path(out).stem}-page{page}"
            subprocess.run(["pdftoppm", "-r", "80", "-png", "-singlefile", "-f", str(page), "-l", str(page),
                            str(pdf), str(stem)], capture_output=True, timeout=120, check=False)
            if stem.with_suffix(".png").exists():
                written.append(str(stem.with_suffix(".png")))
    return [f"rendered: {path}" for path in written] or ["render produced no images"]


def main(argv):
    parser = argparse.ArgumentParser(description="Gate a filled form against its mapping.")
    parser.add_argument("form")
    parser.add_argument("out")
    parser.add_argument("mapping")
    parser.add_argument("--render", metavar="DIR", help="write a PNG of each page that received values here")
    args = parser.parse_args(argv)
    try:
        mapping = load_mapping(args.mapping)
        kind = form_kind(args.form)
        result = Result()
        {"docx": check_docx, "pdf_form": check_pdf_form, "pdf_flat": check_overlay}[kind](
            args.form, args.out, mapping, result)
    except (OSError, ValueError, KeyError) as error:
        print(f"error: {error}")
        return 1
    print("\n".join(result.lines()))
    blank = [label_of(e) for e in mapping["fields"] if is_blank(e.get("value"))]
    if blank:
        print(f"left blank ({len(blank)}): " + "; ".join(
            f"{b}: {mapping['blank_reasons'].get(e['id'], 'no reason')}"
            for b, e in zip(blank, [e for e in mapping["fields"] if is_blank(e.get("value"))])))
    if args.render:
        print("\n".join(render(args.out, mapping, result.pages if kind != "docx" else None, args.render)))
    return 2 if result.defects else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
