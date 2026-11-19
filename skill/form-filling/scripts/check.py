"""Gate a filled form against its mapping before it is delivered.

Usage: python check.py FORM OUT MAPPING.json [--render DIR]

FORM is the original the output was made from, so it doubles as the baseline for an update.

Checks: every mapped id exists in the original; every mapped value is present in the filled copy, and
an updated Word or fillable PDF field no longer holds its old value; every required field is filled or
explained in blank_reasons; Bangla runs in Word carry the complex-script font; text fits its PDF box;
fields nobody mapped were not changed; overlay text sits on the page and clear of printed words; a
replace entry fits at 6 pt or more. Every change is reported as "label: old → new". --render writes a PNG of each page that received values
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
    sdt_text,
    unique_cells,
    docx_fields,
    docx_target,
    form_kind,
    marks,
    paragraph_text,
    pdf_form_fields,
)
from fill import (
    MIN_REPLACE_SIZE,
    Report,
    box_glyph,
    change_line,
    inline_text,
    is_blank,
    label_of,
    load_mapping,
    overlay_entry,
    overlay_overflow,
    pdf_overflow,
    pdf_value,
    replace_plan,
    text_width,
    top_rect,
    truthy,
    wrap,
)
from pypdf import PdfReader


def normal(text):
    return re.sub(r"\s+", " ", str(text)).strip().casefold()


class Result:
    def __init__(self):
        self.defects, self.warnings, self.changes, self.passed = [], [], [], 0
        self.pages = set()

    def lines(self):
        verdict = "PASS" if not self.defects else f"FAIL: {len(self.defects)} defects"
        out = [f"{verdict} ({self.passed} values verified, {len(self.warnings)} warnings)"]
        out += [f"  change: {c}" for c in self.changes]
        out += [f"  defect: {d}" for d in self.defects]
        out += [f"  warning: {w}" for w in self.warnings]
        return out


def check_mapping(mapping, known, result, listed=None):
    reasons = mapping["blank_reasons"]
    for entry in mapping["fields"]:
        if known is not None and entry["id"] not in known:
            result.defects.append(f"{entry['id']}: no such field in the form (run fields.py again)")
        if is_blank(entry.get("value")) and entry.get("required") and not reasons.get(entry["id"]):
            result.defects.append(f"{label_of(entry)}: required but blank, and no reason in blank_reasons")
    if known is not None:
        mapped = {entry["id"] for entry in mapping["fields"]}
        left = [field_id for field_id in (listed or known) if field_id not in mapped]
        if left:
            result.warnings.append(f"{len(left)} form fields are not in the mapping: {', '.join(left[:12])}"
                                   + (" ..." if len(left) > 12 else ""))


# ---------------------------------------------------------------- Word


def bangla_runs_without_font(element, value):
    """Runs that hold this value; a Bangla label beside it in the same paragraph is the form's own."""
    wanted = str(value).split("\n")[0].strip()
    if not BANGLA.search(wanted):
        return 0
    missing = 0
    for r in element.iter(qn("w:r")):
        text = "".join(t.text or "" for t in r.iter(qn("w:t")))
        fonts = r.find(f"{qn('w:rPr')}/{qn('w:rFonts')}")
        if wanted in text and (fonts is None or not fonts.get(qn("w:cs"))):
            missing += 1
    return missing


def docx_value_present(target, field, value):
    was_filled = bool(field.get("value"))
    if target.kind == "cell":
        text = normal(target.element.text)
        return (normal(value) == text if was_filled else normal(value) in text), target.element._tc
    if target.kind == "sdt":
        if field["type"] == "checkbox":
            state = target.element.find(f"{qn('w:sdtPr')}/{W14}checkbox/{W14}checked")
            return (state is not None and state.get(f"{W14}val") in ("1", "true")) == truthy(value), target.element
        content = target.element.find(qn("w:sdtContent"))
        text = "".join(t.text or "" for t in content.iter(qn("w:t")))
        wanted = [normal(value)] + [normal(o["text"]) for o in field.get("options", [])
                                    if normal(value) in (normal(o["value"]), normal(o["text"]))]
        if was_filled:
            return normal(text) in wanted, target.element
        return any(w and w in normal(text) for w in wanted), target.element
    text = paragraph_text(target.element)
    if target.kind == "box":
        boxes = [start for kind, start, _ in marks(text) if kind == "box"]
        number = target.mark[1]
        return number < len(boxes) and (text[boxes[number]] in CHECKED_BOXES) == truthy(value), target.element
    return normal(value) in normal(text), target.element


def docx_places(doc):
    """Every body paragraph, cell paragraph and content control, as place key -> text."""
    places = {f"p{i}": paragraph_text(p._p) for i, p in enumerate(doc.paragraphs)}
    places.update({f"sdt{i}": sdt_text(sdt) for i, sdt in enumerate(all_sdts(doc))})
    for t, table in enumerate(doc.tables):
        seen = set()
        for r, row in enumerate(table.rows):
            for c, cell in enumerate(unique_cells(row)):
                if cell._tc in seen:
                    continue
                seen.add(cell._tc)
                places.update({f"t{t}.r{r}.c{c}.p{p}": paragraph_text(para._p) for p, para in enumerate(cell.paragraphs)})
    return places


def expected_paragraphs(doc, entries):
    """Place key -> the paragraph's text with its mapped blanks, boxes and values substituted."""
    edits = {}
    for entry in entries:
        target = docx_target(doc, entry["id"])
        if not target.span:
            continue
        text = box_glyph(entry["value"]) if target.kind == "box" else inline_text(entry["value"])
        place = entry["id"].rsplit(".", 1)[0]
        edits.setdefault(place, (target.element, []))[1].append((*target.span, text))
    expected = {}
    for place, (paragraph, spans) in edits.items():
        text = paragraph_text(paragraph)
        for start, end, value in sorted(spans, reverse=True):
            text = text[:start] + value + text[end:]
        expected[place] = text
    return expected


def check_docx_places(form, out, entries, result):
    """Places outside the mapping are unchanged; mapped paragraphs changed only in their mapped spans."""
    original = Document(str(form))
    before, after = docx_places(original), docx_places(Document(str(out)))
    expected = expected_paragraphs(original, entries)
    replaced = {entry["id"] for entry in entries}
    for place, text in before.items():
        if place in expected:
            if normal(after.get(place, "")) != normal(expected[place]):
                result.defects.append(f"{place}: expected {expected[place][:60]!r}, the filled copy has "
                                      f"{after.get(place, '')[:60]!r}")
            continue
        if place in replaced or place.rsplit(".", 1)[0] in replaced:
            continue
        if normal(after.get(place, "")) != normal(text):
            result.defects.append(f"{place}: changed although it is not in the mapping "
                                  f"({text[:40]!r} → {after.get(place, '')[:40]!r})")


def check_docx(form, out, mapping, result):
    known = {f["id"]: f for f in docx_fields(form, include_filled=True)["fields"]}
    listed = [f["id"] for f in docx_fields(form)["fields"]]
    check_mapping(mapping, known, result, listed)
    doc = Document(str(out))
    sdts = all_sdts(doc)
    entries = [e for e in mapping["fields"] if not is_blank(e.get("value")) and e["id"] in known]
    for entry in entries:
        field = known[entry["id"]]
        try:
            target = docx_target(doc, entry["id"], sdts, spans=False)
        except KeyError:
            result.defects.append(f"{label_of(entry)}: cannot find this place in the filled copy")
            continue
        present, element = docx_value_present(target, field, entry["value"])
        if not present:
            result.defects.append(f"{label_of(entry)}: value {str(entry['value'])[:40]!r} is not in the filled copy")
            continue
        if bangla_runs_without_font(element, entry["value"]):
            result.defects.append(f"{label_of(entry)}: Bangla text without a complex-script (w:cs) font")
            continue
        result.passed += 1
        result.changes.append(change_line(entry, field.get("value"), entry["value"], field["label"]))
    check_docx_places(form, out, entries, result)


# ---------------------------------------------------------------- PDF


def check_pdf_form(form, out, mapping, result):
    before = {f["id"]: f for f in pdf_form_fields(form)["fields"]}
    after = {f["id"]: f for f in pdf_form_fields(out)["fields"]}
    check_mapping(mapping, before, result)
    mapped = set()
    for entry in mapping["fields"]:
        field = before.get(entry["id"])
        if is_blank(entry.get("value")) or field is None:
            continue
        mapped.add(entry["id"])
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
        result.changes.append(change_line(entry, field.get("value"), expected, field["label"]))
    for field_id, field in before.items():
        if field_id not in mapped and after.get(field_id, {}).get("value") != field.get("value"):
            result.defects.append(f"{field_id}: changed although it is not in the mapping")


def printed_words(form):
    import pdfplumber

    with pdfplumber.open(str(form)) as pdf:
        return [[w for w in page.extract_words() if not re.fullmatch(r"[_.…\s]+", w["text"])] for page in pdf.pages]


def centre_inside(item, rect):
    x, y = (item["x0"] + item["x1"]) / 2, (item["top"] + item["bottom"]) / 2
    return rect[0] <= x <= rect[2] and rect[1] <= y <= rect[3]


def reaches_into(item, rect):
    """Font bounding boxes run taller than the glyphs, so they are trimmed by a fifth before comparing."""
    trim = (item["bottom"] - item["top"]) * 0.2
    return (item["x0"] < rect[2] - 1 and item["x1"] > rect[0] + 1
            and item["top"] + trim < rect[3] and item["bottom"] - trim > rect[1])


def clash_with_neighbour(page, rect, whole_words):
    """A printed word the cover cuts into. A found value is whole by construction, so only its neighbours count."""
    words = page.extract_words()
    if whole_words:
        cut = (w for w in words if reaches_into(w, rect) and (w["x0"] < rect[0] - 1 or w["x1"] > rect[2] + 1))
        return next((w["text"] for w in cut), None)
    char = next((c for c in page.chars if c["text"].strip() and reaches_into(c, rect) and not centre_inside(c, rect)), None)
    if char is None:
        return None
    return next((w["text"] for w in words if w["x0"] <= char["x0"] <= w["x1"] and w["top"] <= char["top"] <= w["bottom"]),
                char["text"])


def check_flattened(entry, plan, output_page, result):
    if (output_page.extract_text() or "").strip():
        result.defects.append(f"{label_of(entry)}: flatten_replaced is set but page {plan['page']} still has a text layer")
        return False
    result.warnings.append(f"{label_of(entry)}: page {plan['page']} is an image now; confirm the new value on the render")
    return True


def check_replace_value(entry, plan, output_page, mapping, result):
    if mapping.get("flatten_replaced"):
        return check_flattened(entry, plan, output_page, result)
    result.warnings.append(f"{label_of(entry)}: the old value {plan['old']!r} stays in the text layer under the cover; "
                           "it can be copied or found by search unless flatten_replaced is set")
    if BANGLA.search(plan["value"]):
        result.warnings.append(f"{label_of(entry)}: Bangla overlay cannot be read back; confirm on the render")
        return True
    if normal(plan["value"]) in normal(output_page.extract_text() or ""):
        return True
    result.defects.append(f"{label_of(entry)}: new value {plan['value'][:40]!r} not found on page {plan['page']}")
    return False


def check_replacement(entry, mapping, pdf, raw_boxes, reader, result):
    """Verifies one replace entry; returns its plan so other overlay text may sit where its old value was."""
    try:
        plan = replace_plan(entry, mapping, pdf, raw_boxes, Report(), {})
    except (ValueError, TypeError) as error:
        result.defects.append(f"{label_of(entry)}: {error}")
        return None
    if not plan["fits"]:
        result.defects.append(f"{label_of(entry)}: {plan['value'][:40]!r} cannot fit its {round(plan.get('room', plan['width']))} pt box "
                              f"even shrunk below {MIN_REPLACE_SIZE:g} pt")
        return None
    page = pdf.pages[plan["page"] - 1]
    clash = clash_with_neighbour(page, top_rect(plan, page), whole_words="box" in entry["replace"])
    if clash:
        result.defects.append(f"{label_of(entry)}: drawn over the printed word {clash!r}; move it")
    found = check_replace_value(entry, plan, reader.pages[plan["page"] - 1], mapping, result)
    result.pages.add(plan["page"])
    if found and not clash:
        result.passed += 1
        result.changes.append(change_line(entry, plan["old"], plan["value"]))
    return plan


def check_replacements(form, mapping, reader, result):
    """Rectangles covered by replace entries, per page, in pdfplumber's top-left coordinates."""
    import pdfplumber

    original = PdfReader(str(form))
    raw_boxes = [[float(v) for v in page.mediabox] for page in original.pages]
    covers = {}
    with pdfplumber.open(str(form)) as pdf:
        for entry in mapping["fields"]:
            if "replace" not in entry or is_blank(entry.get("value")):
                continue
            plan = check_replacement(entry, mapping, pdf, raw_boxes, reader, result)
            if plan:
                covers.setdefault(plan["page"], []).append(top_rect(plan, pdf.pages[plan["page"] - 1]))
    return covers


def check_overlay(form, out, mapping, result):
    check_mapping(mapping, None, result)
    reader = PdfReader(str(out))
    covers = check_replacements(form, mapping, reader, result)
    words = [[w for w in page_words if not any(centre_inside(w, rect) for rect in covers.get(number, []))]
             for number, page_words in enumerate(printed_words(form), start=1)]
    texts = {}
    for entry in mapping["fields"]:
        if is_blank(entry.get("value")) or "replace" in entry:
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
            result.changes.append(change_line(entry, "", entry["value"]))


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
