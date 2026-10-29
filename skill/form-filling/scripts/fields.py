"""List the fields of a PDF or Word form as JSON with a stable id per field.

Usage: python fields.py FORM.pdf|FORM.docx [--out fields.json]

Exit codes: 0 fields found, 2 no fillable fields (flat PDF: candidate blanks are listed for the
overlay route), 1 bad arguments or unreadable file.
"""
import argparse
import json
import re
import sys
from pathlib import Path

from docx import Document
from docx.oxml.ns import qn
from pypdf import PdfReader
from pypdf.generic import StreamObject

W14 = "{http://schemas.microsoft.com/office/word/2010/wordml}"
MARK = re.compile(r"(?P<blank>_{3,}|(?:[.…] ?){3,}[.…]|…{2,})|(?P<box>[☐☒☑□])")
CHECKED_BOXES = "☒☑"
FILLER = re.compile(r"[\s_.…:：\-–—]*")
SERIAL = re.compile(r"\(?([0-9০-৯]{1,3}|[a-zA-Z]|[ivxIVX]{1,4})[.)]?\)?")
INDEX = re.compile(r"([a-z]+)(\d+)")
BANGLA = re.compile(r"[ঀ-৿]")
SKIP_ANCESTORS = {qn("w:sdt"), qn("w:txbxContent"), qn("w:del")}
PDF_RADIO, PDF_PUSH, PDF_MULTILINE, PDF_REQUIRED = 1 << 15, 1 << 16, 1 << 12, 1 << 1


def clean_label(text, keep="tail", limit=70):
    text = re.sub(r"\s+", " ", text).strip(" \t:：-–—|,;(")
    text = text.rstrip(")") if text.count("(") < text.count(")") else text
    if len(text) <= limit:
        return text
    return text[-limit:].lstrip() if keep == "tail" else text[:limit].rstrip()


def is_filler(text):
    return FILLER.fullmatch(text or "") is not None


def is_serial(text):
    return SERIAL.fullmatch(text.strip()) is not None


def form_kind(path):
    suffix = Path(path).suffix.lower()
    if suffix == ".docx":
        return "docx"
    if suffix != ".pdf":
        raise ValueError(f"unsupported form type {suffix or '(none)'}: give a .pdf or .docx")
    reader = PdfReader(str(path))
    return "pdf_form" if pdf_widgets(reader) else "pdf_flat"


# ---------------------------------------------------------------- Word


def text_nodes(p_el):
    """The paragraph's own w:t nodes, skipping content controls, text boxes and deletions."""
    nodes = []
    for t in p_el.iter(qn("w:t")):
        between = []
        for ancestor in t.iterancestors():
            if ancestor is p_el:
                break
            between.append(ancestor.tag)
        if not SKIP_ANCESTORS.intersection(between):
            nodes.append(t)
    return nodes


def paragraph_text(p_el):
    return "".join(t.text or "" for t in text_nodes(p_el))


def marks(text):
    found = []
    for match in MARK.finditer(text):
        kind = "blank" if match.group("blank") else "box"
        found.append((kind, match.start(), match.end()))
    return found


def mark_label(text, found, index):
    kind, start, end = found[index]
    before_from = found[index - 1][2] if index else 0
    after_to = found[index + 1][1] if index + 1 < len(found) else len(text)
    before = clean_label(text[before_from:start])
    after = clean_label(text[end:after_to], keep="head")
    if kind == "box":
        return after or before
    return before or after


def paragraph_fields(p_el, prefix):
    text = paragraph_text(p_el)
    found = marks(text)
    counters = {"blank": 0, "box": 0}
    fields = []
    for index, (kind, start, end) in enumerate(found):
        number = counters[kind]
        counters[kind] += 1
        label = mark_label(text, found, index)
        if kind == "blank":
            fields.append({"id": f"{prefix}.b{number}", "kind": "blank", "type": "text", "label": label,
                           "value": "", "length": end - start})
        else:
            fields.append({"id": f"{prefix}.x{number}", "kind": "box", "type": "checkbox", "label": label,
                           "value": text[start] in CHECKED_BOXES})
    return fields


def unique_cells(row):
    seen, cells = set(), []
    for cell in row.cells:
        if id(cell._tc) in seen:
            continue
        seen.add(id(cell._tc))
        cells.append(cell)
    return cells


def cell_width_pt(cell):
    width = cell._tc.find(f"{qn('w:tcPr')}/{qn('w:tcW')}")
    if width is None or width.get(qn("w:type")) not in (None, "dxa"):
        return None
    try:
        return round(int(width.get(qn("w:w"))) / 20, 1)
    except (TypeError, ValueError):
        return None


def has_sdt(cell):
    return next(cell._tc.iter(qn("w:sdt")), None) is not None


def cell_label(cells, header, row_index, column):
    left = cells[column - 1].text.strip() if column else ""
    if left == ":" or left == "：":
        left = cells[column - 2].text.strip() if column > 1 else ""
    if left and not is_filler(left) and not is_serial(left):
        return clean_label(left)
    top = header[column] if column < len(header) else ""
    if row_index and top and not is_filler(top):
        return f"{clean_label(top)} (row {row_index})"
    return ""


def table_fields(table, prefix):
    rows = [unique_cells(row) for row in table.rows]
    header = [cell.text.strip() for cell in rows[0]] if rows else []
    seen, fields = set(), []
    for r, cells in enumerate(rows):
        for c, cell in enumerate(cells):
            if id(cell._tc) in seen:
                continue
            seen.add(id(cell._tc))
            cell_id = f"{prefix}.r{r}.c{c}"
            if has_sdt(cell):
                continue
            if not is_filler(cell.text):
                for p, paragraph in enumerate(cell.paragraphs):
                    fields += paragraph_fields(paragraph._p, f"{cell_id}.p{p}")
                continue
            label = cell_label(cells, header, r, c)
            if not label:
                continue
            field = {"id": cell_id, "kind": "cell", "type": "text", "label": label, "value": ""}
            width = cell_width_pt(cell)
            if width:
                field["width_pt"] = width
            fields.append(field)
    return fields


def all_sdts(doc):
    return list(doc.element.body.iter(qn("w:sdt")))


def sdt_text(sdt):
    content = sdt.find(qn("w:sdtContent"))
    return "".join(t.text or "" for t in content.iter(qn("w:t"))) if content is not None else ""


def sdt_is_field(sdt):
    pr = sdt.find(qn("w:sdtPr"))
    content = sdt.find(qn("w:sdtContent"))
    if pr is None or content is None:
        return False
    if pr.find(qn("w:docPartObj")) is not None or pr.find(qn("w:docPartList")) is not None:
        return False
    return next(content.iter(qn("w:tbl")), None) is None and next(content.iter(qn("w:sdt")), None) is None


def sdt_context(sdt):
    paragraph = next((a for a in sdt.iterancestors() if a.tag == qn("w:p")), None)
    if paragraph is not None:
        own = set(text_nodes(paragraph))
        before = []
        for element in paragraph.iter():
            if element is sdt:
                break
            if element in own:
                before.append(element.text or "")
        label = clean_label("".join(before))
        if label:
            return label
    cell = next((a for a in sdt.iterancestors() if a.tag == qn("w:tc")), None)
    previous = (cell if cell is not None else sdt).getprevious()
    wanted = qn("w:tc") if cell is not None else qn("w:p")
    while previous is not None and previous.tag != wanted:
        previous = previous.getprevious()
    if previous is None:
        return ""
    return clean_label("".join(t.text or "" for t in previous.iter(qn("w:t"))))


def sdt_info(sdt, number):
    pr = sdt.find(qn("w:sdtPr"))
    alias = pr.find(qn("w:alias"))
    tag = pr.find(qn("w:tag"))
    label = next((e.get(qn("w:val")) for e in (alias, tag) if e is not None and e.get(qn("w:val"))), "")
    field = {"id": f"sdt{number}", "kind": "sdt", "type": "text", "label": label or sdt_context(sdt)}
    placeholder = pr.find(qn("w:showingPlcHdr")) is not None
    checkbox = pr.find(f"{W14}checkbox")
    choices = pr.find(qn("w:dropDownList"))
    choices = choices if choices is not None else pr.find(qn("w:comboBox"))
    if checkbox is not None:
        checked = checkbox.find(f"{W14}checked")
        field.update(type="checkbox", value=checked is not None and checked.get(f"{W14}val") in ("1", "true"))
        return field
    if choices is not None:
        field["type"] = "choice"
        field["options"] = [
            {"value": item.get(qn("w:value")), "text": item.get(qn("w:displayText")) or item.get(qn("w:value"))}
            for item in choices.iter(qn("w:listItem"))
        ]
    elif pr.find(qn("w:date")) is not None:
        field["type"] = "date"
    field["value"] = "" if placeholder else sdt_text(sdt)
    return field


def body_position(element, body):
    for ancestor in [element, *element.iterancestors()]:
        if ancestor.getparent() is body:
            return body.index(ancestor)
    return len(body)


def docx_fields(path):
    doc = Document(str(path))
    body = doc.element.body
    fields = []
    for i, paragraph in enumerate(doc.paragraphs):
        fields += [(body.index(paragraph._p), f) for f in paragraph_fields(paragraph._p, f"p{i}")]
    for i, table in enumerate(doc.tables):
        fields += [(body.index(table._tbl), f) for f in table_fields(table, f"t{i}")]
    for i, sdt in enumerate(all_sdts(doc)):
        if sdt_is_field(sdt):
            fields.append((body_position(sdt, body), sdt_info(sdt, i)))
    fields.sort(key=lambda pair: pair[0])
    return {"kind": "docx", "fields": [field for _, field in fields]}


class Target:
    """One field of a Word form, located again from its id so it can be read or written."""

    def __init__(self, kind, element, mark=None, span=None):
        self.kind = kind
        self.element = element
        self.mark = mark
        self.span = span


def docx_target(doc, field_id, sdts=None, spans=True):
    """Resolve an id; with spans=False a blank or box resolves to its paragraph only (for filled copies)."""
    tokens = [INDEX.fullmatch(token) for token in field_id.split(".")]
    if not all(tokens):
        raise KeyError(field_id)
    tokens = [(m.group(1), int(m.group(2))) for m in tokens]
    try:
        if tokens[0][0] == "sdt" and len(tokens) == 1:
            return Target("sdt", (sdts if sdts is not None else all_sdts(doc))[tokens[0][1]])
        container, paragraph, i = doc, None, 0
        while i < len(tokens):
            name, number = tokens[i]
            if name == "t" and paragraph is None:
                (row_name, row), (column_name, column) = tokens[i + 1], tokens[i + 2]
                if (row_name, column_name) != ("r", "c"):
                    raise KeyError(field_id)
                container = unique_cells(container.tables[number].rows[row])[column]
                i += 3
                continue
            if name == "p" and paragraph is None:
                paragraph = container.paragraphs[number]._p
            elif name in ("b", "x") and paragraph is not None and i == len(tokens) - 1:
                kind = "blank" if name == "b" else "box"
                if not spans:
                    return Target(kind, paragraph, mark=(kind, number))
                _, start, end = [m for m in marks(paragraph_text(paragraph)) if m[0] == kind][number]
                return Target(kind, paragraph, mark=(kind, number), span=(start, end))
            else:
                raise KeyError(field_id)
            i += 1
    except (IndexError, ValueError) as error:
        raise KeyError(field_id) from error
    if paragraph is None and container is not doc:
        return Target("cell", container)
    raise KeyError(field_id)


# ---------------------------------------------------------------- PDF


def inherited(node, key):
    while node is not None:
        if key in node:
            return node[key]
        node = node.get("/Parent")
        node = node.get_object() if node is not None else None
    return None


def qualified_name(annot):
    parts, node = [], annot
    while node is not None:
        if "/T" in node:
            parts.append(str(node["/T"]))
        node = node.get("/Parent")
        node = node.get_object() if node is not None else None
    return ".".join(reversed(parts))


def field_node(annot):
    if "/T" in annot:
        return annot
    parent = annot.get("/Parent")
    return parent.get_object() if parent is not None else annot


def pdf_widgets(reader):
    groups = {}
    for page_number, page in enumerate(reader.pages, start=1):
        for ref in page.get("/Annots") or []:
            annot = ref.get_object()
            if annot.get("/Subtype") != "/Widget":
                continue
            name = qualified_name(annot)
            if name:
                groups.setdefault(name, []).append((page_number, annot))
    return groups


def on_states(annot):
    appearance = annot.get("/AP")
    normal = appearance.get_object().get("/N") if appearance is not None else None
    normal = normal.get_object() if normal is not None else None
    if normal is None or isinstance(normal, StreamObject):
        return []
    return [str(key) for key in normal if key != "/Off"]


def font_size(annot, reader):
    appearance = inherited(annot, "/DA") or reader.trailer["/Root"].get("/AcroForm", {}).get("/DA") or ""
    match = re.search(r"(\d+(?:\.\d+)?)\s+Tf", str(appearance))
    return float(match.group(1)) if match else 0.0


def pdf_field(name, widgets, reader):
    page, annot = widgets[0]
    node = field_node(annot)
    kind = inherited(annot, "/FT")
    flags = int(inherited(annot, "/Ff") or 0)
    value = inherited(node, "/V")
    rect = [round(float(v), 1) for v in annot.get("/Rect", [0, 0, 0, 0])]
    field = {"id": name, "kind": "pdf", "page": page, "rect": rect, "label": str(inherited(node, "/TU") or ""),
             "required": bool(flags & PDF_REQUIRED)}
    if kind == "/Btn":
        if flags & PDF_PUSH:
            return None
        states = [(p, a, s) for p, a in widgets for s in on_states(a)]
        if flags & PDF_RADIO:
            field.update(type="radio", value=str(value or "/Off"),
                         options=[{"value": s, "page": p, "rect": [round(float(v), 1) for v in a["/Rect"]]}
                                  for p, a, s in states])
        else:
            field.update(type="checkbox", value=str(value or "/Off"), on=states[0][2] if states else "/Yes")
        return field
    if kind == "/Ch":
        options = []
        for item in inherited(node, "/Opt") or []:
            item = item.get_object() if hasattr(item, "get_object") else item
            pair = list(item) if isinstance(item, list) else [item, item]
            options.append({"value": str(pair[0]), "text": str(pair[1])})
        field.update(type="choice", value=str(value or ""), options=options)
        return field
    if kind == "/Tx":
        field.update(type="text", value=str(value or ""), multiline=bool(flags & PDF_MULTILINE),
                     font_size=font_size(annot, reader))
        max_len = inherited(node, "/MaxLen")
        if max_len is not None:
            field["max_len"] = int(max_len)
        return field
    return None


def nearby_label(words, rect, height):
    """Printed text just left of the box on its line, else the line just above it."""
    top, bottom = height - rect[3], height - rect[1]
    middle = (top + bottom) / 2
    left = [w for w in words if w["top"] <= middle <= w["bottom"] + 2 and w["x1"] <= rect[0] + 2]
    left = [w for w in left if rect[0] - w["x1"] < 220]
    if left:
        return clean_label(" ".join(w["text"] for w in left))
    above = [w for w in words if 0 <= top - w["bottom"] < 14 and w["x0"] < rect[2] and w["x1"] > rect[0] - 10]
    return clean_label(" ".join(w["text"] for w in above))


def pdf_form_fields(path):
    import pdfplumber

    reader = PdfReader(str(path))
    fields = [pdf_field(name, widgets, reader) for name, widgets in pdf_widgets(reader).items()]
    fields = sorted((f for f in fields if f), key=lambda f: (f["page"], -f["rect"][3], f["rect"][0]))
    with pdfplumber.open(str(path)) as pdf:
        words = {}
        for field in fields:
            if field["label"]:
                continue
            page = pdf.pages[field["page"] - 1]
            if field["page"] not in words:
                words[field["page"]] = page.extract_words()
            field["label"] = nearby_label(words[field["page"]], field["rect"], float(page.height))
    return {"kind": "pdf_form", "fields": fields}


def line_blanks(page, number):
    """Underscore or dotted runs and drawn rules on a flat page, as overlay positions."""
    height = float(page.height)
    words = page.extract_words(keep_blank_chars=False, use_text_flow=True)
    blanks = []
    for word in words:
        if not MARK.fullmatch(word["text"]) or MARK.fullmatch(word["text"]).group("box"):
            continue
        same_line = [w for w in words if abs(w["top"] - word["top"]) < 3 and w["x1"] <= word["x0"] + 1]
        label = clean_label(" ".join(w["text"] for w in same_line if not MARK.fullmatch(w["text"])))
        blanks.append({"page": number, "label": label, "x": round(word["x0"], 1),
                       "y": round(height - word["bottom"] + 2, 1), "width": round(word["x1"] - word["x0"], 1)})
    for line in page.lines:
        if abs(line["top"] - line["bottom"]) > 1 or line["x1"] - line["x0"] < 40:
            continue
        same_line = [w for w in words if abs(w["bottom"] - line["top"]) < 6 and w["x1"] <= line["x0"] + 2]
        label = clean_label(" ".join(w["text"] for w in same_line))
        blanks.append({"page": number, "label": label, "x": round(line["x0"], 1),
                       "y": round(height - line["top"] + 2, 1), "width": round(line["x1"] - line["x0"], 1)})
    return blanks


def pdf_flat_info(path):
    import pdfplumber

    with pdfplumber.open(str(path)) as pdf:
        pages = [{"page": i, "width": float(p.width), "height": float(p.height),
                  "text_chars": len(p.chars)} for i, p in enumerate(pdf.pages, start=1)]
        blanks = [blank for i, p in enumerate(pdf.pages, start=1) for blank in line_blanks(p, i)]
    for i, blank in enumerate(blanks):
        blank["id"] = f"p{blank['page']}.l{i}"
    scanned = all(page["text_chars"] < 20 for page in pages)
    form = PdfReader(str(path)).trailer["/Root"].get("/AcroForm")
    xfa = form is not None and "/XFA" in form.get_object()
    return {"kind": "pdf_flat", "fields": [], "scanned": scanned, "xfa": xfa, "pages": pages, "blanks": blanks}


def list_fields(path):
    kind = form_kind(path)
    if kind == "docx":
        return docx_fields(path)
    if kind == "pdf_form":
        return pdf_form_fields(path)
    return pdf_flat_info(path)


def summary_lines(info, limit=80):
    if info["kind"] == "pdf_flat":
        if info["xfa"]:
            return ["no fillable fields: this is a dynamic XFA form, which cannot be filled here"]
        lines = ["no fillable fields: this is a flat PDF" + (" (scanned image, no text layer)" if info["scanned"] else ""),
                 "use the overlay route: mapping entries with page, x, y (PDF points, origin bottom-left, y = baseline)"]
        lines.append(f"{len(info['blanks'])} candidate blanks (underscore runs and drawn lines) listed in the JSON")
        lines += [f"  {b['id']}  p{b['page']} x={b['x']} y={b['y']} w={b['width']}  {b['label']}"
                  for b in info["blanks"][:limit]]
        return lines
    fields = info["fields"]
    lines = [f"{len(fields)} fields ({info['kind']})"]
    for field in fields[:limit]:
        value = field.get("value")
        shown = "" if value in ("", None, False, "/Off") else f" = {value!r}"
        extra = f" options={[o.get('text', o['value']) for o in field['options']]}" if field.get("options") else ""
        lines.append(f"  {field['id']}  [{field['type']}] {field['label']}{shown}{extra}")
    if len(fields) > limit:
        lines.append(f"  ... {len(fields) - limit} more in the JSON")
    return lines


def main(argv):
    parser = argparse.ArgumentParser(description="List the fields of a PDF or Word form.")
    parser.add_argument("form")
    parser.add_argument("--out", help="write the full field list here as JSON")
    args = parser.parse_args(argv)
    try:
        info = list_fields(args.form)
    except Exception as error:
        print(f"error: cannot read {args.form}: {error}")
        return 1
    if args.out:
        Path(args.out).write_text(json.dumps(info, ensure_ascii=False, indent=2), encoding="utf-8")
    print("\n".join(summary_lines(info)))
    return 0 if info["fields"] else 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
