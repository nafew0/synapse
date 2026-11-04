"""Build an official letter, circular, notice, memo, meeting notice, office order or leave request.

    python3 build.py SPEC.json OUT.docx [--qa-dir DIR] [--no-render]

The spec is data (references/spec.md). The house sets the layout seen on that body's published documents.
One call builds the file, runs the gate (check.py) and, when LibreOffice is present, renders page 1.

Exit codes: 0 pass, 2 defects listed, 1 bad spec or arguments.
"""

import argparse
import datetime
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt

KINDS = ("letter", "circular", "notice", "memo", "meeting", "order", "leave")
BASE = {"date": "dotted", "numbered": False, "signature": "left", "subject_align": "left", "subject_upper": False,
        "subject_label": False, "subject_first": False, "copies": "Copies:", "contact_block": False,
        "rule": False, "bold_numbers": False}
HOUSES = {
    "ugc-lk": {**BASE, "date": "written", "subject_upper": True},
    "pa-lk": {**BASE, "numbered": True, "signature": "right", "subject_align": "center", "copies": "Copies-",
              "contact_block": True},
    "ministry-lk": {**BASE, "date": "iso-dotted", "numbered": True, "copies": "Copies:", "contact_block": True},
    "university-lk": {**BASE, "subject_upper": True},
    "bd": {**BASE, "numbered": True, "signature": "right", "subject_label": True, "subject_first": True,
           "copies": "Copy for kind information & necessary action (Not according to seniority):",
           "rule": True, "bold_numbers": True},
}
TITLES = {"memo": "MEMORANDUM", "notice": "NOTICE", "meeting": "NOTICE OF MEETING", "order": "Office Order"}
PLACEHOLDER = re.compile(r"\[[^\]\n]{2,60}\]")
BANGLA = re.compile(r"[\u0980-\u09ff]")
R_PR_ORDER = ("rStyle rFonts b bCs i iCs caps smallCaps strike dstrike outline shadow emboss imprint noProof snapToGrid "
              "vanish webHidden color spacing w kern position sz szCs highlight u effect bdr shd fitText vertAlign rtl "
              "cs em lang eastAsianLayout specVanish oMath").split()
TEXT_WIDTH = 16.0
MARGINS = (2.0, 2.5, 2.0, 2.5)


class SpecError(ValueError):
    pass


def load_spec(path):
    try:
        spec = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise SpecError(f"cannot read the spec: {error}") from error
    if spec.get("kind") not in KINDS:
        raise SpecError(f"kind must be one of {', '.join(KINDS)}")
    if spec.get("house", "university-lk") not in HOUSES:
        raise SpecError(f"house must be one of {', '.join(HOUSES)}")
    return spec


def house_of(spec):
    style = dict(HOUSES[spec.get("house", "university-lk")])
    for key in ("numbered", "signature"):
        if key in spec:
            style[key] = spec[key]
    return style


def ordinal(day):
    suffix = "th" if 10 <= day % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(day % 10, "th")
    return f"{day:02d}{suffix}"


def date_text(spec, style, today=None):
    value = spec.get("date")
    if value and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(value)):
        return str(value)
    try:
        day = datetime.date.fromisoformat(value) if value else (today or datetime.date.today())
    except ValueError as error:
        raise SpecError(f"date {value!r}: {error}") from error
    kind = spec.get("date_style", style["date"])
    if kind == "written":
        return f"{ordinal(day.day)} {day:%B}, {day.year}"
    if kind == "iso-dotted":
        return f"{day:%Y.%m.%d}"
    return f"{day:%d.%m.%Y}"


def subject_text(spec, style):
    subject = str(spec.get("subject", "")).strip()
    return subject.upper() if style["subject_upper"] and spec.get("subject_upper", True) else subject


def signer_lines(spec):
    signer = spec.get("signer") or {}
    lines = [signer.get("name") or "[Name]", signer.get("designation") or "[Designation]"]
    return lines + ([signer["office"]] if signer.get("office") else [])


class Writer:
    def __init__(self, spec, style):
        self.spec = spec
        self.style = style
        font = spec.get("font", {})
        self.latin = font.get("latin", "Times New Roman")
        self.size = float(font.get("size", 12))
        self.doc = Document()
        section = self.doc.sections[0]
        section.page_width, section.page_height = Cm(21.0), Cm(29.7)
        section.top_margin, section.right_margin = Cm(MARGINS[0]), Cm(MARGINS[1])
        section.bottom_margin, section.left_margin = Cm(MARGINS[2]), Cm(MARGINS[3])
        normal = self.doc.styles["Normal"]
        normal.font.name = self.latin
        normal.font.size = Pt(self.size)
        normal.paragraph_format.space_after = Pt(0)
        self.doc.settings.element.find(qn("w:zoom")).set(qn("w:percent"), "100")
        self.doc.core_properties.author = self.doc.core_properties.last_modified_by = "Synapse"
        self.doc.core_properties.title = str(spec.get("subject") or TITLES.get(spec["kind"], "Letter"))

    def run(self, paragraph, text, bold=False, italic=False, underline=False, size=None):
        run = paragraph.add_run(str(text))
        run.font.size = Pt(size or self.size)
        run.font.bold = bold or None
        run.font.italic = italic or None
        run.font.underline = underline or None
        r_pr = run._element.get_or_add_rPr()
        fonts = r_pr.find(qn("w:rFonts"))
        if fonts is None:
            fonts = OxmlElement("w:rFonts")
            r_pr.insert(0, fonts)
        for slot in ("w:ascii", "w:hAnsi", "w:eastAsia"):
            fonts.set(qn(slot), self.latin)
        fonts.set(qn("w:cs"), "Nikosh")
        size_cs = OxmlElement("w:szCs")
        size_cs.set(qn("w:val"), str(int(round((size or self.size) * 2))))
        insert_ordered(r_pr, size_cs)
        if BANGLA.search(str(text)):
            lang = OxmlElement("w:lang")
            lang.set(qn("w:bidi"), "bn-BD")
            insert_ordered(r_pr, lang)
        return run

    def para(self, text="", align="left", bold=False, underline=False, italic=False, after=0, before=0, size=None,
             container=None, indent=None, first=False):
        target = container if container is not None else self.doc
        paragraph = target.paragraphs[0] if first else target.add_paragraph()
        paragraph.alignment = {"left": WD_ALIGN_PARAGRAPH.LEFT, "right": WD_ALIGN_PARAGRAPH.RIGHT,
                               "center": WD_ALIGN_PARAGRAPH.CENTER, "justify": WD_ALIGN_PARAGRAPH.JUSTIFY}[align]
        paragraph.paragraph_format.space_after = Pt(after)
        paragraph.paragraph_format.space_before = Pt(before)
        if indent:
            paragraph.paragraph_format.left_indent = Cm(indent)
        if text != "":
            self.run(paragraph, text, bold=bold, underline=underline, italic=italic, size=size)
        return paragraph

    def row(self, widths):
        table = self.doc.add_table(rows=1, cols=len(widths))
        table.autofit = False
        for cell, width in zip(table.rows[0].cells, widths):
            cell.width = Cm(width)
        for column, width in zip(table.columns, widths):
            column.width = Cm(width)
        return table.rows[0].cells

    def lines(self, cell, lines, align="left", bold=False):
        for index, line in enumerate(lines):
            self.para(line, align=align, bold=bold, container=cell, first=index == 0)

    def letterhead(self):
        lines = self.spec.get("letterhead") or []
        if self.spec.get("logo"):
            paragraph = self.para(align="center", after=2)
            paragraph.add_run().add_picture(str(self.spec["logo"]), width=Cm(float(self.spec.get("logo_width_cm", 2.0))))
        for index, line in enumerate(lines):
            line = {"text": line} if isinstance(line, str) else line
            self.para(line.get("text", ""), align="center", bold=line.get("bold", index == 0),
                      size=line.get("size", self.size + 2 if index == 0 else self.size - 1))
        if lines or self.spec.get("logo"):
            self.para(after=4)

    def rule(self, paragraph):
        p_pr = paragraph._p.get_or_add_pPr()
        borders = OxmlElement("w:pBdr")
        bottom = OxmlElement("w:bottom")
        for key, value in (("w:val", "single"), ("w:sz", "6"), ("w:space", "1"), ("w:color", "000000")):
            bottom.set(qn(key), value)
        borders.append(bottom)
        anchor = next((c for c in p_pr if c.tag.split("}")[1] in ("spacing", "ind", "jc", "rPr")), None)
        if anchor is not None:
            anchor.addprevious(borders)
        else:
            p_pr.append(borders)

    def my_no(self):
        return self.spec.get("my_no") or "[My No.]"

    def reference_row(self):
        date = date_text(self.spec, self.style)
        if self.style["rule"]:
            left, right = self.row([TEXT_WIDTH - 5, 5])
            self.para(f"Ref. No. {self.spec.get('my_no') or '[Ref. No.]'}", container=left, first=True)
            self.para(f"Date: {date}", align="right", container=right, first=True)
            self.rule(self.para(after=6))
            return
        parts = [f"My No.: {self.my_no()}"]
        if self.spec.get("your_no"):
            parts.append(f"Your No.: {self.spec['your_no']}")
        parts.append(f"Date: {date}")
        cells = self.row([TEXT_WIDTH / len(parts)] * len(parts))
        for index, (cell, part) in enumerate(zip(cells, parts)):
            align = "left" if index == 0 else "right" if index == len(parts) - 1 else "center"
            self.para(part, align=align, container=cell, first=True)
        self.para(after=8)

    def circular_head(self):
        number = self.spec.get("number") or "[Circular No.]"
        date = date_text(self.spec, self.style)
        block = list(self.spec.get("issuer_address") or [])
        if self.spec.get("house") == "pa-lk":
            self.para(f"{self.spec.get('series', 'Public Administration Circular')} : {number}", after=8)
            _, right = self.row([TEXT_WIDTH - 8.5, 8.5])
            self.lines(right, [f"My No: {self.my_no()}", *block, "", date])
            self.para(after=8)
            return
        left, right = self.row([TEXT_WIDTH - 5.5, 5.5])
        series = self.spec.get("series", "COMMISSION CIRCULAR NO:" if self.spec.get("house") == "ugc-lk" else "Circular No.")
        self.para(f"{series} {number}", bold=True, container=left, first=True)
        if self.spec.get("my_no"):
            self.para(f"My No.: {self.spec['my_no']}", container=left)
        self.lines(right, block)
        self.para(date, align="right", container=right, first=not block)
        self.para(after=8)

    def addressees(self):
        lines = self.spec.get("to") or []
        for line in lines:
            self.para(line)
        if lines:
            self.para(after=6)

    def subject(self):
        text = subject_text(self.spec, self.style)
        if not text:
            return
        if self.style["subject_label"]:
            paragraph = self.para(align="justify", after=8)
            self.run(paragraph, f"Subject: {text}", bold=True)
            return
        pa = self.spec.get("house") == "pa-lk" and self.spec["kind"] == "circular"
        self.para(text, align=self.style["subject_align"], bold=True, underline=True, after=10,
                  size=self.size + 2 if pa else None)

    def salutation(self):
        if self.spec.get("salutation"):
            self.para(self.spec["salutation"], after=8)

    def body(self):
        numbered = self.style["numbered"]
        count = 0
        for block in self.spec.get("body") or []:
            if isinstance(block, str):
                count += 1
                paragraph = self.para(align="justify", after=8)
                if numbered and count > 1:
                    self.run(paragraph, f"{count:02d}.\t", bold=self.style["bold_numbers"])
                    paragraph.paragraph_format.tab_stops.add_tab_stop(Cm(1.27))
                self.run(paragraph, block)
            elif "items" in block:
                labels = block.get("labels") or ("roman" if self.spec.get("house") == "pa-lk" else "alpha")
                for index, item in enumerate(block["items"]):
                    self.hanging(item_label(index, labels), item)
                self.para(after=4)
            elif "table" in block:
                self.table(block["table"])
            else:
                raise SpecError(f"unknown body block: {block!r}")

    def hanging(self, label, text):
        paragraph = self.para(align="justify", after=3)
        fmt = paragraph.paragraph_format
        fmt.left_indent, fmt.first_line_indent = Cm(1.0), Cm(-1.0)
        fmt.tab_stops.add_tab_stop(Cm(1.0))
        self.run(paragraph, f"{label}\t{text}")

    def table(self, rows):
        columns = max(len(row) for row in rows)
        table = self.doc.add_table(rows=len(rows), cols=columns)
        table.style = "Table Grid"
        for r, row in enumerate(rows):
            for c, value in enumerate(row):
                self.para(value, container=table.cell(r, c), first=True, bold=r == 0)
        self.para(after=8)

    def enclosures(self, heading="Enclosures:"):
        items = self.spec.get("enclosures") or []
        if items:
            self.para(heading, bold=True, before=4, after=2)
            for index, item in enumerate(items, start=1):
                self.hanging(f"{index}.", item)
            self.para(after=4)

    def signature(self):
        side = self.style["signature"]
        lines = []
        if self.spec.get("closing"):
            lines += [self.spec["closing"]]
        if self.spec.get("authority"):
            lines += [self.spec["authority"]]
        names = signer_lines(self.spec)
        signer = self.spec.get("signer") or {}
        contact = []
        if signer.get("phone"):
            contact.append(f"Telephone\t: {signer['phone']}" if self.style["contact_block"] else f"Tel: {signer['phone']}")
        if signer.get("fax"):
            contact.append(f"Fax\t: {signer['fax']}")
        if signer.get("email"):
            contact.append(f"Email address\t: {signer['email']}" if self.style["contact_block"] else f"Email: {signer['email']}")
        if side == "right":
            _, cell = self.row([TEXT_WIDTH - 8, 8])
            first = True
            for line in lines:
                self.para(line, container=cell, first=first, align="center", after=30)
                first = False
            if not lines:
                self.para(container=cell, first=True, after=30)
            for line in names:
                self.para(line, container=cell, align="center")
            for line in contact:
                self.para(line, container=cell, before=2).paragraph_format.tab_stops.add_tab_stop(Cm(2.8))
            self.para(after=6)
            return
        for line in lines:
            self.para(line, after=30)
        if not lines:
            self.para(after=30)
        for index, line in enumerate(names):
            self.para(line, bold=index == 0 and self.spec.get("house") == "ugc-lk")
        for line in contact:
            self.para(line).paragraph_format.tab_stops.add_tab_stop(Cm(2.8))
        self.para(after=8)

    def copies(self):
        items = self.spec.get("copies") or []
        if self.spec.get("distribution"):
            self.para("Distribution:", bold=True, underline=True, after=2)
            for index, item in enumerate(self.spec["distribution"], start=1):
                self.hanging(f"({index})", item)
            self.para(after=4)
        if items:
            default = "Copy forwarded for information & necessary action:" if (
                self.spec["kind"] == "order" and self.spec.get("house") == "bd") else self.style["copies"]
            self.para(self.spec.get("copies_heading", default), bold=self.style["rule"], underline=self.style["rule"],
                      after=2, before=2)
            for index, item in enumerate(items, start=1):
                self.hanging(f"{index}.", item)
        if self.spec.get("file_no"):
            self.para(f"File No: {self.spec['file_no']}", before=8)

    def page_numbers(self):
        paragraph = self.doc.sections[0].footer.paragraphs[0]
        paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
        self.run(paragraph, "Page ", size=self.size - 2)
        field(paragraph, "PAGE")
        self.run(paragraph, " of ", size=self.size - 2)
        field(paragraph, "NUMPAGES")

    def details(self):
        rows = [(key.capitalize(), self.spec[key]) for key in ("date_of_meeting", "time", "duration", "venue") if self.spec.get(key)]
        for label, value in rows:
            paragraph = self.para(after=2)
            paragraph.paragraph_format.tab_stops.add_tab_stop(Cm(3.5))
            self.run(paragraph, f"{label.replace('_', ' ').replace('Date of meeting', 'Date')}:\t", bold=True)
            self.run(paragraph, value)
        if rows:
            self.para(after=6)
        agenda = self.spec.get("agenda") or []
        if agenda:
            self.para("Agenda", bold=True, after=2)
            for index, item in enumerate(agenda, start=1):
                self.hanging(f"{index}.", item)
            self.para(after=6)


def item_label(index, labels):
    if labels == "roman":
        return ["I.", "II.", "III.", "IV.", "V.", "VI.", "VII.", "VIII.", "IX.", "X."][index % 10]
    return f"({chr(97 + index % 26)})"


def field(paragraph, name):
    for kind, text in (("begin", None), (None, name), ("end", None)):
        run = paragraph.add_run()
        if kind:
            element = OxmlElement("w:fldChar")
            element.set(qn("w:fldCharType"), kind)
        else:
            element = OxmlElement("w:instrText")
            element.text = text
        run._element.append(element)


def insert_ordered(parent, child):
    name = child.tag.split("}")[1]
    later = set(R_PR_ORDER[R_PR_ORDER.index(name) + 1:])
    for sibling in parent:
        if sibling.tag.split("}")[1] in later:
            sibling.addprevious(child)
            return
    parent.append(child)


def build_doc(spec, out, page_numbers=False):
    style = house_of(spec)
    writer = Writer(spec, style)
    kind = spec["kind"]
    writer.letterhead()
    if kind == "circular":
        writer.circular_head()
        writer.addressees()
        writer.subject()
        writer.body()
        writer.enclosures()
        writer.signature()
    elif kind == "memo":
        writer.para(TITLES["memo"], align="center", bold=True, after=10)
        rows = [("To", "; ".join(spec.get("to") or []) or "[To]"), ("From", spec.get("from") or "[From]"),
                ("Date", date_text(spec, style)), ("Ref", spec.get("my_no"))]
        for label, value in rows:
            if value:
                paragraph = writer.para(after=2)
                paragraph.paragraph_format.tab_stops.add_tab_stop(Cm(2.0))
                writer.run(paragraph, f"{label}:\t", bold=True)
                writer.run(paragraph, value)
        writer.rule(writer.para(after=8))
        if spec.get("subject"):
            writer.para(f"Subject: {subject_text(spec, style)}", bold=True, after=8)
        writer.body()
        writer.enclosures()
        if spec.get("signer"):
            writer.signature()
    elif kind in ("notice", "order", "meeting"):
        writer.reference_row()
        writer.para(spec.get("title", TITLES[kind]), align="center", bold=True, underline=True, after=8)
        writer.addressees()
        writer.subject()
        writer.body()
        if kind == "meeting":
            writer.details()
        writer.enclosures()
        writer.signature()
    else:
        writer.reference_row()
        writer.addressees()
        if kind == "leave":
            for index, line in enumerate(spec.get("through") or []):
                writer.para(f"Through: {line}" if index == 0 else line, after=6 if index == len(spec["through"]) - 1 else 0)
        if style["subject_first"]:
            writer.subject()
            writer.salutation()
        else:
            writer.salutation()
            writer.subject()
        writer.body()
        if kind == "leave" and spec.get("address_on_leave"):
            writer.para(f"Address while on leave: {spec['address_on_leave']}", after=8)
        writer.enclosures("Attached:" if kind == "leave" else ("Enclosure:" if style["rule"] else "Enclosures:"))
        writer.signature()
        if kind == "leave":
            for office in spec.get("recommenders") or []:
                writer.para(f"Recommended / Not recommended: ____________________  {office}", before=8)
    writer.copies()
    if page_numbers or spec.get("page_numbers"):
        writer.page_numbers()
    writer.doc.save(out)


def render(out, qa):
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    if not soffice or not shutil.which("pdftoppm"):
        return None, None
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from office.soffice import run_soffice

    with tempfile.TemporaryDirectory() as work:
        run_soffice(["--headless", "--convert-to", "pdf", "--outdir", work, str(out)], capture_output=True, text=True, timeout=180)
        pdf = Path(work) / f"{Path(out).stem}.pdf"
        if not pdf.exists():
            return None, None
        info = subprocess.run(["pdfinfo", str(pdf)], capture_output=True, text=True).stdout
        match = re.search(r"Pages:\s+(\d+)", info)
        qa.mkdir(parents=True, exist_ok=True)
        stem = qa / f"{Path(out).stem}-page"
        subprocess.run(["pdftoppm", "-png", "-r", "70", str(pdf), str(stem)], check=False)
        return (int(match.group(1)) if match else None), sorted(qa.glob(f"{Path(out).stem}-page*.png"))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("spec")
    parser.add_argument("out")
    parser.add_argument("--qa-dir", default="/mnt/data/qa")
    parser.add_argument("--no-render", action="store_true")
    try:
        args = parser.parse_args(argv)
    except SystemExit as stop:
        return 0 if stop.code == 0 else 1
    try:
        spec = load_spec(args.spec)
        build_doc(spec, args.out)
    except (SpecError, OSError) as error:
        print(f"error: {error}")
        return 1
    pages, images = (None, None) if args.no_render else render(args.out, Path(args.qa_dir))
    if pages and pages > 1 and not spec.get("page_numbers"):
        build_doc(spec, args.out, page_numbers=True)
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from check import check_file

    code, lines = check_file(spec, args.out)
    print(f"file: {args.out}")
    print("\n".join(lines))
    print(f"pages: {pages}" if pages else "render: skipped (LibreOffice or poppler not installed)")
    if images:
        print(f"read this page image once to check the layout: {images[0]}")
    return code


if __name__ == "__main__":
    sys.exit(main())
