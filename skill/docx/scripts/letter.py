"""Build an office letter or order (.docx) from a JSON description, then check it.

    python3 letter.py <spec.json> <out.docx> [--source <scan>] [--pages N]

One call builds the document, shrinks type and spacing until it fits on --pages pages
(default: the spec's "pages", else 1), validates it, renders page 1, and with --source
writes a side-by-side image of the scan and the render. The last lines printed are the
report: pages, size used, pictures placed, missing fonts, and the image paths to read.

The spec is data, not code. Bangla goes in the complex-script font slot automatically.

{
  "page": {"margins_cm": [1.5, 2, 1.5, 2]},        # top, right, bottom, left (optional)
  "font": {"latin": "Times New Roman", "bangla": "Nikosh", "size": 12},
  "pages": 1,
  "blocks": [
    {"type": "letterhead", "logo": "/mnt/data/qa/logo.png", "logo_width_cm": 1.8,
     "lines": [{"text": "...", "size": 18, "bold": true}, {"text": "..."}], "rule": true},
    {"type": "memo", "left": "স্মারক নং- ...", "right": ["তারিখ : ০১ আশ্বিন ১৪৩৩", "১৬ সেপ্টেম্বর ২০২৬"]},
    {"type": "title", "text": "অফিস আদেশ", "underline": true},
    {"type": "paragraph", "text": "...", "align": "justify", "first_indent_cm": 1},
    {"type": "signature", "intro": "কর্তৃপক্ষের অনুমোদনক্রমে,", "image": "/mnt/data/qa/sig1.png",
     "image_width_cm": 3, "lines": ["তাহমিনা রহমান", "যুগ্মসচিব"]},
    {"type": "address", "lines": ["...", "..."]},
    {"type": "heading", "text": "সদয় অবগতি ...", "underline": true},
    {"type": "list", "items": [["১।", "সচিব, ইউজিসি, ঢাকা।"], ["২-১২।", "..."]]},
    {"type": "table", "rows": [[{"text": "...", "header": true, "colspan": 2}], [{"text": "..."}, {"text": "..."}]],
     "widths_cm": [8, 9]},
    {"type": "image", "path": "...", "width_cm": 4, "align": "center"},
    {"type": "spacer", "pt": 6}
  ]
}

"align" is left, center, right or justify. Any block takes "size", "bold" and
"space_before"/"space_after" in points. A "memo" right column, "signature" and the
letterhead logo are laid out in borderless tables, so they stay beside their neighbours.
"""

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from docx import Document
from docx.enum.section import WD_ORIENT, WD_SECTION
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from office.embed import embed_font  # noqa: E402
from office.soffice import run_soffice  # noqa: E402

A4 = (21.0, 29.7)
DEFAULT_MARGINS = [1.5, 2.0, 1.5, 2.0]
MIN_SIZE = 10.0
# The two or three words printed under an emblem, as on a UGC letterhead.
LOGO_CAPTION_PT = 6.5
# A row keeps a gap column only when the page left at least this much room; a column is never
# narrower than MIN_ROW_COLUMN_CM.
MIN_ROW_GAP_CM = 0.3
MIN_ROW_COLUMN_CM = 1.0
# Word pads a cell on both sides; a picture wider than what is left is cut off.
CELL_PADDING_CM = 0.4
CAPTION_CHAR_EM = 0.42
POINTS_PER_CM = 72 / 2.54
MAX_CAPTION_COLUMN_CM = 4.5
MIN_MARGIN = 1.2
GAP_STEP = 0.7
MIN_GAP_SCALE = 0.3
SIGNATURE_STEP = 0.85
MIN_SIGNATURE_SCALE = 0.6
# Bangla faces such as Nikosh carry tall line metrics, so a dense page overflows at any type size.
# The last fitting step sets the leading itself, tall enough for conjuncts and vowel signs.
TIGHT_LEADING = 1.25
# Leading and gap settings, loosest first, tried after fitting to bring the text's end level with
# the scan's; type sizes are left alone. Within BOTTOM_TOLERANCE of the page height is level.
SPACING_STEPS = [(False, 1.45), (False, 1.25), (False, 1.0), (True, 1.0), (True, 0.8), (True, 0.6), (True, 0.4)]
BOTTOM_TOLERANCE = 0.012
SCALE_STEP = 0.03
BANGLA = re.compile(r"[ঀ-৿]")
ALIGN = {
    "left": WD_ALIGN_PARAGRAPH.LEFT,
    "center": WD_ALIGN_PARAGRAPH.CENTER,
    "right": WD_ALIGN_PARAGRAPH.RIGHT,
    "justify": WD_ALIGN_PARAGRAPH.JUSTIFY,
}


P_PR_ORDER = (
    "pStyle keepNext keepLines pageBreakBefore framePr widowControl numPr suppressLineNumbers pBdr "
    "shd tabs suppressAutoHyphens kinsoku wordWrap overflowPunct topLinePunct autoSpaceDE autoSpaceDN "
    "bidi adjustRightInd snapToGrid spacing ind contextualSpacing mirrorIndents suppressOverlap jc "
    "textDirection textAlignment textboxTightWrap outlineLvl divId cnfStyle rPr sectPr pPrChange"
).split()
R_PR_ORDER = (
    "rStyle rFonts b bCs i iCs caps smallCaps strike dstrike outline shadow emboss imprint noProof "
    "snapToGrid vanish webHidden color spacing w kern position sz szCs highlight u effect bdr shd "
    "fitText vertAlign rtl cs em lang eastAsianLayout specVanish oMath"
).split()
TBL_PR_ORDER = (
    "tblStyle tblpPr tblOverlap bidiVisual tblStyleRowBandSize tblStyleColBandSize tblW jc "
    "tblCellSpacing tblInd tblBorders shd tblLayout tblCellMar tblLook tblCaption tblDescription"
).split()


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


class Style:
    """Type size and spacing, scaled down together while fitting the page."""

    def __init__(self, spec, scale=1.0, margins=None, tight=False, gap_scale=1.0, signature_scale=1.0):
        self.tight = tight
        self.gap_scale = gap_scale
        self.signature_scale = signature_scale
        font = spec.get("font", {})
        self.latin = font.get("latin", "Times New Roman")
        self.bangla = font.get("bangla", "Nikosh")
        self.base = float(font.get("size", 12))
        self.scale = scale
        self.margins = margins or list(spec.get("page", {}).get("margins_cm", DEFAULT_MARGINS))
        self.page_cm = (A4[1], A4[0]) if spec.get("page", {}).get("landscape") else A4

    def size(self, value=None):
        return max(MIN_SIZE * 0.85, (float(value) if value else self.base) * self.scale)

    def gap(self, points):
        return Pt(max(0.0, float(points) * self.scale * self.gap_scale))

    @property
    def text_width_cm(self):
        return self.page_cm[0] - self.margins[1] - self.margins[3]


def set_fonts(run, style, size, bold=False, italic=False, underline=False):
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.italic = italic
    run.font.underline = underline
    r_pr = run._element.get_or_add_rPr()
    fonts = r_pr.find(qn("w:rFonts"))
    if fonts is None:
        fonts = OxmlElement("w:rFonts")
        r_pr.insert(0, fonts)
    for slot in ("w:ascii", "w:hAnsi", "w:eastAsia"):
        fonts.set(qn(slot), style.latin)
    fonts.set(qn("w:cs"), style.bangla)
    size_cs = OxmlElement("w:szCs")
    size_cs.set(qn("w:val"), str(int(round(size * 2))))
    insert_ordered(r_pr, size_cs, R_PR_ORDER)
    if bold:
        insert_ordered(r_pr, OxmlElement("w:bCs"), R_PR_ORDER)
    if BANGLA.search(run.text or ""):
        lang = OxmlElement("w:lang")
        lang.set(qn("w:bidi"), "bn-BD")
        insert_ordered(r_pr, lang, R_PR_ORDER)


def add_text(paragraph, text, style, block, size=None, bold=None, underline=False):
    run = paragraph.add_run(str(text))
    set_fonts(
        run,
        style,
        style.size(size or block.get("size")),
        bold=block.get("bold", False) if bold is None else bold,
        italic=block.get("italic", False),
        underline=underline or block.get("underline", False),
    )
    return run


def shape(paragraph, style, block, align="left", before=0, after=4):
    fmt = paragraph.paragraph_format
    paragraph.alignment = ALIGN.get(block.get("align", align), WD_ALIGN_PARAGRAPH.LEFT)
    fmt.space_before = style.gap(block.get("space_before", before))
    fmt.space_after = style.gap(block.get("space_after", after))
    if style.tight:
        fmt.line_spacing_rule = WD_LINE_SPACING.EXACTLY
        fmt.line_spacing = Pt(style.size(block.get("size")) * TIGHT_LEADING)
    else:
        fmt.line_spacing_rule = WD_LINE_SPACING.MULTIPLE
        fmt.line_spacing = max(1.0, 1.15 * min(1.0, style.scale + 0.1))
    if block.get("first_indent_cm"):
        fmt.first_line_indent = Cm(float(block["first_indent_cm"]))
    if block.get("left_indent_cm"):
        fmt.left_indent = Cm(float(block["left_indent_cm"]))
    if block.get("right_indent_cm"):
        fmt.right_indent = Cm(float(block["right_indent_cm"]))
    return paragraph


def bottom_rule(paragraph):
    p_pr = paragraph._p.get_or_add_pPr()
    borders = OxmlElement("w:pBdr")
    bottom = OxmlElement("w:bottom")
    for key, value in (("w:val", "single"), ("w:sz", "8"), ("w:space", "1"), ("w:color", "000000")):
        bottom.set(qn(key), value)
    borders.append(bottom)
    insert_ordered(p_pr, borders, P_PR_ORDER)


def borderless_table(container, widths_cm):
    return borderless_grid(container, widths_cm, 1).rows[0].cells


def borderless_grid(container, widths_cm, rows):
    table = container.add_table(rows=rows, cols=len(widths_cm))
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False
    tbl_pr = table._tbl.tblPr
    borders = OxmlElement("w:tblBorders")
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        element = OxmlElement(f"w:{edge}")
        element.set(qn("w:val"), "nil")
        borders.append(element)
    insert_ordered(tbl_pr, borders, TBL_PR_ORDER)
    for row in table.rows:
        for cell, width in zip(row.cells, widths_cm):
            cell.width = Cm(width)
    for column, width in zip(table.columns, widths_cm):
        column.width = Cm(width)
    return table


def gap_after_table(doc, style, points):
    """Word needs a paragraph between tables; this one takes only the gap, not a line of text."""
    return hairline(doc.add_paragraph(), style, points)


def hairline(paragraph, style, points=0):
    """An empty paragraph one point high, so it adds only `points` of space, not a line."""
    fmt = paragraph.paragraph_format
    fmt.space_before, fmt.space_after = Pt(0), style.gap(points)
    fmt.line_spacing_rule, fmt.line_spacing = WD_LINE_SPACING.EXACTLY, Pt(1)
    p_pr = paragraph._p.get_or_add_pPr()
    mark = OxmlElement("w:rPr")
    size = OxmlElement("w:sz")
    size.set(qn("w:val"), "2")
    mark.append(size)
    insert_ordered(p_pr, mark, P_PR_ORDER)
    return paragraph


def cell_paragraph(cell, first):
    return cell.paragraphs[0] if first else cell.add_paragraph()


def picture(paragraph, path, width_cm):
    """An exact line height would clip the picture to that one line."""
    paragraph.paragraph_format.line_spacing_rule = WD_LINE_SPACING.SINGLE
    paragraph.add_run().add_picture(str(path), width=Cm(float(width_cm)))


def natural_width_cm(path, dpi=96):
    with Image.open(path) as image:
        return image.width / dpi * 2.54


def letterhead(doc, block, style):
    lines = block.get("lines", [])
    logo = block.get("logo")
    if logo:
        mirror = float(block.get("logo_width_cm", 2.0)) + 0.4
        side = mirror
        captions = block.get("logo_caption", [])
        if captions:
            # A caption wider than the emblem widens its own column rather than wrapping. The
            # column on the right stays the emblem's width, so the name beside it keeps its room.
            em_cm = style.size(LOGO_CAPTION_PT) / POINTS_PER_CM
            widest = max(len(text) for text in captions) * CAPTION_CHAR_EM * em_cm
            side = min(max(side, widest + 0.2), MAX_CAPTION_COLUMN_CM)
        left, middle, _ = borderless_table(doc, [side, style.text_width_cm - side - mirror, mirror])
        picture(shape(left.paragraphs[0], style, {}, align="center", after=0), logo, float(block.get("logo_width_cm", 2.0)))
        for text in block.get("logo_caption", []):
            caption = {"size": LOGO_CAPTION_PT}
            paragraph = left.add_paragraph()
            shape(paragraph, style, caption, align="center", after=0)
            add_text(paragraph, text, style, caption)
        target = middle
    else:
        target = None
    for index, line in enumerate(lines):
        paragraph = cell_paragraph(target, index == 0) if target else doc.add_paragraph()
        shape(paragraph, style, line, align="center", after=0)
        add_text(paragraph, line.get("text", ""), style, line)
    if block.get("rule", True):
        rule = doc.add_paragraph()
        shape(rule, style, {}, after=6)
        bottom_rule(rule)


def memo(doc, block, style):
    right = block.get("right", [])
    right_width = float(block.get("right_width_cm", 6.0))
    left_cell, right_cell = borderless_table(doc, [style.text_width_cm - right_width, right_width])
    paragraph = shape(left_cell.paragraphs[0], style, {}, after=0)
    add_text(paragraph, block.get("left", ""), style, block)
    for index, line in enumerate(right):
        paragraph = shape(cell_paragraph(right_cell, index == 0), style, {}, after=0)
        add_text(paragraph, line, style, block)
        if index == 0 and len(right) > 1 and block.get("rule_between", True):
            bottom_rule(paragraph)
    gap_after_table(doc, style, block.get("space_after", 4))


def is_blank(cell):
    paragraphs = cell.paragraphs
    return len(paragraphs) == 1 and not paragraphs[0].text and not paragraphs[0]._p.xpath(".//w:drawing")


def signature_part(cell, block, style, width, part):
    """One piece of a signature, centred in `cell`: its intro, the picture of the handwriting, or
    printed line `("line", n)`."""
    paragraph = shape(cell_paragraph(cell, is_blank(cell)), style, {}, align="center", after=2 if part == "intro" else 0)
    if part == "intro":
        add_text(paragraph, block["intro"], style, block)
    elif part == "image":
        image_width = block.get("image_width_cm") or min(width - 0.5, natural_width_cm(block["image"]))
        picture(paragraph, block["image"], float(image_width) * style.signature_scale)
    else:
        add_text(paragraph, block["lines"][part[1]], style, block)


def signature_parts(block):
    parts = ["intro"] if block.get("intro") else []
    parts += ["image"] if block.get("image") else []
    return parts + [("line", number) for number in range(len(block.get("lines", [])))]


def signature_content(cell, block, style, width):
    """The intro, the picture of the handwriting and the printed lines, centred in `cell`."""
    for part in signature_parts(block):
        signature_part(cell, block, style, width, part)


def signature(doc, block, style):
    width = float(block.get("width_cm", 6.5))
    side = block.get("align", "right")
    if block.get("left_cm") is not None:
        before = min(float(block["left_cm"]), max(style.text_width_cm - width, 0))
        after = max(style.text_width_cm - before - width, 0)
        widths = [w for w in (before, width, after) if w > 0]
        cells = borderless_table(doc, widths)
        cell = cells[1 if before > 0 else 0]
    else:
        widths = [style.text_width_cm - width, width] if side == "right" else [width, style.text_width_cm - width]
        cells = borderless_table(doc, widths)
        cell = cells[1] if side == "right" else cells[0]
    signature_content(cell, block, style, width)
    gap_after_table(doc, style, block.get("space_after", 2))


def lines_block(doc, block, style):
    for index, line in enumerate(block.get("lines", [])):
        last = index == len(block["lines"]) - 1
        paragraph = shape(doc.add_paragraph(), style, block, after=block.get("space_after", 6) if last else 0)
        add_text(paragraph, line, style, block)


TABLE_BLOCKS = {"memo", "signature", "table"}


def numbered_list(doc, block, style):
    hanging = Cm(float(block.get("hanging_cm", 1.4)))
    styles = block.get("item_styles") or []
    for index, (number, text) in enumerate(block.get("items", [])):
        item = {**block, **(styles[index] if index < len(styles) else {})}
        paragraph = shape(doc.add_paragraph(), style, item, align="justify", after=1)
        fmt = paragraph.paragraph_format
        start = Cm(float(block.get("left_indent_cm", 0))) + hanging
        fmt.left_indent = start
        fmt.first_line_indent = -hanging
        fmt.tab_stops.add_tab_stop(start)
        add_text(paragraph, f"{number}\t{text}", style, item)


def data_table(doc, block, style):
    """A ruled table. A cell may span rows and columns; a later row skips the columns one covers."""
    rows = block.get("rows", [])
    placed, taken = [], set()
    for row_index, row in enumerate(rows):
        column = 0
        for cell in row:
            while (row_index, column) in taken:
                column += 1
            down, across = int(cell.get("rowspan", 1)), int(cell.get("colspan", 1))
            taken.update((row_index + r, column + c) for r in range(down) for c in range(across))
            placed.append((row_index, column, down, across, cell))
            column += across
    columns = max((c + 1 for _, c in taken), default=1)
    widths = block.get("widths_cm") or [section_text_width_cm(doc) / columns] * columns
    table = doc.add_table(rows=len(rows), cols=columns)
    table.style = "Table Grid"
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False
    for column, width in zip(table.columns, widths):
        column.width = Cm(float(width))
    for row in table.rows:
        for cell, width in zip(row.cells, widths):
            cell.width = Cm(float(width))
    for row in table.rows[: block.get("header_rows", 0)]:
        row._tr.get_or_add_trPr().append(OxmlElement("w:tblHeader"))
    for row_index, column, down, across, cell in placed:
        target = table.cell(row_index, column)
        if down > 1 or across > 1:
            target = target.merge(table.cell(row_index + down - 1, column + across - 1))
        lines = str(cell.get("text", "")).split("\n")
        for index, line in enumerate(lines):
            paragraph = shape(cell_paragraph(target, index == 0), style, block, after=0)
            add_text(paragraph, line, style, block, bold=bool(cell.get("header")) or block.get("bold", False))
    gap_after_table(doc, style, block.get("space_after", 4))


def section_text_width_cm(doc):
    section = doc.sections[-1]
    return (section.page_width - section.left_margin - section.right_margin) / Cm(1)


def new_section(doc, landscape):
    """A new page turned the other way: a scanned annex in landscape after a portrait letter."""
    section = doc.add_section(WD_SECTION.NEW_PAGE)
    width, height = (A4[1], A4[0]) if landscape else A4
    section.orientation = WD_ORIENT.LANDSCAPE if landscape else WD_ORIENT.PORTRAIT
    section.page_width, section.page_height = Cm(width), Cm(height)


def row_widths(layout, text_width):
    """Column widths for a row, with an empty column wherever the page left a gap, so each column
    starts where it did on the page. Returns the widths and, per laid-out column, its cell index."""
    widths, cells, cursor = [], [], 0.0
    for left, width in layout:
        left = min(max(left, cursor), text_width)
        if left - cursor >= MIN_ROW_GAP_CM:
            widths.append(left - cursor)
        else:
            left = cursor
        width = max(min(width, text_width - left), MIN_ROW_COLUMN_CM)
        cells.append(len(widths))
        widths.append(width)
        cursor = left + width
    if text_width - cursor >= MIN_ROW_GAP_CM:
        widths.append(text_width - cursor)
    elif widths:
        widths[-1] += max(text_width - cursor, 0)
    return widths, cells


def drop_empty_first(cell):
    """A new cell starts with an empty paragraph; once something else is in it, it is only a gap."""
    paragraphs = cell.paragraphs
    if len(paragraphs) > 1 and not paragraphs[0].text and not paragraphs[0]._p.xpath(".//w:drawing"):
        paragraphs[0]._p.getparent().remove(paragraphs[0]._p)


def part_band(block, part):
    """The band a signature's piece prints in; the block's own band when it was not placed."""
    bands = block.get("part_bands") or {}
    if isinstance(part, tuple):
        lines = bands.get("lines") or []
        return lines[part[1]] if part[1] < len(lines) else block.get("band", 0)
    return bands.get(part, block.get("band", 0))


def render_row(doc, blocks, style):
    """Blocks printed side by side, as a borderless table: a column for each, and a table row for
    each band down the page, so lines printed beside each other stay beside each other."""
    widths, cells_at = row_widths(blocks[0].get("row_layout", []), style.text_width_cm)
    gaps = blocks[0].get("row_bands") or [0]
    table = borderless_grid(doc, widths, len(gaps))
    last = len(gaps) - 1
    for block in blocks:
        column = cells_at[min(block.get("column", 0), len(cells_at) - 1)]
        if block.get("type") == "signature":
            width = widths[column]
            image_width = block.get("image_width_cm")
            if image_width and float(image_width) * style.signature_scale > width - CELL_PADDING_CM:
                block = {**block, "image_width_cm": (width - CELL_PADDING_CM) / style.signature_scale}
            for part in signature_parts(block):
                signature_part(table.cell(min(part_band(block, part), last), column), block, style, width, part)
        else:
            render_block(table.cell(min(block.get("band", 0), last), column), block, style)
    for number, gap in enumerate(gaps):
        for cell in table.rows[number].cells:
            drop_empty_first(cell)
            if is_blank(cell):
                hairline(cell.paragraphs[0], style)
            else:
                cell.paragraphs[0].paragraph_format.space_before = style.gap(gap)
    gap_after_table(doc, style, 0)


def render_block(doc, block, style):
    """One block into the document or a table cell."""
    kind = block.get("type")
    if kind == "letterhead":
        letterhead(doc, block, style)
    elif kind == "memo":
        memo(doc, block, style)
    elif kind == "title":
        paragraph = shape(doc.add_paragraph(), style, block, align="center", before=6, after=8)
        add_text(paragraph, block.get("text", ""), style, block, size=block.get("size", style.base + 2), bold=block.get("bold", True))
    elif kind == "heading":
        paragraph = shape(doc.add_paragraph(), style, block, before=6, after=4)
        add_text(paragraph, block.get("text", ""), style, block, bold=block.get("bold", False))
    elif kind == "paragraph":
        paragraph = shape(doc.add_paragraph(), style, block, align="justify", after=8)
        add_text(paragraph, block.get("text", ""), style, block)
    elif kind == "signature":
        signature(doc, block, style)
    elif kind == "address":
        lines_block(doc, block, style)
    elif kind == "list":
        numbered_list(doc, block, style)
    elif kind == "table":
        data_table(doc, block, style)
    elif kind == "image":
        paragraph = shape(doc.add_paragraph(), style, block, align="center", after=4)
        picture(paragraph, block["path"], block.get("width_cm") or natural_width_cm(block["path"]))
    elif kind == "spacer":
        doc.add_paragraph().paragraph_format.space_after = style.gap(block.get("pt", 6))
    else:
        raise ValueError(f"unknown block type {kind!r}")


def build(spec, out_path, style):
    doc = Document()
    section = doc.sections[0]
    section.page_width, section.page_height = Cm(style.page_cm[0]), Cm(style.page_cm[1])
    if style.page_cm[0] > style.page_cm[1]:
        section.orientation = WD_ORIENT.LANDSCAPE
    top, right, bottom, left = style.margins
    section.top_margin, section.right_margin = Cm(top), Cm(right)
    section.bottom_margin, section.left_margin = Cm(bottom), Cm(left)
    properties = doc.core_properties
    properties.author = properties.last_modified_by = "Synapse"
    properties.title = spec.get("title", "")
    zoom = doc.settings.element.find(qn("w:zoom"))
    if zoom is not None and zoom.get(qn("w:percent")) is None:
        zoom.set(qn("w:percent"), "100")

    blocks = spec.get("blocks", [])
    index = 0
    while index < len(blocks):
        block = blocks[index]
        kind = block.get("type")
        if block.get("section"):
            new_section(doc, bool(block["section"].get("landscape")))
        body = doc.element.body
        before = len(body)
        if block.get("row"):
            run = blocks[index:index + next((i for i, b in enumerate(blocks[index:]) if b.get("row") != block["row"]), len(blocks) - index)]
            if block.get("row_space_before"):
                gap_after_table(doc, style, block["row_space_before"])
            render_row(doc, run, style)
            index += len(run)
        else:
            if block.get("space_before") and (kind in TABLE_BLOCKS or (kind == "letterhead" and block.get("logo"))):
                gap_after_table(doc, style, block["space_before"])
            render_block(doc, block, style)
            index += 1
        if block.get("page_break") and not block.get("section") and len(body) > before:
            # Body elements are added before the closing sectPr, so the first new one sits here.
            break_before(body[before - 1])
    doc.save(out_path)


def break_before(element):
    """Starts a new page at `element` without a paragraph of its own: as the paragraph's own
    "page break before", or, for a table, at the end of the paragraph before it. A paragraph
    holding only a break is pushed onto the next page when Word's text runs a little taller
    than LibreOffice's, and its break then leaves that page blank."""
    if element.tag == qn("w:p"):
        p_pr = element.get_or_add_pPr()
        if p_pr.find(qn("w:pageBreakBefore")) is None:
            insert_ordered(p_pr, OxmlElement("w:pageBreakBefore"), P_PR_ORDER)
        return
    previous = element.getprevious()
    run = OxmlElement("w:r")
    page = OxmlElement("w:br")
    page.set(qn("w:type"), "page")
    run.append(page)
    if previous is not None and previous.tag == qn("w:p"):
        previous.append(run)
        return
    paragraph = OxmlElement("w:p")
    paragraph.append(run)
    element.addprevious(paragraph)


def render(docx_path, work):
    result = run_soffice(
        ["--headless", "--convert-to", "pdf", "--outdir", str(work), str(docx_path)],
        capture_output=True,
        text=True,
        timeout=180,
    )
    pdf = Path(work) / (Path(docx_path).stem + ".pdf")
    if not pdf.exists():
        raise RuntimeError(f"render failed: {result.stderr.strip()[-400:]}")
    info = subprocess.run(["pdfinfo", str(pdf)], capture_output=True, text=True).stdout
    pages = int(re.search(r"Pages:\s+(\d+)", info).group(1))
    return pdf, pages


def fit_ladder(spec):
    """Every fitting step in order, loosest first: margins, then type and spacing, leading, signatures."""
    margins = list(spec.get("page", {}).get("margins_cm", DEFAULT_MARGINS))
    scale = 1.0
    tight = False
    gap_scale = 1.0
    signature_scale = 1.0
    style = Style(spec, scale, margins)
    ladder = [style]
    while True:
        if margins[0] > MIN_MARGIN or margins[2] > MIN_MARGIN:
            margins = [max(MIN_MARGIN, margins[0] - 0.3), margins[1], max(MIN_MARGIN, margins[2] - 0.3), margins[3]]
        elif style.base * scale > MIN_SIZE:
            scale = max(MIN_SIZE / style.base, scale - SCALE_STEP)
        elif not tight:
            tight = True
        elif gap_scale > MIN_GAP_SCALE:
            gap_scale = max(MIN_GAP_SCALE, gap_scale * GAP_STEP)
        elif signature_scale > MIN_SIGNATURE_SCALE:
            signature_scale = max(MIN_SIGNATURE_SCALE, signature_scale * SIGNATURE_STEP)
        else:
            return ladder
        style = Style(spec, scale, margins, tight, gap_scale, signature_scale)
        ladder.append(style)


def fit(spec, out_path, target, work):
    """Finds the loosest step that fits by bisection, since each build runs LibreOffice."""
    ladder = fit_ladder(spec)
    builds = 0

    def attempt(index):
        nonlocal builds
        builds += 1
        build(spec, out_path, ladder[index])
        pdf, pages = render(out_path, work)
        return pdf, pages

    pdf, pages = attempt(0)
    if pages <= target:
        return ladder[0], pdf, pages, builds
    too_loose, fits = 0, len(ladder) - 1
    current = None
    while fits - too_loose > 1:
        middle = (too_loose + fits) // 2
        pdf, pages = attempt(middle)
        current = middle
        if pages <= target:
            fits = middle
        else:
            too_loose = middle
    if current != fits:
        pdf, pages = attempt(fits)
    return ladder[fits], pdf, pages, builds


def text_bottoms(pdf):
    """Where the text ends on each rendered page, as a share of the page height."""
    out = subprocess.run(["pdftotext", "-bbox", str(pdf), "-"], capture_output=True, text=True).stdout
    bottoms = []
    for page in re.findall(r"<page (.*?)</page>", out, re.S):
        height = float(re.search(r'height="([\d.]+)"', page).group(1))
        ends = [float(y) for y in re.findall(r'yMax="([\d.]+)"', page)]
        bottoms.append(max(ends) / height if ends else None)
    return bottoms


def bottom_error(wanted, found):
    """Mean signed distance of the text's end from the scan's, over pages both have text on."""
    pairs = [(f, w) for f, w in zip(found, wanted) if f is not None and w is not None]
    return sum(f - w for f, w in pairs) / len(pairs) if pairs else 0.0


def match_bottoms(spec, out_path, fitted, pdf, pages, target, work):
    """Respaces the fitted document so its text ends where the scan's does: leading and gaps only,
    stepping tighter while the text runs past the scan's end and looser while it stops short.
    Keeps the step whose end is closest without adding a page. Returns style, pdf, pages, builds."""
    wanted = spec.get("content_bottoms")
    if not wanted:
        return fitted, pdf, pages, 0
    steps = [Style(spec, fitted.scale, fitted.margins, tight, gaps, fitted.signature_scale) for tight, gaps in SPACING_STEPS]
    start = min(
        range(len(steps)),
        key=lambda i: (abs(steps[i].gap_scale - fitted.gap_scale), steps[i].tight != fitted.tight),
    )
    error = bottom_error(wanted, text_bottoms(pdf))
    if abs(error) <= BOTTOM_TOLERANCE:
        return fitted, pdf, pages, 0
    direction = 1 if error > 0 else -1
    best = (abs(error), fitted)
    builds = 0
    index = start + direction
    while 0 <= index < len(steps):
        build(spec, out_path, steps[index])
        builds += 1
        tried, count = render(out_path, work)
        if count > target:
            break
        found = bottom_error(wanted, text_bottoms(tried))
        if abs(found) < best[0]:
            best = (abs(found), steps[index])
        if found * direction <= 0:
            break
        index += direction
    build(spec, out_path, best[1])
    pdf, pages = render(out_path, work)
    return best[1], pdf, pages, builds + 1


def validate(out_path):
    script = Path(__file__).resolve().parent / "office" / "validate.py"
    result = subprocess.run([sys.executable, str(script), str(out_path)], capture_output=True, text=True)
    lines = (result.stdout + result.stderr).strip().splitlines()
    return result.returncode == 0, lines[-1] if lines else ""


METRIC_TWINS = {
    "times new roman": ("liberation serif", "tinos"),
    "arial": ("liberation sans", "arimo"),
    "calibri": ("carlito",),
}


def missing_fonts(style):
    """Fonts that fall back to an unrelated face; a metric-compatible twin counts as present."""
    missing = []
    for name in (style.latin, style.bangla):
        matched = subprocess.run(["fc-match", "-f", "%{family}", name], capture_output=True, text=True).stdout.lower()
        twins = METRIC_TWINS.get(name.lower(), ())
        if name.lower() not in matched and not any(twin in matched for twin in twins):
            missing.append(f"{name} (drawn as {matched.split(',')[0] or 'nothing'})")
    return missing


def page_image(source, work):
    """The image to compare against. A PDF source gives its first page."""
    if Path(source).suffix.lower() != ".pdf":
        return source
    stem = Path(work) / "source"
    subprocess.run(["pdftoppm", "-png", "-r", "100", "-f", "1", "-l", "1", str(source), str(stem)], check=True)
    return next(Path(work).glob("source-*.png"))


def side_by_side(source, page_png, out_path, height=1100):
    images = []
    for path in (source, page_png):
        with Image.open(path) as image:
            image = image.convert("RGB")
            images.append(image.resize((max(1, round(image.width * height / image.height)), height)))
    canvas = Image.new("RGB", (sum(i.width for i in images) + 20, height), "white")
    canvas.paste(images[0], (0, 0))
    canvas.paste(images[1], (images[0].width + 20, 0))
    canvas.save(out_path, quality=70)


def count_pictures(out_path):
    return len(Document(str(out_path)).inline_shapes)


def main(argv):
    parser = argparse.ArgumentParser(description="Build and check an office letter from JSON.")
    parser.add_argument("spec")
    parser.add_argument("out")
    parser.add_argument("--source", help="the scan or photo being recreated")
    parser.add_argument("--pages", type=int)
    args = parser.parse_args(argv)

    spec = json.loads(Path(args.spec).read_text(encoding="utf-8"))
    out_path = Path(args.out)
    target = args.pages or int(spec.get("pages", 1))
    qa = Path("/mnt/data/qa") if Path("/mnt/data").exists() else out_path.parent / "qa"
    qa.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as work:
        style, pdf, pages, builds = fit(spec, out_path, target, work)
        style, pdf, pages, spaced = match_bottoms(spec, out_path, style, pdf, pages, target, work)
        builds += spaced
        stem = qa / f"{out_path.stem}-page"
        subprocess.run(["pdftoppm", "-png", "-r", "60", "-f", "1", "-l", "1", str(pdf), str(stem)], check=True)
        page_png = next(qa.glob(f"{out_path.stem}-page-*1.png"))
        shutil.copy(pdf, qa / f"{out_path.stem}.pdf")

    embedded = BANGLA.search(json.dumps(spec, ensure_ascii=False)) and embed_font(out_path, style.bangla)
    valid, validation = validate(out_path)
    report = [
        f"file: {out_path}",
        f"pages: {pages} (target {target}){'' if pages <= target else ' OVER: cut text or spacing in the spec'}",
        f"type: {style.base * style.scale:.1f}pt, margins {', '.join(f'{m:.1f}' for m in style.margins)} cm, builds {builds}",
        f"pictures placed: {count_pictures(out_path)}",
        f"fonts missing: {', '.join(missing_fonts(style)) or 'none'}",
        f"font embedded: {style.bangla if embedded else 'none'}",
        f"validation: {'passed' if valid else 'FAILED ' + validation}",
        f"render: {page_png}",
    ]
    if args.source:
        compare = qa / f"{out_path.stem}-compare.jpg"
        with tempfile.TemporaryDirectory() as work:
            side_by_side(page_image(args.source, work), page_png, compare)
        report.append(f"compare: {compare}  (scan left, your page right)")
    print("\n".join(report))
    return 0 if valid and pages <= target else 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
