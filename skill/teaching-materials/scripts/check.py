"""Gate for teaching materials built by build.py.

    python3 check.py SPEC.json OUT.docx [--key KEY.docx] [--render] [--qa-dir DIR]

Exams and MCQs: marks add up (parts, sections, total, marking points), every MCQ has exactly
one keyed answer (unless "multi"), the key's numbering matches the paper's, no answer text in
the student paper, no repeated questions, Bloom levels when the spec asks for them.
Questionnaires: every Likert item on the same scale and laid out as a table. Lecture notes:
weeks numbered without gaps. Plans: aim, objectives and a timetable that adds up.
Every kind: a "Page x of y" footer. --render draws page 1 with LibreOffice when it is installed.

Exit 0 when nothing is wrong, 2 when defects are listed, 1 for bad arguments.
"""

import argparse
import re
import shutil
import subprocess
import sys
import tempfile
from collections import Counter
from pathlib import Path

from docx import Document
from docx.oxml.ns import qn

sys.path.insert(0, str(Path(__file__).resolve().parent))
from office.soffice import run_soffice  # noqa: E402
from spec import (  # noqa: E402
    PAPERS,
    SpecError,
    analyse,
    bloom_level,
    fmt,
    header,
    load,
    mcq_letters,
    minutes_range,
    norm,
    scale_of,
)

QUESTION_STYLES = ("Question", "Question Part", "Question Subpart")
LEAK_PHRASES = re.compile(r"answer key|model answer|marking scheme|correct answer|\(correct\)|\bans(?:wer)?\s*[:=]|[✓✔]", re.I)
PLACEHOLDER = re.compile(r"\[[A-Z][A-Za-z ]{2,40}\]")
MIN_FRAGMENT = 20


class Parser(argparse.ArgumentParser):
    def error(self, message):
        self.print_usage(sys.stderr)
        print(f"bad arguments: {message}")
        sys.exit(1)


def paragraph_text(element):
    pieces = []
    for node in element.iter(qn("w:t"), qn("w:tab")):
        pieces.append(node.text or "" if node.tag == qn("w:t") else "\t")
    return "".join(pieces)


def document_text(doc):
    return "\n".join(paragraph_text(p) for p in doc.element.body.iter(qn("w:p")))


def question_labels(doc):
    """Question labels in reading order, e.g. ['1', '2', '2(a)', '2(a)(i)']."""
    labels, trail = [], []
    for paragraph in doc.paragraphs:
        name = paragraph.style.name if paragraph.style is not None else ""
        if name not in QUESTION_STYLES:
            continue
        level = QUESTION_STYLES.index(name)
        shown = paragraph.text.split("\t", 1)[0].strip()
        mark = shown.rstrip(".") if level == 0 else shown
        trail = trail[:level] + [mark]
        labels.append("".join(trail))
    return labels


def has_page_numbers(doc):
    xml = "".join(section.footer._element.xml for section in doc.sections)
    return bool(re.search(r'instr="\s*PAGE\b', xml) or re.search(r"<w:instrText[^>]*>\s*PAGE\b", xml)) and "NUMPAGES" in xml


def open_doc(path, defects, what):
    if path is None:
        return None
    try:
        return Document(str(path))
    except Exception as error:  # noqa: BLE001
        defects.append(f"cannot open the {what} {path}: {type(error).__name__}")
        return None


def compare_labels(expected, found, what, defects):
    if expected == found:
        return True
    missing = [label for label in expected if label not in found]
    extra = [label for label in found if label not in expected]
    detail = []
    if missing:
        detail.append(f"missing {', '.join(missing[:8])}")
    if extra:
        detail.append(f"unexpected {', '.join(extra[:8])}")
    if not detail:
        detail.append("out of order")
    defects.append(f"{what} numbering does not match the questions: {'; '.join(detail)}")
    return False


def answer_fragments(node):
    texts = []
    for name, value in node.answers():
        if name == "answer" and node.is_mcq:
            continue
        values = value if isinstance(value, list) else [value]
        for item in values:
            text = item.get("point", "") if isinstance(item, dict) else str(item)
            texts.append(text)
            texts.extend(re.split(r"(?<=[.;!?])\s+|\n", text))
    return {norm(text) for text in texts if len(norm(text)) >= MIN_FRAGMENT}


def given_texts(paper):
    """Listed points and options: an answer may quote these without leaking."""
    given = set()
    for node in paper.nodes():
        given.update(norm(value) for value in node.data.get("points", []) + node.data.get("options", []))
    return given


def leak_checks(paper, paper_text, defects):
    found = LEAK_PHRASES.search(paper_text)
    if found:
        defects.append(f"the student paper contains {found.group(0)!r}: answers belong only in the key")
    flat = norm(paper_text)
    given = given_texts(paper)
    for node in paper.nodes():
        for fragment in answer_fragments(node) - given:
            if fragment in flat:
                defects.append(f"answer text for Q{node.label} appears in the student paper: \"{fragment[:60]}\"")
                break
    return not found


def duplicate_checks(paper, defects):
    seen = {}
    for node in paper.nodes():
        text = norm(node.text)
        limit = 10 if node.level == 0 else 25
        if len(text) < limit:
            continue
        if text in seen:
            defects.append(f"Q{seen[text]} and Q{node.label} are the same question")
        else:
            seen[text] = node.label


def mcq_checks(spec, paper, defects):
    mcqs = [node for node in paper.nodes() if node.is_mcq]
    keyed = 0
    for node in mcqs:
        options = [norm(option) for option in node.data["options"]]
        if len(options) < 2:
            defects.append(f"Q{node.label} (MCQ) has fewer than two options")
        if len(set(options)) < len(options):
            defects.append(f"Q{node.label} (MCQ) repeats an option")
        letters, error = mcq_letters(node)
        if error:
            defects.append(error)
            continue
        multi = node.data.get("multi", spec.get("multi", False))
        if len(set(letters)) != len(letters):
            defects.append(f"Q{node.label} (MCQ) keys the same option twice")
        elif len(letters) > 1 and not multi:
            defects.append(f"Q{node.label} (MCQ) keys {len(letters)} answers ({', '.join(letters)}); give one, or set \"multi\": true")
        else:
            keyed += 1
    return f"MCQ key: {keyed} of {len(mcqs)} keyed" if mcqs else None


def bloom_checks(spec, paper, defects, warnings):
    counts = Counter()
    for question in paper.questions():
        for node in question.walk():
            if node.children:
                continue
            level = bloom_level(node, None if node is question else question)
            if level and level.startswith("?"):
                defects.append(f"Q{node.label} has an unknown Bloom level {level[1:]!r}")
            elif level:
                counts[level] += 1
            elif spec.get("bloom"):
                defects.append(f"Q{node.label} has no Bloom level (the spec asks for them)")
    if spec.get("bloom") and 0 < len(counts) < 3:
        warnings.append(f"only {len(counts)} Bloom level(s) used; an exam spread usually covers at least three")
    return f"Bloom: {', '.join(f'{level} {count}' for level, count in counts.items())}" if counts else None


def exam_checks(spec, paper_doc, key_doc, defects, warnings):
    paper = analyse(spec)
    defects.extend(paper.defects)
    warnings.extend(paper.warnings)
    nodes = paper.nodes()
    questions = paper.questions()
    info = [f"questions: {len(questions)} ({sum(node.is_mcq for node in nodes)} MCQ) in {len(paper.sections)} section(s)"]
    stated = header(spec).get("total_marks", spec.get("total_marks"))
    if paper.total is not None:
        parts = " + ".join(f"{section.name} {fmt(section.marks)}" for section in paper.sections)
        sums = f"{parts} = {fmt(paper.total)}" if len(paper.sections) > 1 else fmt(paper.total)
        info.append(f"marks: {sums}" + (f" (stated {fmt(stated)})" if stated is not None else ""))
    elif spec["kind"] == "exam":
        info.append("marks: incomplete (see defects)")
    mcq = mcq_checks(spec, paper, defects)
    if mcq:
        info.append(mcq)
    if paper_doc is not None:
        compare_labels([node.label for node in nodes], question_labels(paper_doc), "paper", defects)
    keyed = [node.label for node in nodes if any(item.answers() for item in node.walk())]
    if keyed and key_doc is None:
        defects.append("the spec has answers but no key document was given (--key)")
    if keyed and key_doc is not None and compare_labels(keyed, question_labels(key_doc), "key", defects):
        info.append(f"key numbering: matches the paper ({len(keyed)} entries)")
    if paper_doc is not None:
        text = document_text(paper_doc)
        before = len(defects)
        leak_checks(paper, text, defects)
        info.append("answers in paper: none" if len(defects) == before else "answers in paper: FOUND")
        placeholders = sorted(set(PLACEHOLDER.findall(text)))
        if placeholders:
            info.append(f"placeholders to fill in: {', '.join(placeholders)}")
    duplicate_checks(paper, defects)
    bloom = bloom_checks(spec, paper, defects, warnings)
    if bloom:
        info.append(bloom)
    return info


def likert_tables(doc, scale):
    tables = []
    for table in doc.tables:
        first = [cell.text.strip() for cell in table.rows[0].cells]
        if first[-len(scale):] == scale:
            tables.append(len(table.rows) - 1)
    return tables


def questionnaire_checks(spec, doc, defects, warnings):
    sections = spec.get("sections", [])
    likert = [section for section in sections if section.get("type") == "likert"]
    info = []
    seen = {}
    number = 0
    for section in sections:
        for item in section.get("items", []):
            number += 1
            item = item if isinstance(item, dict) else {"text": item}
            text = norm(item.get("text", ""))
            if not text:
                defects.append(f"item {number} has no text")
                continue
            if text in seen:
                defects.append(f"items {seen[text]} and {number} are the same")
            seen.setdefault(text, number)
            if section.get("type") == "likert" and re.search(r"\b(and|or)\b", text):
                warnings.append(f"item {number} may ask two things at once (\"and\"/\"or\")")
            if "options" in item and len(item["options"]) < 2:
                defects.append(f"item {number} has fewer than two options")
    if likert:
        base = spec.get("scale") or scale_of(spec, likert[0])
        for index, section in enumerate(likert):
            scale = scale_of(spec, section)
            name = section.get("title") or f"Likert section {index + 1}"
            if scale != base:
                defects.append(f"{name} uses a different scale ({' / '.join(scale)}) from the others ({' / '.join(base)})")
            if not 3 <= len(scale) <= 7:
                defects.append(f"{name} has a {len(scale)}-point scale; use 3 to 7 points")
            if len(set(scale)) != len(scale):
                defects.append(f"{name} repeats a scale label")
        if doc is not None:
            found = likert_tables(doc, [str(label) for label in base])
            expected = [len(section.get("items", [])) for section in likert if scale_of(spec, section) == base]
            if found != expected:
                defects.append(f"Likert tables in the document {found} do not match the sections' items {expected}")
        items = sum(len(section.get("items", [])) for section in likert)
        info.append(f"Likert: {items} items on a {len(base)}-point scale ({base[0]} … {base[-1]})")
    info.insert(0, f"items: {number} in {len(sections)} section(s)")
    return info


def notes_checks(spec, doc, defects, warnings):
    weeks = spec.get("weeks", [])
    numbers = [week.get("week", index) for index, week in enumerate(weeks, 1)]
    if numbers != list(range(1, len(weeks) + 1)):
        defects.append(f"weeks are not numbered 1 to {len(weeks)} in order: {numbers}")
    expected = spec.get("total_weeks", header(spec).get("weeks"))
    if expected is not None and int(expected) != len(weeks):
        defects.append(f"the course has {expected} weeks but the notes cover {len(weeks)}")
    for number, week in zip(numbers, weeks):
        if not week.get("topic"):
            defects.append(f"week {number} has no topic")
        if not week.get("outcomes"):
            warnings.append(f"week {number} has no learning outcomes")
    if doc is not None:
        headings = [p for p in doc.paragraphs if p.style.name == "Heading 1" and p.text.split(" ", 1)[0] == spec.get("labels", {}).get("week", "Week")]
        if len(headings) != len(weeks):
            defects.append(f"the document has {len(headings)} week headings for {len(weeks)} weeks")
    return [f"weeks: {len(weeks)}"]


def clock(minutes):
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def plan_checks(spec, defects, warnings):
    for key in ("aim", "objectives", "timetable"):
        if not spec.get(key):
            defects.append(f"the plan has no {key}")
    rows = spec.get("timetable", [])
    for index, row in enumerate(rows, 1):
        if not row.get("activity"):
            defects.append(f"timetable row {index} has no activity")
    duration = spec.get("duration_minutes")
    ranges = [minutes_range(row.get("time", "")) for row in rows]
    info = [f"timetable: {len(rows)} rows"]
    if rows and all(ranges):
        for index in range(1, len(ranges)):
            if ranges[index][0] != ranges[index - 1][1]:
                warnings.append(f"timetable rows {index} and {index + 1} leave a gap or overlap")
        span = ranges[-1][1] - ranges[0][0]
        info = [f"timetable: {len(rows)} rows, {clock(ranges[0][0])} to {clock(ranges[-1][1])}, {span} minutes"]
        if duration is not None and span != int(duration):
            defects.append(f"the timetable spans {span} minutes but the plan is {duration} minutes long")
    minutes = [row.get("minutes") for row in rows]
    if duration is not None and rows and None not in minutes and sum(minutes) != int(duration):
        defects.append(f"timetable minutes add up to {sum(minutes)} but the plan is {duration} minutes long")
    return info


def qa_folder(paper_path, qa_dir):
    if qa_dir:
        return Path(qa_dir)
    return Path("/mnt/data/qa") if Path("/mnt/data").exists() else Path(paper_path).resolve().parent / "qa"


def render_page(paper_path, qa):
    if not (shutil.which("soffice") or shutil.which("libreoffice")) or not shutil.which("pdftoppm"):
        return "render: skipped (LibreOffice or poppler not installed)"
    qa.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as work:
        run_soffice(["--headless", "--convert-to", "pdf", "--outdir", work, str(Path(paper_path).resolve())], capture_output=True, timeout=180)
        pdf = Path(work) / (Path(paper_path).stem + ".pdf")
        if not pdf.exists():
            return "render: LibreOffice could not render the document"
        pages = re.search(r"Pages:\s+(\d+)", subprocess.run(["pdfinfo", str(pdf)], capture_output=True, text=True).stdout)
        stem = qa / f"{Path(paper_path).stem}-page"
        subprocess.run(["pdftoppm", "-png", "-r", "70", "-f", "1", "-l", "1", "-singlefile", str(pdf), str(stem)], check=True)
    return f"pages: {pages.group(1) if pages else '?'}\nrender: {stem}.png  (page 1; read this image once)"


def run(spec, paper_path, key_path=None, render=False, qa_dir=None):
    """Check a built paper (and key). Returns (exit code, report lines)."""
    defects, warnings = [], []
    paper_doc = open_doc(paper_path, defects, "paper")
    key_doc = open_doc(key_path, defects, "key") if key_path else None
    kind = spec["kind"]
    if kind in PAPERS:
        info = exam_checks(spec, paper_doc, key_doc, defects, warnings)
    elif kind == "questionnaire":
        info = questionnaire_checks(spec, paper_doc, defects, warnings)
    elif kind == "lecture-notes":
        info = notes_checks(spec, paper_doc, defects, warnings)
    else:
        info = plan_checks(spec, defects, warnings)
    if paper_doc is not None and not has_page_numbers(paper_doc):
        defects.append("no 'Page x of y' footer")
    lines = [f"kind: {kind}", *info]
    if render and paper_doc is not None:
        lines.extend(render_page(paper_path, qa_folder(paper_path, qa_dir)).splitlines())
    if defects:
        lines.append(f"DEFECTS ({len(defects)}):")
        lines.extend(f"  - {defect}" for defect in defects)
    else:
        lines.append("defects: none")
    if warnings:
        lines.append("warnings:")
        lines.extend(f"  - {warning}" for warning in warnings)
    return (2 if defects else 0), lines


def main(argv):
    parser = Parser(description="Check teaching materials built by build.py.")
    parser.add_argument("spec")
    parser.add_argument("paper", type=Path)
    parser.add_argument("--key", type=Path)
    parser.add_argument("--render", action="store_true", help="render page 1 with LibreOffice")
    parser.add_argument("--qa-dir", type=Path)
    args = parser.parse_args(argv)
    try:
        spec = load(args.spec)
    except SpecError as error:
        print(f"bad spec: {error}")
        return 1
    for path in (args.paper, args.key):
        if path is not None and not path.exists():
            print(f"bad arguments: no file at {path}")
            return 1
    code, lines = run(spec, args.paper, args.key, render=args.render, qa_dir=args.qa_dir)
    print("\n".join(lines))
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
