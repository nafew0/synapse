"""Fill a PDF or Word form from a mapping JSON (see references/mapping.md).

Usage: python fill.py FORM.pdf|FORM.docx MAPPING.json OUT

Fillable PDFs get their AcroForm fields set; flat or scanned PDFs get the text drawn on top at the
mapping's page/x/y; Word forms get the value written into the cell, content control, underscore
blank or tick box, in that place's own formatting, with Bangla in the complex-script font slot.

Exit codes: 0 filled, 2 filled with problems (unknown ids, bad options, text that will not fit),
1 bad arguments or unreadable files.
"""
import copy
import io
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.text.run import Run
from fields import (
    BANGLA,
    W14,
    all_sdts,
    docx_target,
    form_kind,
    pdf_form_fields,
    pdf_widgets,
    text_nodes,
)
from pypdf import PdfReader, PdfWriter
from reportlab.pdfbase import pdfmetrics, ttfonts
from reportlab.pdfgen import canvas

R_PR_ORDER = (
    "rStyle rFonts b bCs i iCs caps smallCaps strike dstrike outline shadow emboss imprint noProof "
    "snapToGrid vanish webHidden color spacing w kern position sz szCs highlight u effect bdr shd "
    "fitText vertAlign rtl cs em lang eastAsianLayout specVanish oMath"
).split()
TRUE_WORDS = {"1", "true", "yes", "y", "x", "on", "checked", "✓", "✔", "☒", "☑", "হ্যাঁ", "হ্যা"}
BANGLA_FONTS = (
    "/usr/share/fonts/truetype/bangladesh/Nikosh.ttf",
    "/usr/share/fonts/truetype/bangladesh/SolaimanLipi_20-04-07.ttf",
    "/usr/share/fonts/truetype/bangladesh/kalpurush.ttf",
    "/usr/share/fonts/truetype/noto/NotoSansBengali-Regular.ttf",
)
UNICODE_FONTS = (
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
)
PDF_COMBO_EDIT = 1 << 18


class Report:
    def __init__(self):
        self.filled, self.blank, self.unknown, self.problems, self.notes = [], [], [], [], []

    def lines(self):
        out = [(f"filled {len(self.filled)}, blank {len(self.blank)}, unknown ids {len(self.unknown)}, "
                f"problems {len(self.problems)}")]
        out += [f"  unknown id: {field_id}" for field_id in self.unknown]
        out += [f"  problem: {problem}" for problem in self.problems]
        out += [f"  blank: {item}" for item in self.blank]
        out += [f"  note: {note}" for note in self.notes]
        return out

    @property
    def code(self):
        return 2 if self.unknown or self.problems else 0


def load_mapping(path):
    mapping = json.loads(Path(path).read_text(encoding="utf-8"))
    if isinstance(mapping, list):
        mapping = {"fields": mapping}
    entries = mapping.get("fields")
    if not isinstance(entries, list) or not all(isinstance(e, dict) and e.get("id") for e in entries):
        raise ValueError('mapping needs "fields": a list of objects that each have an "id"')
    mapping.setdefault("blank_reasons", {})
    return mapping


def is_blank(value):
    return value is None or (isinstance(value, str) and not value.strip())


def truthy(value):
    if isinstance(value, bool):
        return value
    text = str(value).strip()
    if text.startswith("/"):
        return text != "/Off"
    return text.lower() in TRUE_WORDS


def label_of(entry):
    return f"{entry['id']} ({entry['label']})" if entry.get("label") else entry["id"]


def split_entries(mapping, report):
    """Entries with a value to write; blank ones go to the report with their reason."""
    reasons, seen, todo = mapping["blank_reasons"], set(), []
    for entry in mapping["fields"]:
        if entry["id"] in seen:
            report.problems.append(f"{entry['id']} is mapped twice")
            continue
        seen.add(entry["id"])
        if is_blank(entry.get("value")):
            report.blank.append(f"{label_of(entry)}: {reasons.get(entry['id'], 'no reason given')}")
            continue
        todo.append(entry)
    return todo


# ---------------------------------------------------------------- text measure


def text_width(text, size, font="Helvetica"):
    try:
        return pdfmetrics.stringWidth(text, font, size)
    except (KeyError, UnicodeEncodeError):
        return len(text) * size * 0.55


def wrap(text, width, size, font="Helvetica"):
    lines = []
    for paragraph in str(text).split("\n"):
        line = ""
        for word in paragraph.split(" "):
            trial = f"{line} {word}" if line else word
            if line and text_width(trial, size, font) > width:
                lines.append(line)
                line = word
            else:
                line = trial
        lines.append(line)
    return lines


def pdf_overflow(field, value):
    """Why a value will not fit its AcroForm text box, or None."""
    if field["type"] != "text":
        return None
    value = str(value)
    if field.get("max_len") and len(value) > field["max_len"]:
        return f"{len(value)} characters, the field allows {field['max_len']}"
    x0, y0, x1, y1 = field["rect"]
    width, height = x1 - x0 - 4, y1 - y0 - 2
    sizes = [field["font_size"]] if field.get("font_size") else [12, 10, 8, 6]
    for size in sizes:
        if field.get("multiline"):
            if len(wrap(value, width, size)) * size * 1.15 <= height:
                return None
        elif "\n" not in value and text_width(value, size) <= width:
            return None
    return f"text needs more room than the {round(width)}x{round(height)} pt box"


# ---------------------------------------------------------------- Word


def insert_ordered(parent, child, order):
    """Places `child` where the schema expects it; Word and the validator reject any other order."""
    name = child.tag.split("}")[1]
    existing = parent.find(child.tag)
    if existing is not None:
        parent.replace(existing, child)
        return child
    later = set(order[order.index(name) + 1:])
    for sibling in parent:
        if sibling.tag.split("}")[-1] in later:
            sibling.addprevious(child)
            return child
    parent.append(child)
    return child


def bangla_fonts(r, font):
    """Bangla is drawn from the complex-script slot; set it, its size and its language."""
    r_pr = r.find(qn("w:rPr"))
    if r_pr is None:
        r_pr = OxmlElement("w:rPr")
        r.insert(0, r_pr)
    fonts = r_pr.find(qn("w:rFonts"))
    if fonts is None:
        fonts = insert_ordered(r_pr, OxmlElement("w:rFonts"), R_PR_ORDER)
    fonts.set(qn("w:cs"), font)
    size = r_pr.find(qn("w:sz"))
    if size is not None:
        size_cs = OxmlElement("w:szCs")
        size_cs.set(qn("w:val"), size.get(qn("w:val")))
        insert_ordered(r_pr, size_cs, R_PR_ORDER)
    lang = r_pr.find(qn("w:lang"))
    if lang is None:
        lang = insert_ordered(r_pr, OxmlElement("w:lang"), R_PR_ORDER)
    lang.set(qn("w:bidi"), "bn-BD")


def run_properties(source):
    """A copy of run formatting, keeping only elements a run's rPr may hold."""
    if source is None:
        return None
    r_pr = OxmlElement("w:rPr")
    for child in source:
        if child.tag.split("}")[-1] in R_PR_ORDER:
            r_pr.append(copy.deepcopy(child))
    return r_pr


def strip_placeholder_style(r):
    style = r.find(f"{qn('w:rPr')}/{qn('w:rStyle')}")
    if style is not None and "placeholder" in (style.get(qn("w:val")) or "").lower():
        style.getparent().remove(style)


def new_run(paragraph, text, r_pr, font):
    r = OxmlElement("w:r")
    if r_pr is not None:
        r.append(r_pr)
    paragraph.append(r)
    Run(r, None).text = text
    if BANGLA.search(text):
        bangla_fonts(r, font)
    return r


def write_cell(cell, text, font):
    tc = cell._tc
    paragraphs = tc.findall(qn("w:p"))
    first = paragraphs[0]
    sample = next((r.find(qn("w:rPr")) for r in tc.iter(qn("w:r")) if r.find(qn("w:rPr")) is not None), None)
    if sample is None:
        sample = first.find(f"{qn('w:pPr')}/{qn('w:rPr')}")
    r_pr = run_properties(sample)
    for paragraph in paragraphs[1:]:
        tc.remove(paragraph)
    for child in list(first):
        if child.tag != qn("w:pPr"):
            first.remove(child)
    new_run(first, text, r_pr, font)


def write_span(paragraph, span, text, font):
    start, end = span
    position, first = 0, None
    for node in text_nodes(paragraph):
        content = node.text or ""
        low, high = position, position + len(content)
        position = high
        if high <= start or low >= end:
            continue
        cut_from, cut_to = max(start, low) - low, min(end, high) - low
        node.text = content[:cut_from] + (text if first is None else "") + content[cut_to:]
        node.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
        first = first if first is not None else node
    if first is not None and BANGLA.search(text):
        bangla_fonts(first.getparent(), font)


def write_sdt(sdt, field, value, font, report):
    pr, content = sdt.find(qn("w:sdtPr")), sdt.find(qn("w:sdtContent"))
    placeholder = pr.find(qn("w:showingPlcHdr"))
    if placeholder is not None:
        pr.remove(placeholder)
    if field["type"] == "checkbox":
        checked = truthy(value)
        box = pr.find(f"{W14}checkbox")
        state = box.find(f"{W14}checked")
        if state is None:
            state = OxmlElement("w14:checked")
            box.insert(0, state)
        state.set(f"{W14}val", "1" if checked else "0")
        symbol = box.find(f"{W14}{'checkedState' if checked else 'uncheckedState'}")
        code = symbol.get(f"{W14}val") if symbol is not None else ("2612" if checked else "2610")
        value = chr(int(code, 16))
    elif field["type"] == "choice":
        options = field.get("options", [])
        match = next((o for o in options if str(value).strip().lower() in
                      (str(o["value"]).lower(), str(o["text"]).lower())), None)
        if match is None and pr.find(qn("w:comboBox")) is None:
            report.problems.append(f"{field['id']}: {value!r} is not one of {[o['text'] for o in options]}")
            return False
        value = match["text"] if match else value
    runs = [r for r in content.iter(qn("w:r"))]
    text = str(value)
    if not runs:
        holder = next(content.iter(qn("w:p")), content)
        new_run(holder, text, None, font)
        return True
    first = runs[0]
    for r in runs[1:]:
        r.getparent().remove(r)
    holder = first.getparent()
    for paragraph in [p for p in content.findall(qn("w:p")) if p is not holder]:
        content.remove(paragraph)
    strip_placeholder_style(first)
    Run(first, None).text = text
    if BANGLA.search(text):
        bangla_fonts(first, font)
    return True


def fill_docx(form, mapping, out, report):
    from fields import docx_fields

    doc = Document(str(form))
    sdts = all_sdts(doc)
    known = {f["id"]: f for f in docx_fields(form)["fields"]}
    font = mapping.get("bangla_font", "Nikosh")
    resolved = []
    for entry in split_entries(mapping, report):
        if entry["id"] not in known:
            report.unknown.append(entry["id"])
            continue
        resolved.append((entry, docx_target(doc, entry["id"], sdts)))
    resolved.sort(key=lambda pair: -pair[1].span[0] if pair[1].span else 1)
    for entry, target in resolved:
        value = entry["value"]
        if target.kind == "cell":
            write_cell(target.element, str(value), font)
        elif target.kind == "sdt":
            if not write_sdt(target.element, known[entry["id"]], value, font, report):
                continue
        elif target.kind == "box":
            write_span(target.element, target.span, "☒" if truthy(value) else "☐", font)
        else:
            text = re.sub(r"\s*\n\s*", " ", str(value))
            write_span(target.element, target.span, text, font)
            length = known[entry["id"]].get("length", 0)
            if len(text) > max(2 * length, length + 25):
                report.notes.append(f"{label_of(entry)}: much longer than its blank; the line will wrap")
        report.filled.append(label_of(entry))
    doc.save(str(out))


# ---------------------------------------------------------------- fillable PDF


def pdf_value(field, value):
    """The value pypdf must write, or raise ValueError with the allowed values."""
    kind = field["type"]
    if kind == "checkbox":
        return field["on"] if truthy(value) else "/Off"
    if kind == "radio":
        wanted = str(value).strip().lstrip("/").lower()
        for option in field["options"]:
            if option["value"].lstrip("/").lower() == wanted:
                return option["value"]
        raise ValueError(f"not one of {[o['value'] for o in field['options']]}")
    if kind == "choice":
        wanted = str(value).strip().lower()
        for option in field["options"]:
            if wanted in (option["value"].lower(), option["text"].lower()):
                return option["value"]
        if field["options"]:
            raise ValueError(f"not one of {[o['text'] for o in field['options']]}")
    return str(value)


def fill_pdf_form(form, mapping, out, report):
    reader = PdfReader(str(form))
    fields = {f["id"]: f for f in pdf_form_fields(form)["fields"]}
    pages = {name: sorted({page for page, _ in widgets}) for name, widgets in pdf_widgets(reader).items()}
    by_page = {}
    for entry in split_entries(mapping, report):
        field = fields.get(entry["id"])
        if field is None:
            report.unknown.append(entry["id"])
            continue
        try:
            value = pdf_value(field, entry["value"])
        except ValueError as error:
            report.problems.append(f"{label_of(entry)}: {entry['value']!r} {error}")
            continue
        overflow = pdf_overflow(field, value)
        if overflow:
            report.problems.append(f"{label_of(entry)}: overflow risk, {overflow}")
        if field["type"] == "text" and BANGLA.search(value):
            report.notes.append(f"{label_of(entry)}: Bangla in a PDF field shows only where the viewer has a "
                                "Bangla font; check the render, use the overlay route if it shows boxes")
        for page in pages.get(entry["id"], [field["page"]]):
            by_page.setdefault(page, {})[entry["id"]] = value
        report.filled.append(label_of(entry))
    writer = PdfWriter(clone_from=reader)
    for page, values in by_page.items():
        writer.update_page_form_field_values(writer.pages[page - 1], values, auto_regenerate=False)
    writer.set_need_appearances_writer(True)
    with open(out, "wb") as handle:
        writer.write(handle)


# ---------------------------------------------------------------- flat PDF overlay


def find_font(name, fallbacks):
    if name and Path(name).suffix.lower() in (".ttf", ".otf") and Path(name).exists():
        return name
    if name and shutil.which("fc-match"):
        found = subprocess.run(["fc-match", "-f", "%{file}\n%{family}", name], capture_output=True, text=True,
                               check=False)
        path, _, family = found.stdout.partition("\n")
        if name.lower() in family.lower() and path.lower().endswith((".ttf", ".otf")) and Path(path).exists():
            return path
    return next((path for path in fallbacks if Path(path).exists()), None)


def overlay_font(text, mapping, report, registered):
    if BANGLA.search(text):
        key, wanted, fallbacks = "FormBangla", mapping.get("bangla_font", "Nikosh"), BANGLA_FONTS
    else:
        try:
            text.encode("cp1252")
            return "Helvetica"
        except UnicodeEncodeError:
            key, wanted, fallbacks = "FormUnicode", "DejaVu Sans", UNICODE_FONTS
    if key not in registered:
        path = find_font(wanted, fallbacks)
        registered[key] = path
        if path:
            pdfmetrics.registerFont(ttfonts.TTFont(key, path))
            if key == "FormBangla" and ttfonts.uharfbuzz is None:
                report.notes.append("uharfbuzz is missing: Bangla conjuncts are drawn unshaped; check the render")
    return key if registered[key] else None


def overlay_entry(entry, mapping, page_box):
    """Page number and position in PDF points from a mapping entry (points, or pixels at mapping dpi)."""
    left, bottom, _, top = page_box
    x, y = float(entry["x"]), float(entry["y"])
    width, height = entry.get("width"), entry.get("height")
    if mapping.get("units") == "px":
        scale = 72.0 / float(mapping.get("dpi", 100))
        x, y = x * scale, (top - bottom) - y * scale
        width = width * scale if width else None
        height = height * scale if height else None
    return left + x, bottom + y, width and float(width), height and float(height)


def overlay_lines(entry, mapping, page_box, font):
    size = float(entry.get("size", 10))
    x, y, width, height = overlay_entry(entry, mapping, page_box)
    lines = wrap(entry["value"], width, size, font) if width else str(entry["value"]).split("\n")
    return x, y, size, width, height, lines


def overlay_overflow(lines, size, x, width, height, page_box):
    if height and len(lines) * size * 1.2 > height + size * 0.3:
        return f"{len(lines)} lines need {round(len(lines) * size * 1.2)} pt, the space is {round(height)} pt"
    if width and len(lines) == 1:
        return None
    longest = max((text_width(line, size) for line in lines), default=0)
    if x + longest > page_box[2] - 5:
        return "runs off the right edge of the page"
    return None


def fill_overlay(form, mapping, out, report):
    reader = PdfReader(str(form))
    writer = PdfWriter(clone_from=reader)
    registered, by_page = {}, {}
    for entry in split_entries(mapping, report):
        missing = [key for key in ("page", "x", "y") if key not in entry]
        if missing or not 1 <= int(entry.get("page", 0)) <= len(reader.pages):
            report.problems.append(f"{label_of(entry)}: overlay entries need a valid page, x and y")
            continue
        by_page.setdefault(int(entry["page"]), []).append(entry)
    for number, entries in sorted(by_page.items()):
        page = writer.pages[number - 1]
        box = [float(v) for v in page.mediabox]
        if int(page.get("/Rotate", 0)) % 360:
            report.notes.append(f"page {number} is rotated; check placement on the render")
        sheet = io.BytesIO()
        drawing = canvas.Canvas(sheet, pagesize=(box[2], box[3]))
        for entry in entries:
            if entry.get("type") == "check" or isinstance(entry["value"], bool):
                if truthy(entry["value"]):
                    x, y, _, _ = overlay_entry(entry, mapping, box)
                    drawing.setFont("ZapfDingbats", float(entry.get("size", 10)))
                    drawing.drawString(x, y, "4")
                report.filled.append(label_of(entry))
                continue
            font = overlay_font(str(entry["value"]), mapping, report, registered)
            if font is None:
                report.problems.append(f"{label_of(entry)}: no font for this script was found")
                continue
            x, y, size, width, height, lines = overlay_lines(entry, mapping, box, font)
            overflow = overlay_overflow(lines, size, x, width, height, box)
            if overflow:
                report.problems.append(f"{label_of(entry)}: overflow risk, {overflow}")
            drawing.setFont(font, size)
            for i, line in enumerate(lines):
                drawing.drawString(x, y - i * size * 1.2, line, shaping=font != "Helvetica")
            report.filled.append(label_of(entry))
        drawing.save()
        sheet.seek(0)
        page.merge_page(PdfReader(sheet).pages[0])
    with open(out, "wb") as handle:
        writer.write(handle)


def fill(form, mapping, out):
    report = Report()
    kind = form_kind(form)
    {"docx": fill_docx, "pdf_form": fill_pdf_form, "pdf_flat": fill_overlay}[kind](form, mapping, out, report)
    return kind, report


def main(argv):
    if len(argv) != 3:
        print("usage: fill.py FORM.pdf|FORM.docx MAPPING.json OUT")
        return 1
    form, mapping_path, out = argv
    if Path(form).resolve() == Path(out).resolve():
        print("error: write the filled form to a new file, not over the original")
        return 1
    try:
        mapping = load_mapping(mapping_path)
        kind, report = fill(form, mapping, out)
    except (OSError, ValueError, KeyError) as error:
        print(f"error: {error}")
        return 1
    print(f"{kind}: wrote {Path(out).name}")
    print("\n".join(report.lines()))
    return report.code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
