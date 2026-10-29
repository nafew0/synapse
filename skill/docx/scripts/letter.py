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
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from office.soffice import run_soffice  # noqa: E402

A4 = (21.0, 29.7)
DEFAULT_MARGINS = [1.5, 2.0, 1.5, 2.0]
MIN_SIZE = 10.0
MIN_MARGIN = 1.2
FIT_STEPS = 10
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

    def __init__(self, spec, scale=1.0, margins=None):
        font = spec.get("font", {})
        self.latin = font.get("latin", "Times New Roman")
        self.bangla = font.get("bangla", "Nikosh")
        self.base = float(font.get("size", 12))
        self.scale = scale
        self.margins = margins or list(spec.get("page", {}).get("margins_cm", DEFAULT_MARGINS))

    def size(self, value=None):
        return max(MIN_SIZE * 0.85, (float(value) if value else self.base) * self.scale)

    def gap(self, points):
        return Pt(max(0.0, float(points) * self.scale))

    @property
    def text_width_cm(self):
        return A4[0] - self.margins[1] - self.margins[3]


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
    fmt.line_spacing_rule = WD_LINE_SPACING.MULTIPLE
    fmt.line_spacing = max(1.0, 1.15 * min(1.0, style.scale + 0.1))
    if block.get("first_indent_cm"):
        fmt.first_line_indent = Cm(float(block["first_indent_cm"]))
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
    table = container.add_table(rows=1, cols=len(widths_cm))
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False
    tbl_pr = table._tbl.tblPr
    borders = OxmlElement("w:tblBorders")
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        element = OxmlElement(f"w:{edge}")
        element.set(qn("w:val"), "nil")
        borders.append(element)
    insert_ordered(tbl_pr, borders, TBL_PR_ORDER)
    for cell, width in zip(table.rows[0].cells, widths_cm):
        cell.width = Cm(width)
    for column, width in zip(table.columns, widths_cm):
        column.width = Cm(width)
    return table.rows[0].cells


def cell_paragraph(cell, first):
    return cell.paragraphs[0] if first else cell.add_paragraph()


def picture(paragraph, path, width_cm):
    paragraph.add_run().add_picture(str(path), width=Cm(float(width_cm)))


def natural_width_cm(path, dpi=96):
    with Image.open(path) as image:
        return image.width / dpi * 2.54


def letterhead(doc, block, style):
    lines = block.get("lines", [])
    logo = block.get("logo")
    if logo:
        side = float(block.get("logo_width_cm", 2.0)) + 0.4
        left, middle, _ = borderless_table(doc, [side, style.text_width_cm - 2 * side, side])
        picture(shape(left.paragraphs[0], style, {}, align="center", after=0), logo, side - 0.4)
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
    doc.add_paragraph().paragraph_format.space_after = style.gap(block.get("space_after", 4))


def signature(doc, block, style):
    width = float(block.get("width_cm", 6.5))
    side = block.get("align", "right")
    widths = [style.text_width_cm - width, width] if side == "right" else [width, style.text_width_cm - width]
    cells = borderless_table(doc, widths)
    cell = cells[1] if side == "right" else cells[0]
    first = True
    if block.get("intro"):
        add_text(shape(cell_paragraph(cell, first), style, {}, align="center", after=2), block["intro"], style, block)
        first = False
    if block.get("image"):
        paragraph = shape(cell_paragraph(cell, first), style, {}, align="center", after=0)
        image_width = block.get("image_width_cm") or min(width - 0.5, natural_width_cm(block["image"]))
        picture(paragraph, block["image"], image_width)
        first = False
    for line in block.get("lines", []):
        paragraph = shape(cell_paragraph(cell, first), style, {}, align="center", after=0)
        add_text(paragraph, line, style, block)
        first = False
    doc.add_paragraph().paragraph_format.space_after = style.gap(block.get("space_after", 2))


def lines_block(doc, block, style):
    for index, line in enumerate(block.get("lines", [])):
        last = index == len(block["lines"]) - 1
        paragraph = shape(doc.add_paragraph(), style, block, after=block.get("space_after", 6) if last else 0)
        add_text(paragraph, line, style, block)


def numbered_list(doc, block, style):
    hanging = Cm(float(block.get("hanging_cm", 1.4)))
    for number, text in block.get("items", []):
        paragraph = shape(doc.add_paragraph(), style, block, align="justify", after=1)
        fmt = paragraph.paragraph_format
        fmt.left_indent = hanging
        fmt.first_line_indent = -hanging
        fmt.tab_stops.add_tab_stop(hanging)
        add_text(paragraph, f"{number}\t{text}", style, block)


def build(spec, out_path, style):
    doc = Document()
    section = doc.sections[0]
    section.page_width, section.page_height = Cm(A4[0]), Cm(A4[1])
    top, right, bottom, left = style.margins
    section.top_margin, section.right_margin = Cm(top), Cm(right)
    section.bottom_margin, section.left_margin = Cm(bottom), Cm(left)
    properties = doc.core_properties
    properties.author = properties.last_modified_by = "Synapse"
    properties.title = spec.get("title", "")
    zoom = doc.settings.element.find(qn("w:zoom"))
    if zoom is not None and zoom.get(qn("w:percent")) is None:
        zoom.set(qn("w:percent"), "100")

    for block in spec.get("blocks", []):
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
        elif kind == "image":
            paragraph = shape(doc.add_paragraph(), style, block, align="center", after=4)
            picture(paragraph, block["path"], block.get("width_cm") or natural_width_cm(block["path"]))
        elif kind == "spacer":
            doc.add_paragraph().paragraph_format.space_after = style.gap(block.get("pt", 6))
        else:
            raise ValueError(f"unknown block type {kind!r}")
    doc.save(out_path)


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


def fit(spec, out_path, target, work):
    """Shrink margins, then type and spacing together, until the page count is met."""
    margins = list(spec.get("page", {}).get("margins_cm", DEFAULT_MARGINS))
    scale = 1.0
    style = Style(spec, scale, margins)
    for attempt in range(FIT_STEPS):
        build(spec, out_path, style)
        pdf, pages = render(out_path, work)
        if pages <= target:
            return style, pdf, pages, attempt + 1
        if margins[0] > MIN_MARGIN or margins[2] > MIN_MARGIN:
            margins = [max(MIN_MARGIN, margins[0] - 0.3), margins[1], max(MIN_MARGIN, margins[2] - 0.3), margins[3]]
        elif style.base * scale > MIN_SIZE:
            scale = max(MIN_SIZE / style.base, scale - SCALE_STEP)
        else:
            break
        style = Style(spec, scale, margins)
    return style, pdf, pages, FIT_STEPS


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
        stem = qa / f"{out_path.stem}-page"
        subprocess.run(["pdftoppm", "-png", "-r", "60", "-f", "1", "-l", "1", str(pdf), str(stem)], check=True)
        page_png = next(qa.glob(f"{out_path.stem}-page-*1.png"))
        shutil.copy(pdf, qa / f"{out_path.stem}.pdf")

    valid, validation = validate(out_path)
    report = [
        f"file: {out_path}",
        f"pages: {pages} (target {target}){'' if pages <= target else ' OVER: cut text or spacing in the spec'}",
        f"type: {style.base * style.scale:.1f}pt, margins {', '.join(f'{m:.1f}' for m in style.margins)} cm, builds {builds}",
        f"pictures placed: {count_pictures(out_path)}",
        f"fonts missing: {', '.join(missing_fonts(style)) or 'none'}",
        f"validation: {'passed' if valid else 'FAILED ' + validation}",
        f"render: {page_png}",
    ]
    if args.source:
        compare = qa / f"{out_path.stem}-compare.jpg"
        side_by_side(args.source, page_png, compare)
        report.append(f"compare: {compare}  (scan left, your page right)")
    print("\n".join(report))
    return 0 if valid and pages <= target else 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
