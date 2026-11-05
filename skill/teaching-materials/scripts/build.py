"""Build an exam paper, MCQ set, questionnaire, lecture notes or a lesson/workshop plan as Word.

    python3 build.py SPEC.json OUT.docx [--key KEY.docx] [--qa-dir DIR] [--no-render]

The spec is data (references/spec.md). Answers, model answers and marking schemes in the spec
go only into the separate key document (default OUT-answer-key.docx beside OUT.docx), never
into the paper. The build ends by running check.py's gate on what it wrote and printing the
report. Exit 0 when the gate passed, 2 when it lists defects, 1 for a bad spec or arguments.
"""

import sys
from pathlib import Path

from docx import Document
from docx.enum.style import WD_STYLE_TYPE
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_TAB_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

sys.path.insert(0, str(Path(__file__).resolve().parent))
import check  # noqa: E402
import equations  # noqa: E402
from spec import DEFAULT_FONT, DEFAULT_SIZE, LETTERS, PAPERS, Node, SpecError, analyse, bloom_level, fmt, header, load, mcq_letters, scale_of  # noqa: E402

A4 = (21.0, 29.7)
MARGINS = (2.0, 2.0, 2.0, 2.5)
TEXT_WIDTH = A4[0] - MARGINS[1] - MARGINS[3]
INDENT = 1.0
BOX = "☐"
QUESTION_STYLES = ("Question", "Question Part", "Question Subpart")
LABELS = {
    "page": "Page",
    "of": "of",
    "mark": "mark",
    "marks": "marks",
    "total": "Total",
    "duration": "Duration",
    "total_marks": "Total marks",
    "instructions": "Instructions to candidates",
    "index_number": "Index number",
    "end": "End of paper",
    "key_title": "Answer key and marking scheme",
    "confidential": "Confidential: for examiners only",
    "each": "Each question carries {marks}.",
    "choose": "Answer any {count} questions.",
    "choose_one": "Answer any one question.",
    "example": "Example",
    "solution": "Solution",
    "tick_one": "Please tick ({tick}) one box for each statement.",
    "tick_all": "(Tick all that apply)",
    "statement": "Statement",
    "no": "No.",
    "probe": "Probe",
    "outcomes": "Learning outcomes",
    "outcomes_intro": "By the end of this week, students should be able to:",
    "content": "Content",
    "activities": "Activities",
    "reading": "Reading",
    "assessment": "Assessment",
    "aim": "Aim",
    "objectives": "Objectives",
    "objectives_intro": "By the end of the session, participants will be able to:",
    "introduction": "Introduction",
    "timetable": "Timetable",
    "resources": "Resources",
    "week": "Week",
    "bloom": "Bloom level",
}
PLACEHOLDERS = {
    "institution": "[Institution name]",
    "course_code": "[Course code]",
    "course_title": "[Course title]",
    "exam": "[Examination name]",
    "duration": "[Duration]",
}
TIMETABLE_COLUMNS = (
    ("time", "Time"),
    ("minutes", "Minutes"),
    ("activity", "Activity"),
    ("details", "Details"),
    ("method", "Method"),
    ("facilitator", "Facilitator"),
    ("resources", "Resources"),
)
R_PR_ORDER = (
    "rStyle rFonts b bCs i iCs caps smallCaps strike dstrike outline shadow emboss imprint noProof "
    "snapToGrid vanish webHidden color spacing w kern position sz szCs highlight u effect bdr shd "
    "fitText vertAlign rtl cs em lang eastAsianLayout specVanish oMath"
).split()
TBL_PR_ORDER = (
    "tblStyle tblpPr tblOverlap bidiVisual tblStyleRowBandSize tblStyleColBandSize tblW jc "
    "tblCellSpacing tblInd tblBorders shd tblLayout tblCellMar tblLook tblCaption tblDescription"
).split()
P_PR_ORDER = (
    "pStyle keepNext keepLines pageBreakBefore framePr widowControl numPr suppressLineNumbers pBdr "
    "shd tabs suppressAutoHyphens kinsoku wordWrap overflowPunct topLinePunct autoSpaceDE autoSpaceDN "
    "bidi adjustRightInd snapToGrid spacing ind contextualSpacing mirrorIndents suppressOverlap jc "
    "textDirection textAlignment textboxTightWrap outlineLvl divId cnfStyle rPr sectPr pPrChange"
).split()


def insert_ordered(parent, child, order):
    """Places `child` where the schema expects it; Word rejects any other order."""
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


class Writer:
    """One Word document with the spec's fonts and labels."""

    def __init__(self, spec):
        font = spec.get("font", {})
        self.latin = font.get("latin", DEFAULT_FONT)
        self.bangla = font.get("bangla", "Nikosh")
        self.mono = font.get("mono", "Courier New")
        self.size = float(font.get("size", DEFAULT_SIZE))
        self.labels = {**LABELS, **spec.get("labels", {})}
        self.maths = equations.for_spec(spec)
        self.doc = Document()
        self.setup(spec)

    def setup(self, spec):
        section = self.doc.sections[0]
        section.page_width, section.page_height = Cm(A4[0]), Cm(A4[1])
        section.top_margin, section.right_margin = Cm(MARGINS[0]), Cm(MARGINS[1])
        section.bottom_margin, section.left_margin = Cm(MARGINS[2]), Cm(MARGINS[3])
        properties = self.doc.core_properties
        properties.author = properties.last_modified_by = "Synapse"
        properties.title = spec.get("title", "") or header(spec).get("course_title", "")
        zoom = self.doc.settings.element.find(qn("w:zoom"))
        if zoom is not None and zoom.get(qn("w:percent")) is None:
            zoom.set(qn("w:percent"), "100")
        styles = self.doc.styles
        self.style_fonts(styles["Normal"], self.size)
        styles["Normal"].paragraph_format.space_after = Pt(4)
        for name, size in (("Heading 1", self.size + 3), ("Heading 2", self.size + 1), ("Heading 3", self.size)):
            self.style_fonts(styles[name], size, bold=True)
            styles[name].paragraph_format.space_before = Pt(12 if name == "Heading 1" else 8)
            styles[name].paragraph_format.space_after = Pt(4)
        for level, name in enumerate(QUESTION_STYLES):
            style = styles.add_style(name, WD_STYLE_TYPE.PARAGRAPH)
            style.base_style = styles["Normal"]
            layout = style.paragraph_format
            layout.left_indent = Cm(INDENT * (level + 1))
            layout.first_line_indent = Cm(-INDENT)
            layout.space_before = Pt(8 if level == 0 else 3)
        self.footer()

    def style_fonts(self, style, size, bold=None):
        style.font.size = Pt(size)
        style.font.color.rgb = RGBColor(0, 0, 0)
        if bold is not None:
            style.font.bold = bold
        r_pr = style.element.get_or_add_rPr()
        fonts = r_pr.find(qn("w:rFonts"))
        if fonts is None:
            fonts = OxmlElement("w:rFonts")
            insert_ordered(r_pr, fonts, R_PR_ORDER)
        for attribute in list(fonts.attrib):
            del fonts.attrib[attribute]
        for slot in ("w:ascii", "w:hAnsi", "w:eastAsia"):
            fonts.set(qn(slot), self.latin)
        fonts.set(qn("w:cs"), self.bangla)
        size_cs = OxmlElement("w:szCs")
        size_cs.set(qn("w:val"), str(int(round(size * 2))))
        insert_ordered(r_pr, size_cs, R_PR_ORDER)
        if bold:
            insert_ordered(r_pr, OxmlElement("w:bCs"), R_PR_ORDER)

    def footer(self):
        paragraph = self.doc.sections[0].footer.paragraphs[0]
        paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
        paragraph.add_run(f"{self.labels['page']} ")
        field(paragraph, "PAGE")
        paragraph.add_run(f" {self.labels['of']} ")
        field(paragraph, "NUMPAGES")

    def numbered(self, level):
        """A paragraph in a question style, with its label and right-hand marks tab stops."""
        paragraph = self.doc.add_paragraph(style=QUESTION_STYLES[level])
        stops = paragraph.paragraph_format.tab_stops
        stops.add_tab_stop(Cm(text_indent(level)))
        stops.add_tab_stop(Cm(TEXT_WIDTH), WD_TAB_ALIGNMENT.RIGHT)
        paragraph.paragraph_format.keep_with_next = True
        return paragraph

    def para(self, text="", style=None, align=None, bold=False, italic=False, size=None, after=None, before=None, indent=None):
        paragraph = self.doc.add_paragraph(style=style)
        if text:
            self.run(paragraph, text, bold=bold, italic=italic, size=size)
        if align:
            paragraph.alignment = getattr(WD_ALIGN_PARAGRAPH, align.upper())
        layout = paragraph.paragraph_format
        if after is not None:
            layout.space_after = Pt(after)
        if before is not None:
            layout.space_before = Pt(before)
        if indent is not None:
            layout.left_indent = Cm(indent)
        return paragraph

    def run(self, paragraph, text, bold=False, italic=False, size=None, mono=False):
        parts = equations.pieces(str(text)) if not mono and "$" in str(text) else [("text", str(text))]
        last = None
        for kind, piece in parts:
            element = self.maths.get(piece) if kind == "math" else None
            if element is not None:
                equations.place(paragraph, element, alone=len(parts) == 1)
                continue
            source = f"$${piece[0]}$$" if kind == "math" and piece[1] else f"${piece[0]}$" if kind == "math" else piece
            last = self.text_run(paragraph, source, bold, italic, size, mono)
        return last

    def text_run(self, paragraph, text, bold, italic, size, mono):
        run = paragraph.add_run(text)
        run.bold = bold or None
        run.italic = italic or None
        if size:
            run.font.size = Pt(size)
        if mono:
            run.font.name = self.mono
        return run

    def heading(self, text, level=1, align=None):
        paragraph = self.doc.add_heading(str(text), level=level)
        if align:
            paragraph.alignment = getattr(WD_ALIGN_PARAGRAPH, align.upper())
        return paragraph

    def title(self, text, size_up=4):
        paragraph = self.para(text, align="center", bold=True, size=self.size + size_up, after=6)
        paragraph.paragraph_format.keep_with_next = True
        return paragraph

    def rule(self):
        paragraph = self.para(after=6)
        border(paragraph)
        return paragraph

    def lines(self, count, indent):
        for _ in range(int(count)):
            paragraph = self.para(before=14, after=0, indent=indent)
            border(paragraph, size="4")

    def items(self, values, indent=0.0, numbered=False):
        hang = 0.7
        for index, value in enumerate(values, 1):
            paragraph = self.para(after=2, indent=indent + hang)
            layout = paragraph.paragraph_format
            layout.first_line_indent = Cm(-hang)
            layout.tab_stops.add_tab_stop(Cm(indent + hang))
            self.run(paragraph, f"{index}.\t" if numbered else "•\t")
            self.run(paragraph, value)

    def text_blocks(self, value, italic=False, indent=None):
        for text in value if isinstance(value, list) else [value]:
            self.para(text, italic=italic, indent=indent, after=6)

    def code(self, text, indent):
        for line in str(text).splitlines() or [""]:
            paragraph = self.para(after=0, indent=indent + 0.3)
            self.run(paragraph, line or " ", mono=True, size=self.size)
            shade(paragraph)

    def table(self, rows, widths, grid=True, header_row=True, centre_from=None, size=None):
        table = self.doc.add_table(rows=len(rows), cols=len(widths))
        table.alignment = WD_TABLE_ALIGNMENT.CENTER
        table.autofit = False
        if grid:
            table.style = self.doc.styles["Table Grid"]
            grid_borders(table)
        widths_of(table, widths)
        for row_index, (row, values) in enumerate(zip(table.rows, rows)):
            no_split(row)
            for column, (cell, value) in enumerate(zip(row.cells, values)):
                paragraph = cell.paragraphs[0]
                paragraph.paragraph_format.space_after = Pt(0)
                bold = header_row and row_index == 0
                self.run(paragraph, value, bold=bold, size=size if (size and bold) else None)
                if centre_from is not None and column >= centre_from:
                    paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
        if header_row:
            repeat_header(table.rows[0])
        self.para(after=4)
        return table

    def side_by_side(self, left, right):
        table = self.doc.add_table(rows=1, cols=2)
        table.autofit = False
        widths_of(table, [TEXT_WIDTH / 2] * 2)
        for cell, value, align in zip(table.rows[0].cells, (left, right), ("left", "right")):
            paragraph = cell.paragraphs[0]
            paragraph.alignment = getattr(WD_ALIGN_PARAGRAPH, align.upper())
            self.run(paragraph, value, bold=True)

    def save(self, path):
        self.doc.save(path)


def widths_of(table, widths):
    tbl_pr = table._tbl.tblPr
    width = OxmlElement("w:tblW")
    width.set(qn("w:w"), str(int(sum(widths) * 567)))
    width.set(qn("w:type"), "dxa")
    insert_ordered(tbl_pr, width, TBL_PR_ORDER)
    layout = OxmlElement("w:tblLayout")
    layout.set(qn("w:type"), "fixed")
    insert_ordered(tbl_pr, layout, TBL_PR_ORDER)
    for column, value in zip(table.columns, widths):
        column.width = Cm(value)
    for row in table.rows:
        for cell, value in zip(row.cells, widths):
            cell.width = Cm(value)


def grid_borders(table):
    borders = OxmlElement("w:tblBorders")
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        element = OxmlElement(f"w:{edge}")
        for key, value in (("w:val", "single"), ("w:sz", "4"), ("w:space", "0"), ("w:color", "000000")):
            element.set(qn(key), value)
        borders.append(element)
    insert_ordered(table._tbl.tblPr, borders, TBL_PR_ORDER)


def field(paragraph, instruction):
    simple = OxmlElement("w:fldSimple")
    simple.set(qn("w:instr"), instruction)
    run = OxmlElement("w:r")
    text = OxmlElement("w:t")
    text.text = "1"
    run.append(text)
    simple.append(run)
    paragraph._p.append(simple)


def border(paragraph, size="8"):
    p_pr = paragraph._p.get_or_add_pPr()
    borders = OxmlElement("w:pBdr")
    bottom = OxmlElement("w:bottom")
    for key, value in (("w:val", "single"), ("w:sz", size), ("w:space", "1"), ("w:color", "000000")):
        bottom.set(qn(key), value)
    borders.append(bottom)
    insert_ordered(p_pr, borders, P_PR_ORDER)


def shade(paragraph):
    p_pr = paragraph._p.get_or_add_pPr()
    fill = OxmlElement("w:shd")
    for key, value in (("w:val", "clear"), ("w:color", "auto"), ("w:fill", "F2F2F2")):
        fill.set(qn(key), value)
    insert_ordered(p_pr, fill, P_PR_ORDER)


def repeat_header(row):
    tr_pr = row._tr.get_or_add_trPr()
    tr_pr.append(OxmlElement("w:tblHeader"))


def no_split(row):
    row._tr.get_or_add_trPr().append(OxmlElement("w:cantSplit"))


def marks_text(writer, marks, total=False):
    word = writer.labels["mark"] if marks == 1 else writer.labels["marks"]
    prefix = f"{writer.labels['total']} " if total else ""
    return f"[{prefix}{fmt(marks)} {word}]"


def text_indent(level):
    return INDENT * (level + 1)


def option_rows(options):
    longest = max(len(str(option)) for option in options)
    if longest <= 14 and len(options) <= 4:
        return len(options)
    if longest <= 34:
        return 2
    return 1


def mcq_options(writer, node):
    options = node.data["options"]
    indent = text_indent(node.level)
    per_row = option_rows(options)
    width = (TEXT_WIDTH - indent) / per_row
    labelled = [f"{LETTERS[index]})" for index in range(len(options))]
    for start in range(0, len(options), per_row):
        chunk = list(range(start, min(start + per_row, len(options))))
        paragraph = writer.para(after=0, indent=indent)
        layout = paragraph.paragraph_format
        layout.keep_with_next = chunk[-1] < len(options) - 1
        if per_row == 1:
            layout.left_indent = Cm(indent + 0.7)
            layout.first_line_indent = Cm(-0.7)
            layout.tab_stops.add_tab_stop(Cm(indent + 0.7))
            writer.run(paragraph, f"{labelled[chunk[0]]}\t{options[chunk[0]]}")
            continue
        for column in range(1, per_row):
            layout.tab_stops.add_tab_stop(Cm(indent + column * width))
        writer.run(paragraph, "\t".join(f"{labelled[i]} {options[i]}" for i in chunk))


def question(writer, node, hide_marks):
    paragraph = writer.numbered(node.level)
    writer.run(paragraph, f"{node.shown}\t{node.text}")
    if node.marks is not None and not node.children and not hide_marks:
        writer.run(paragraph, f"\t{marks_text(writer, node.marks)}")
    indent = text_indent(node.level)
    if node.data.get("points"):
        writer.items(node.data["points"], indent=indent)
    if node.data.get("code"):
        writer.code(node.data["code"], indent)
    if node.data.get("image"):
        picture = writer.para(indent=indent, align="center")
        picture.add_run().add_picture(str(node.data["image"]), width=Cm(float(node.data.get("image_width_cm", 10))))
    if node.is_mcq:
        mcq_options(writer, node)
    for child in node.children:
        question(writer, child, hide_marks)
    if node.data.get("answer_lines"):
        writer.lines(node.data["answer_lines"], indent)
    if node.children and node.level == 0 and node.marks is not None and not hide_marks:
        total = writer.para(marks_text(writer, node.marks, total=True), align="right", before=2, bold=True)
        total.paragraph_format.keep_with_next = False


def unnumbered(writer, entry, count):
    if entry.get("type") == "text":
        writer.text_blocks(entry.get("text", ""))
        return count
    count += 1
    paragraph = writer.para(before=8, after=2)
    writer.run(paragraph, f"{writer.labels['example']} {count}. ", bold=True)
    writer.run(paragraph, entry.get("text", ""))
    if entry.get("code"):
        writer.code(entry["code"], 0)
    paragraph = writer.para(after=6, indent=0.5)
    writer.run(paragraph, f"{writer.labels['solution']}: ", italic=True, bold=True)
    writer.run(paragraph, entry.get("solution", ""))
    return count


def uniform_mcq_marks(section):
    nodes = [node for node in section.items if isinstance(node, Node)]
    marks = {node.marks for node in nodes}
    if nodes and all(node.is_mcq for node in nodes) and len(marks) == 1 and None not in marks:
        return marks.pop()
    return None


def section_intro(writer, section, uniform):
    data = section.data
    notes = [data["instructions"]] if data.get("instructions") else []
    if data.get("choose") and not notes:
        count = int(data["choose"])
        notes.append(writer.labels["choose_one"] if count == 1 else writer.labels["choose"].format(count=count))
    if uniform is not None:
        word = writer.labels["mark"] if uniform == 1 else writer.labels["marks"]
        notes.append(writer.labels["each"].format(marks=f"{fmt(uniform)} {word}"))
    if data.get("title"):
        title = data["title"]
        if section.marks is not None:
            title = f"{title} ({fmt(section.marks)} {writer.labels['marks']})"
        writer.heading(title, level=2, align="center")
    if notes:
        writer.para(" ".join(notes), italic=True, align="center", after=6)


def exam_header(writer, spec, total, placeholders):
    head = header(spec)
    exam = spec["kind"] == "exam"

    def value(key):
        if head.get(key):
            return str(head[key])
        if exam and key in PLACEHOLDERS:
            placeholders.append(PLACEHOLDERS[key])
            return PLACEHOLDERS[key]
        return ""

    institution = value("institution")
    if institution:
        writer.para(institution, align="center", bold=True, size=writer.size + 2, after=0)
    for key in ("faculty", "department"):
        if head.get(key):
            writer.para(head[key], align="center", after=0)
    exam_name = value("exam") or spec.get("title", "")
    if exam_name:
        writer.para(exam_name, align="center", bold=True, before=6, after=0)
    for key in ("year", "semester"):
        if head.get(key):
            writer.para(head[key], align="center", after=0)
    code, title = value("course_code"), value("course_title")
    course = " – ".join(part for part in (code, title) if part)
    if course:
        writer.para(course, align="center", bold=True, after=6)
    if head.get("date"):
        writer.para(head["date"], align="center", after=4)
    duration = value("duration")
    stated = head.get("total_marks", spec.get("total_marks"))
    shown_total = stated if stated is not None else total
    if duration or shown_total is not None:
        left = f"{writer.labels['duration']}: {duration}" if duration else ""
        right = f"{writer.labels['total_marks']}: {fmt(shown_total)}" if shown_total is not None else ""
        writer.side_by_side(left, right)
    if head.get("index_number"):
        writer.para(f"{writer.labels['index_number']}: ................................", before=6)
    writer.rule()
    instructions = head.get("instructions") or spec.get("instructions")
    if instructions:
        writer.para(writer.labels["instructions"], bold=True, after=2)
        writer.items(instructions, numbered=True)
        writer.rule()


def build_paper(spec, paper, out):
    writer = Writer(spec)
    placeholders = []
    exam_header(writer, spec, paper.total, placeholders)
    examples = 0
    for section in paper.sections:
        uniform = uniform_mcq_marks(section)
        section_intro(writer, section, uniform)
        for entry in section.items:
            if isinstance(entry, Node):
                question(writer, entry, hide_marks=uniform is not None)
            else:
                examples = unnumbered(writer, entry, examples)
    if spec["kind"] == "exam":
        writer.para(f"— {writer.labels['end']} —", align="center", before=18, italic=True)
    writer.save(out)
    return placeholders


def preview(text, limit=90):
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[: limit - 1].rsplit(" ", 1)[0] + "…"


def answer_text(value):
    return value if isinstance(value, str) else ""


def key_entry(writer, node, parent=None):
    if not any(item.answers() for item in node.walk()):
        return
    paragraph = writer.numbered(node.level)
    paragraph.paragraph_format.keep_with_next = bool(node.children or node.data.get("marking"))
    writer.run(paragraph, f"{node.shown}\t")
    model = answer_text(node.data.get("model_answer") or node.data.get("answer"))
    if node.is_mcq:
        letters, _ = mcq_letters(node)
        options = node.data["options"]
        shown = "; ".join(f"({letter}) {options[LETTERS.index(letter)]}" for letter in letters or [])
        writer.run(paragraph, shown or "—", bold=True)
    elif model:
        writer.run(paragraph, model)
    else:
        writer.run(paragraph, preview(node.text), italic=True)
    level = bloom_level(node, parent)
    if level and not level.startswith("?") and not node.children:
        writer.run(paragraph, f"  ({writer.labels['bloom']}: {level.capitalize()})", italic=True, size=writer.size)
    if node.marks is not None and not node.children:
        writer.run(paragraph, f"\t{marks_text(writer, node.marks)}")
    indent = text_indent(node.level)
    if node.data.get("explanation"):
        writer.para(node.data["explanation"], italic=True, indent=indent, after=2)
    for point in node.data.get("marking") or []:
        hang = 0.7
        line = writer.para(after=1, indent=indent + hang)
        line.paragraph_format.first_line_indent = Cm(-hang)
        line.paragraph_format.tab_stops.add_tab_stop(Cm(indent + hang))
        line.paragraph_format.tab_stops.add_tab_stop(Cm(TEXT_WIDTH), WD_TAB_ALIGNMENT.RIGHT)
        text = point.get("point", "") if isinstance(point, dict) else point
        writer.run(line, f"•\t{text}")
        if isinstance(point, dict) and point.get("marks") is not None:
            writer.run(line, f"\t[{fmt(point['marks'])}]")
    for child in node.children:
        key_entry(writer, child, node)


def bloom_summary(writer, paper):
    counts = {}
    for question_node in paper.questions():
        for node in question_node.walk():
            if node.children:
                continue
            level = bloom_level(node, question_node if node is not question_node else None)
            if not level or level.startswith("?"):
                continue
            number, marks = counts.get(level, (0, 0))
            counts[level] = (number + 1, marks + (node.marks or 0))
    if not counts:
        return
    writer.heading(writer.labels["bloom"], level=2)
    rows = [["Level", "Items", writer.labels["marks"].capitalize()]]
    rows += [[level.capitalize(), str(number), fmt(marks)] for level, (number, marks) in counts.items()]
    writer.table(rows, [6.0, 3.0, 3.0], centre_from=1)


def build_key(spec, paper, out):
    writer = Writer(spec)
    head = header(spec)
    writer.para(writer.labels["confidential"].upper(), align="center", bold=True, size=writer.size, after=2)
    writer.title(writer.labels["key_title"])
    course = " – ".join(str(head[key]) for key in ("course_code", "course_title") if head.get(key))
    for line in (course, head.get("exam") or spec.get("title", "")):
        if line:
            writer.para(line, align="center", after=0)
    if paper.total is not None:
        writer.para(f"{writer.labels['total_marks']}: {fmt(paper.total)}", align="center", after=4)
    writer.rule()
    for section in paper.sections:
        nodes = [node for node in section.items if isinstance(node, Node)]
        if not any(item.answers() for node in nodes for item in node.walk()):
            continue
        if section.data.get("title"):
            writer.heading(section.data["title"], level=2)
        for node in nodes:
            key_entry(writer, node)
    bloom_summary(writer, paper)
    writer.save(out)


def questionnaire(spec, out):
    writer = Writer(spec)
    head = header(spec)
    for key in ("institution", "faculty", "department"):
        if head.get(key):
            writer.para(head[key], align="center", bold=key == "institution", after=0)
    writer.title(spec.get("title", ""))
    if spec.get("intro"):
        writer.text_blocks(spec["intro"])
    if spec.get("instructions"):
        writer.items(spec["instructions"], numbered=True)
    number = 0
    for section in spec.get("sections", []):
        if section.get("title"):
            writer.heading(section["title"], level=2)
        kind = section.get("type", "open")
        if kind == "likert":
            writer.para(section.get("instructions") or writer.labels["tick_one"].format(tick="✓"), italic=True)
            number = likert(writer, spec, section, number)
            continue
        if section.get("instructions"):
            writer.para(section["instructions"], italic=True)
        for item in section.get("items", []):
            number += 1
            item = item if isinstance(item, dict) else {"text": item}
            questionnaire_item(writer, section, item, number)
    if spec.get("closing"):
        writer.para(spec["closing"], align="center", italic=True, before=18)
    writer.save(out)


def likert(writer, spec, section, number):
    scale = scale_of(spec, section)
    scale_width = min(1.8, (TEXT_WIDTH - 6.0) / len(scale))
    widths = [1.0, TEXT_WIDTH - 1.0 - scale_width * len(scale)] + [scale_width] * len(scale)
    rows = [[writer.labels["no"], writer.labels["statement"], *scale]]
    for item in section.get("items", []):
        number += 1
        text = item.get("text", "") if isinstance(item, dict) else item
        rows.append([str(number), text, *[BOX] * len(scale)])
    writer.table(rows, widths, centre_from=2, size=writer.size)
    return number


def questionnaire_item(writer, section, item, number):
    paragraph = writer.numbered(0)
    writer.run(paragraph, f"{number}.\t{item.get('text', '')}")
    options = item.get("options")
    if options:
        if item.get("multi") or section.get("multi"):
            writer.run(paragraph, f" {writer.labels['tick_all']}", italic=True)
        boxed = [f"{BOX} {option}" for option in options]
        per_row = option_rows(boxed)
        width = (TEXT_WIDTH - INDENT) / per_row
        for start in range(0, len(boxed), per_row):
            row = writer.para(after=0, indent=INDENT)
            for column in range(1, per_row):
                row.paragraph_format.tab_stops.add_tab_stop(Cm(INDENT + column * width))
            writer.run(row, "\t".join(boxed[start:start + per_row]))
        if item.get("other"):
            writer.para(f"{BOX} {item['other']}: ..............................................", indent=INDENT, after=0)
        return
    for probe in item.get("probes", []):
        writer.para(f"{writer.labels['probe']}: {probe}", italic=True, indent=INDENT, after=0)
    default_lines = 1 if section.get("type") in ("demographic", "choice") else 3
    writer.lines(item.get("lines", section.get("lines", default_lines)), INDENT)


def as_list(value):
    if value in (None, "", []):
        return []
    return value if isinstance(value, list) else [value]


def content_block(writer, block):
    if isinstance(block, str):
        writer.para(block, after=6)
        return
    if block.get("heading"):
        writer.heading(block["heading"], level=3)
    if block.get("text"):
        writer.text_blocks(block["text"])
    if block.get("points"):
        writer.items(block["points"])
    if block.get("code"):
        writer.code(block["code"], 0)


def lecture_notes(spec, out):
    writer = Writer(spec)
    head = header(spec)
    for key in ("institution", "faculty", "department"):
        if head.get(key):
            writer.para(head[key], align="center", bold=key == "institution", after=0)
    course = " – ".join(str(head[key]) for key in ("course_code", "course_title") if head.get(key))
    if course:
        writer.title(course)
    if spec.get("title"):
        writer.para(spec["title"], align="center", size=writer.size + 1, after=8)
    for block in as_list(spec.get("overview")):
        content_block(writer, block)
    for index, week in enumerate(spec.get("weeks", []), 1):
        number = week.get("week", index)
        writer.heading(f"{writer.labels['week']} {number}: {week.get('topic', '')}", level=1)
        if week.get("outcomes"):
            writer.heading(writer.labels["outcomes"], level=2)
            writer.para(writer.labels["outcomes_intro"])
            writer.items(week["outcomes"], numbered=True)
        if week.get("content"):
            writer.heading(writer.labels["content"], level=2)
            for block in week["content"]:
                content_block(writer, block)
        for key in ("activities", "reading", "assessment"):
            if week.get(key):
                writer.heading(writer.labels[key], level=2)
                writer.items(week[key])
    for block in spec.get("sections", []):
        writer.heading(block.get("heading", ""), level=1)
        content_block(writer, {**block, "heading": None})
    writer.save(out)


def plan(spec, out):
    writer = Writer(spec)
    head = header(spec)
    for key in ("institution", "faculty", "department"):
        if head.get(key):
            writer.para(head[key], align="center", bold=key == "institution", after=0)
    writer.title(spec.get("title", ""))
    if spec.get("details"):
        rows = [[str(label), str(value)] for label, value in spec["details"].items()]
        table = writer.table(rows, [4.5, TEXT_WIDTH - 4.5], header_row=False)
        for row in table.rows:
            for run in row.cells[0].paragraphs[0].runs:
                run.bold = True
    if spec.get("aim"):
        writer.heading(writer.labels["aim"], level=2)
        writer.text_blocks(spec["aim"])
    if spec.get("objectives"):
        writer.heading(writer.labels["objectives"], level=2)
        writer.para(spec.get("objectives_intro", writer.labels["objectives_intro"]))
        writer.items(spec["objectives"], numbered=True)
    if spec.get("introduction"):
        writer.heading(writer.labels["introduction"], level=2)
        writer.text_blocks(spec["introduction"])
    if spec.get("timetable"):
        writer.heading(writer.labels["timetable"], level=2)
        timetable(writer, spec["timetable"])
    for key in ("resources", "assessment"):
        if spec.get(key):
            writer.heading(writer.labels[key], level=2)
            writer.items(spec[key])
    for block in spec.get("sections", []):
        writer.heading(block.get("heading", ""), level=2)
        content_block(writer, {**block, "heading": None})
    writer.save(out)


def timetable(writer, rows):
    columns = [(key, label) for key, label in TIMETABLE_COLUMNS if any(row.get(key) not in (None, "") for row in rows)]
    fixed = {"time": 2.8, "minutes": 1.8}
    rest = TEXT_WIDTH - sum(fixed.get(key, 0) for key, _ in columns)
    flexible = [key for key, _ in columns if key not in fixed]
    widths = [fixed.get(key, rest / max(1, len(flexible))) for key, _ in columns]
    table_rows = [[label for _, label in columns]]
    for row in rows:
        table_rows.append([", ".join(row[key]) if isinstance(row.get(key), list) else str(row.get(key, "")) for key, _ in columns])
    writer.table(table_rows, widths)


def main(argv):
    parser = check.Parser(description="Build teaching materials as Word from a JSON spec.")
    parser.add_argument("spec")
    parser.add_argument("out", type=Path)
    parser.add_argument("--key", type=Path, help="answer key document (default OUT-answer-key.docx)")
    parser.add_argument("--qa-dir", type=Path, help="working files (default /mnt/data/qa)")
    parser.add_argument("--no-render", action="store_true", help="skip the LibreOffice render of page 1")
    args = parser.parse_args(argv)
    try:
        spec = load(args.spec)
    except SpecError as error:
        print(f"bad spec: {error}")
        return 1
    if args.out.suffix.lower() != ".docx":
        print("OUT must end in .docx")
        return 1
    args.out.parent.mkdir(parents=True, exist_ok=True)
    key = None
    placeholders = []
    try:
        if spec["kind"] in PAPERS:
            paper = analyse(spec)
            placeholders = build_paper(spec, paper, args.out)
            if paper.has_answers():
                key = args.key or args.out.with_name(f"{args.out.stem}-answer-key.docx")
                build_key(spec, paper, key)
        elif spec["kind"] == "questionnaire":
            questionnaire(spec, args.out)
        elif spec["kind"] == "lecture-notes":
            lecture_notes(spec, args.out)
        else:
            plan(spec, args.out)
    except (KeyError, TypeError, ValueError, AttributeError) as error:
        print(f"bad spec: could not build ({type(error).__name__}: {error})")
        return 1
    lines = [f"paper: {args.out}"]
    lines.append(f"key: {key}" if key else "key: none (the spec has no answers)")
    if placeholders:
        lines.append(f"placeholders to fill in: {', '.join(placeholders)}")
    found, left = equations.fragments(spec), equations.failed(spec)
    if found:
        lines.append(f"equations: {len(found) - len(left)} of {len(found)} set as Word equations")
    if left:
        reason = "pandoc is not installed" if not equations.shutil.which("pandoc") else "pandoc could not parse them"
        lines.append(f"WARNING: left as LaTeX text ({reason}): {'; '.join(left[:5])}")
    code, report = check.run(spec, args.out, key, render=not args.no_render, qa_dir=args.qa_dir)
    fractions = equations.slashed(spec)
    if fractions:
        report.append(f"DEFECT: fractions typed with / show as a slash in Word; write \\frac{{a}}{{b}}: {'; '.join(fractions[:6])}")
        code = max(code, 2)
    print("\n".join(lines + report))
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
