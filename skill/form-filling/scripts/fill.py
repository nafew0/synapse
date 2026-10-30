"""Fill a PDF or Word form from a mapping JSON (see references/mapping.md).

Usage: python fill.py FORM.pdf|FORM.docx MAPPING.json OUT

Fillable PDFs get their AcroForm fields set; flat or scanned PDFs get the text drawn on top at the
mapping's page/x/y; Word forms get the value written into the cell, content control, underscore
blank or tick box, in that place's own formatting, with Bangla in the complex-script font slot.
A field that already holds a value is replaced in place. On a flat or scanned PDF a "replace" entry
covers the old value and draws the new one; the old text stays underneath unless "flatten_replaced"
rasterises the page.

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
    docx_fields,
    docx_target,
    form_kind,
    is_filler,
    page_lines,
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
MIN_REPLACE_SIZE = 6.0
WORD_GAP = 6.0
RULE_REACH = 6.0
PAGE_MARGIN = 36.0
FLATTEN_DPI = 200
HEX_COLOR = re.compile(r"#[0-9a-fA-F]{6}")
SERIF_FONTS = ("times", "serif", "georgia", "garamond", "cambria", "palatino", "minion", "book")
MONO_FONTS = ("courier", "mono", "consolas", "typewriter")
STANDARD_FONTS = {
    "Times": ("Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic"),
    "Courier": ("Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique"),
    "Helvetica": ("Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique"),
}


class Report:
    def __init__(self):
        self.filled, self.blank, self.unknown, self.problems, self.notes = [], [], [], [], []
        self.changes = []

    def lines(self):
        out = [(f"filled {len(self.filled)}, blank {len(self.blank)}, unknown ids {len(self.unknown)}, "
                f"problems {len(self.problems)}")]
        out += [f"  changed: {change}" for change in self.changes]
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


def shown(value):
    """A value as the reply and reports show it."""
    if value is True or value == "/Yes":
        return "ticked"
    if value is False or value == "/Off":
        return "not ticked"
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    if not text:
        return "(blank)"
    return text.lstrip("/") if text.startswith("/") else text


def change_line(entry, old, new, label=""):
    return f"{entry.get('label') or label or entry['id']}: {shown(old)} → {shown(new)}"


def inline_text(value):
    return re.sub(r"\s*\n\s*", " ", str(value))


def box_glyph(value):
    return "☒" if truthy(value) else "☐"


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


def cell_format(cell, first):
    """A filled cell keeps its first text run's formatting; an empty one takes any run's, then the paragraph mark's."""
    tc = cell._tc
    if not is_filler(cell.text):
        texts = (r for r in tc.iter(qn("w:r")) if "".join(t.text or "" for t in r.iter(qn("w:t"))).strip())
        return next(texts).find(qn("w:rPr"))
    sample = next((r.find(qn("w:rPr")) for r in tc.iter(qn("w:r")) if r.find(qn("w:rPr")) is not None), None)
    return sample if sample is not None else first.find(f"{qn('w:pPr')}/{qn('w:rPr')}")


def write_cell(cell, text, font):
    tc = cell._tc
    paragraphs = tc.findall(qn("w:p"))
    first = paragraphs[0]
    r_pr = run_properties(cell_format(cell, first))
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
    doc = Document(str(form))
    sdts = all_sdts(doc)
    known = {f["id"]: f for f in docx_fields(form, include_filled=True)["fields"]}
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
            write_span(target.element, target.span, box_glyph(value), font)
        else:
            text = inline_text(value)
            write_span(target.element, target.span, text, font)
            length = known[entry["id"]].get("length", 0)
            if target.kind == "blank" and len(text) > max(2 * length, length + 25):
                report.notes.append(f"{label_of(entry)}: much longer than its blank; the line will wrap")
        report.filled.append(label_of(entry))
        report.changes.append(change_line(entry, known[entry["id"]].get("value"), value, known[entry["id"]]["label"]))
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
        report.changes.append(change_line(entry, field.get("value"), value, field["label"]))
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


def standard_font(fontname):
    """The standard PDF font closest to an embedded one, keeping family, weight and slant."""
    name = fontname.split("+")[-1].lower()
    family = ("Times" if any(word in name for word in SERIF_FONTS)
              else "Courier" if any(word in name for word in MONO_FONTS) else "Helvetica")
    bold, italic = "bold" in name or "black" in name, "italic" in name or "oblique" in name
    return STANDARD_FONTS[family][bold + 2 * italic]


def find_matches(page, wanted):
    pattern = re.compile(r"(?<!\w)" + r"\s+".join(re.escape(word) for word in wanted.split()) + r"(?!\w)")
    return [[slot for slot in slots[match.start():match.end()] if slot]
            for text, slots in page_lines(page) for match in pattern.finditer(text)]


def pick_match(matches, spec, entry):
    wanted, occurrence = spec["find"], spec.get("occurrence", entry.get("occurrence"))
    if not matches:
        raise ValueError(f"{wanted!r} not found on page {spec['page']}; for a scan or an unreadable text layer "
                         "give a box instead")
    if occurrence is None:
        if len(matches) > 1:
            raise ValueError(f"{wanted!r} matches {len(matches)} times on page {spec['page']}; give \"occurrence\": n")
        return matches[0]
    if not 1 <= int(occurrence) <= len(matches):
        raise ValueError(f"occurrence {occurrence} of {wanted!r}: page {spec['page']} has {len(matches)}")
    return matches[int(occurrence) - 1]


def find_target(page, raw_box, spec, entry):
    """pdfplumber's x and height - bottom are raw page coordinates; the text matrix is relative to the media box."""
    if page.rotation % 360:
        raise ValueError(f"page {spec['page']} is rotated; give a box instead of find")
    chars = pick_match(find_matches(page, spec["find"]), spec, entry)
    left, top = min(c["x0"] for c in chars), min(c["top"] for c in chars)
    right, bottom = max(c["x1"] for c in chars), max(c["bottom"] for c in chars)
    return {"x": left, "y": float(page.height) - bottom, "width": right - left, "height": bottom - top,
            "baseline": raw_box[1] + chars[0]["matrix"][5], "size": chars[0]["size"], "fontname": chars[0]["fontname"],
            "old": spec["find"], "room": free_room(page, chars, left, right, top, bottom)}


def thin_rules(page):
    """Horizontal rules, whether drawn as lines or as very thin rectangles."""
    return [r for r in [*page.lines, *page.rects] if r["bottom"] - r["top"] <= 2 and r["x1"] - r["x0"] >= 10]


def free_room(page, chars, left, right, top, bottom):
    """Width a new value may use: up to the next printed word, else the end of the rule, else the page margin."""
    following = [c["x0"] for c in page.chars if c["text"].strip() and c["x0"] >= right - 0.5
                 and c["top"] < bottom and c["bottom"] > top and c not in chars]
    if following:
        return max(right - left, min(following) - left - WORD_GAP)
    rules = [r["x1"] for r in thin_rules(page) if r["x0"] <= left + 1 and r["x1"] >= right
             and top < r["top"] <= bottom + RULE_REACH]
    limit = max(rules) if rules else float(page.width) - PAGE_MARGIN
    return max(right - left, limit - left)


def box_target(page, raw_box, spec, entry, mapping):
    numbers = spec["box"]
    if not (isinstance(numbers, list) and len(numbers) == 4) or float(numbers[2]) <= 0 or float(numbers[3]) <= 0:
        raise ValueError("box must be [x, y, width, height] with a positive width and height")
    x, y, width, height = (float(number) for number in numbers)
    if spec.get("units", mapping.get("units")) == "px":
        scale = 72.0 / float(spec.get("dpi", mapping.get("dpi", 100)))
        x, y, width, height = x * scale, (raw_box[3] - raw_box[1]) - (y + height) * scale, width * scale, height * scale
    x, y = x + raw_box[0], y + raw_box[1]
    if x < raw_box[0] or y < raw_box[1] or x + width > raw_box[2] or y + height > raw_box[3]:
        raise ValueError(f"box {[round(n) for n in (x, y, width, height)]} is off the page")
    target = {"x": x, "y": y, "width": width, "height": height, "baseline": None, "size": height * 0.7, "fontname": ""}
    return {**target, "old": entry.get("old") or text_in_box(page, target) or "(covered box)"}


def text_in_box(page, target):
    left, top, right, bottom = top_rect(target, page)
    inside = [c for _, slots in page_lines(page) for c in slots
              if c and left <= (c["x0"] + c["x1"]) / 2 <= right and top <= (c["top"] + c["bottom"]) / 2 <= bottom]
    return "".join(c["text"] for c in inside)


def top_rect(target, page):
    """A target's rectangle in pdfplumber's top-left coordinates."""
    top = float(page.height) - target["y"] - target["height"]
    return target["x"], top, target["x"] + target["width"], top + target["height"]


def cover_color(spec, entry):
    color = spec.get("cover", entry.get("cover", "#ffffff"))
    if not HEX_COLOR.fullmatch(str(color)):
        raise ValueError(f"cover must look like #rrggbb, not {color!r}")
    return tuple(int(color[i:i + 2], 16) / 255 for i in (1, 3, 5))


def replace_plan(entry, mapping, pdf, raw_boxes, report, registered):
    """Where and how a replace entry draws, from the original form; ValueError says why it cannot."""
    spec = entry["replace"]
    if not isinstance(spec, dict) or not 1 <= int(spec.get("page", 0)) <= len(pdf.pages):
        raise ValueError("replace needs a valid page")
    if ("find" in spec) == ("box" in spec):
        raise ValueError('replace needs either "find" or "box"')
    number = int(spec["page"])
    page, raw_box = pdf.pages[number - 1], raw_boxes[number - 1]
    target = find_target(page, raw_box, spec, entry) if "find" in spec else box_target(page, raw_box, spec, entry, mapping)
    value = inline_text(entry["value"])
    font = overlay_font(value, mapping, report, registered)
    if font is None:
        raise ValueError("no font for this script was found")
    font = standard_font(target["fontname"]) if font == "Helvetica" and target["fontname"] else font
    wanted = float(entry.get("size") or target["size"])
    needed = text_width(value, wanted, font)
    room = target.get("room", target["width"])
    size = wanted * room / needed if needed > room else wanted
    baseline = target["baseline"]
    if baseline is None:
        baseline = target["y"] + (target["height"] - size) / 2 + size * 0.22
    return {**target, "page": number, "value": value, "font": font, "size": size, "baseline": baseline,
            "rules": rules_under_cover(page, target),
            "fits": size >= MIN_REPLACE_SIZE or size == wanted, "color": cover_color(spec, entry),
            "covered_only": "cover" not in spec and "cover" not in entry}


def rules_under_cover(page, target):
    """Rule segments a cover paints over, to draw back on top of it."""
    left, top, right, bottom = top_rect(target, page)
    return [(max(r["x0"], left), min(r["x1"], right), float(page.height) - (r["top"] + r["bottom"]) / 2,
             max(r.get("linewidth") or 0, r["bottom"] - r["top"], 0.5))
            for r in thin_rules(page) if top - 1.5 <= r["top"] <= bottom + 1.5 and r["x0"] < right and r["x1"] > left]


def cover_notes(page, plan):
    """What a cover may hide besides the value: a rule through the box, or a shaded background."""
    left, top, right, bottom = top_rect(plan, page)
    notes = []
    shaded = [r for r in page.rects if r.get("fill") and r["top"] <= top and r["bottom"] >= bottom
              and r["x0"] <= left and r["x1"] >= right and not is_white(r.get("non_stroking_color"))]
    if shaded and plan["covered_only"]:
        notes.append('the box sits on a shaded background; set "cover" to its colour')
    return notes


def is_white(color):
    values = color if isinstance(color, (list, tuple)) else [color]
    return color is None or (len(values) in (1, 3) and all(v == 1 for v in values))


def require_flatten_tools():
    missing = [tool for tool in ("pdftoppm", "pdfinfo") if not shutil.which(tool)]
    if missing:
        raise ValueError(f"flatten_replaced needs {' and '.join(missing)} (poppler), which is not installed; "
                         "no file was written, because keeping the old text silently is not acceptable")


def flatten_pages(out, numbers):
    """Rebuild the file so the replaced pages are images and their old content objects are not carried over."""
    from pdf2image import convert_from_path

    reader = PdfReader(str(out))
    writer = PdfWriter()
    for number, page in enumerate(reader.pages, start=1):
        if number not in numbers:
            writer.add_page(page)
            continue
        image = convert_from_path(str(out), dpi=FLATTEN_DPI, first_page=number, last_page=number)[0]
        sheet = io.BytesIO()
        image.convert("RGB").save(sheet, "PDF", resolution=FLATTEN_DPI)
        sheet.seek(0)
        writer.add_page(PdfReader(sheet).pages[0])
    flattened = io.BytesIO()
    writer.write(flattened)
    Path(out).write_bytes(flattened.getvalue())


def plan_replacements(entries, mapping, form, raw_boxes, report, registered):
    import pdfplumber

    plans = {}
    with pdfplumber.open(str(form)) as pdf:
        for entry in entries:
            try:
                plan = replace_plan(entry, mapping, pdf, raw_boxes, report, registered)
            except (ValueError, TypeError) as error:
                report.problems.append(f"{label_of(entry)}: {error}")
                continue
            if not plan["fits"]:
                report.problems.append(f"{label_of(entry)}: {plan['value']!r} does not fit its "
                                       f"{round(plan.get('room', plan['width']))} pt space even at {MIN_REPLACE_SIZE:g} pt; nothing was drawn")
                continue
            page = pdf.pages[plan["page"] - 1]
            report.notes += [f"{label_of(entry)}: {note}" for note in cover_notes(page, plan)]
            plans.setdefault(plan["page"], []).append((entry, plan))
    return plans


def draw_replacement(drawing, plan):
    drawing.setFont(plan["font"], plan["size"])
    drawing.setFillColorRGB(0, 0, 0)
    drawing.drawString(plan["x"], plan["baseline"], plan["value"], shaping=plan["font"].startswith("Form"))


def draw_cover(drawing, plan):
    drawing.setFillColorRGB(*plan["color"])
    drawing.rect(plan["x"], plan["y"], plan["width"], plan["height"], stroke=0, fill=1)
    drawing.setStrokeColorRGB(0, 0, 0)
    for start, end, y, width in plan.get("rules", []):
        drawing.setLineWidth(width)
        drawing.line(start, y, end, y)


def draw_overlay_entry(drawing, entry, mapping, box, report, registered):
    if entry.get("type") == "check" or isinstance(entry["value"], bool):
        if truthy(entry["value"]):
            x, y, _, _ = overlay_entry(entry, mapping, box)
            drawing.setFont("ZapfDingbats", float(entry.get("size", 10)))
            drawing.drawString(x, y, "4")
        report.filled.append(label_of(entry))
        return
    font = overlay_font(str(entry["value"]), mapping, report, registered)
    if font is None:
        report.problems.append(f"{label_of(entry)}: no font for this script was found")
        return
    x, y, size, width, height, lines = overlay_lines(entry, mapping, box, font)
    overflow = overlay_overflow(lines, size, x, width, height, box)
    if overflow:
        report.problems.append(f"{label_of(entry)}: overflow risk, {overflow}")
    drawing.setFont(font, size)
    for i, line in enumerate(lines):
        drawing.drawString(x, y - i * size * 1.2, line, shaping=font != "Helvetica")
    report.filled.append(label_of(entry))


def report_replacement(entry, plan, flatten, report):
    report.filled.append(label_of(entry))
    report.changes.append(change_line(entry, plan["old"], plan["value"]))
    if flatten:
        return
    report.notes.append(f"{label_of(entry)}: the old value {plan['old']!r} is covered, not removed: it stays in the "
                        "PDF's text layer and can be copied or found by search. Set flatten_replaced to remove it.")


def fill_overlay(form, mapping, out, report):
    reader = PdfReader(str(form))
    writer = PdfWriter(clone_from=reader)
    registered, by_page, replacing = {}, {}, []
    for entry in split_entries(mapping, report):
        if "replace" in entry:
            replacing.append(entry)
            continue
        missing = [key for key in ("page", "x", "y") if key not in entry]
        if missing or not 1 <= int(entry.get("page", 0)) <= len(reader.pages):
            report.problems.append(f"{label_of(entry)}: overlay entries need a valid page, x and y")
            continue
        by_page.setdefault(int(entry["page"]), []).append(entry)
    flatten = bool(mapping.get("flatten_replaced")) and bool(replacing)
    if flatten:
        require_flatten_tools()
    raw_boxes = [[float(v) for v in page.mediabox] for page in reader.pages]
    plans = plan_replacements(replacing, mapping, form, raw_boxes, report, registered)
    for number in sorted({*by_page, *plans}):
        page = writer.pages[number - 1]
        box = [float(v) for v in page.mediabox]
        if int(page.get("/Rotate", 0)) % 360:
            report.notes.append(f"page {number} is rotated; check placement on the render")
        sheet = io.BytesIO()
        drawing = canvas.Canvas(sheet, pagesize=(box[2], box[3]))
        for _, plan in plans.get(number, []):
            draw_cover(drawing, plan)
        for entry, plan in plans.get(number, []):
            draw_replacement(drawing, plan)
            report_replacement(entry, plan, flatten, report)
        for entry in by_page.get(number, []):
            draw_overlay_entry(drawing, entry, mapping, box, report, registered)
        drawing.save()
        sheet.seek(0)
        page.merge_page(PdfReader(sheet).pages[0])
    with open(out, "wb") as handle:
        writer.write(handle)
    if flatten and plans:
        flatten_pages(out, set(plans))
        report.notes += [f"page {number}: rasterised at {FLATTEN_DPI} dpi, so the old text is gone, and so is this "
                         "page's text layer" for number in sorted(plans)]


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
