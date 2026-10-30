"""Read a teaching-materials spec: numbering, marks and answers, shared by build.py and check.py."""

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

KINDS = ("exam", "mcq", "worksheet", "questionnaire", "lecture-notes", "plan")
PAPERS = ("exam", "mcq", "worksheet")
LETTERS = "abcdefghijklmnopqrstuvwxyz"
ROMAN = "i ii iii iv v vi vii viii ix x xi xii xiii xiv xv".split()
BLOOM = ("remember", "understand", "apply", "analyse", "evaluate", "create")
UNNUMBERED = ("example", "text")
DEFAULT_SCALE = ["Strongly disagree", "Disagree", "Neither agree nor disagree", "Agree", "Strongly agree"]


class SpecError(ValueError):
    pass


def load(path):
    try:
        spec = json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise SpecError(f"no spec at {path}") from error
    except json.JSONDecodeError as error:
        raise SpecError(f"spec is not valid JSON: {error}") from error
    if not isinstance(spec, dict):
        raise SpecError("spec must be a JSON object")
    if spec.get("kind") not in KINDS:
        raise SpecError(f"kind must be one of {', '.join(KINDS)}; got {spec.get('kind')!r}")
    return spec


def fmt(number):
    return f"{number:g}" if isinstance(number, (int, float)) else str(number)


def norm(text):
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", " ", str(text).casefold())).strip()


DEFAULT_FONT = "Times New Roman"
DEFAULT_SIZE = 11.0
MAX_EXPLANATION_WORDS = 40


@dataclass
class Node:
    label: str
    shown: str
    level: int
    data: dict
    section: int
    children: list = field(default_factory=list)
    marks: float | None = None

    @property
    def is_mcq(self):
        return bool(self.data.get("options"))

    @property
    def text(self):
        return str(self.data.get("text", ""))

    def answers(self):
        """Every answer-bearing field, as (field name, value) pairs."""
        keys = ("answer", "model_answer", "marking", "explanation")
        return [(key, self.data[key]) for key in keys if self.data.get(key) not in (None, "", [])]

    def walk(self):
        yield self
        for child in self.children:
            yield from child.walk()


@dataclass
class Section:
    index: int
    data: dict
    items: list
    marks: float | None = None

    @property
    def name(self):
        return self.data.get("title") or f"Section {LETTERS[self.index].upper()}"


@dataclass
class Paper:
    sections: list
    total: float | None
    defects: list
    warnings: list

    def questions(self):
        return [node for section in self.sections for node in section.items if isinstance(node, Node)]

    def nodes(self):
        return [node for question in self.questions() for node in question.walk()]

    def has_answers(self):
        return any(node.answers() for node in self.nodes())


def raw_sections(spec):
    if spec.get("sections"):
        return spec["sections"]
    return [{"title": "", "questions": spec.get("questions", [])}]


def part_label(level, index):
    return LETTERS[index] if level == 1 else ROMAN[index % len(ROMAN)]


def make_node(data, label, shown, level, section, default_marks):
    node = Node(label=label, shown=shown, level=level, data=data, section=section)
    for index, part in enumerate(data.get("parts", [])):
        mark = part_label(level + 1, index)
        node.children.append(make_node(part, f"{label}({mark})", f"({mark})", level + 1, section, default_marks))
    if not node.children:
        node.marks = data.get("marks", default_marks)
    return node


def tally(node, defects, needs_marks):
    if not node.children:
        if node.marks is None and needs_marks:
            defects.append(f"Q{node.label} has no marks")
        return node.marks
    totals = [tally(child, defects, needs_marks) for child in node.children]
    node.marks = None if None in totals else sum(totals)
    declared = node.data.get("marks")
    if declared is not None and node.marks is not None and declared != node.marks:
        defects.append(f"Q{node.label} says {fmt(declared)} marks but its parts add up to {fmt(node.marks)}")
    if node.marks is None and declared is not None:
        node.marks = declared
    return node.marks


def section_total(section, defects):
    totals = [node.marks for node in section.items if isinstance(node, Node)]
    if not totals or None in totals:
        return None
    choose = section.data.get("choose")
    if choose:
        if len(set(totals)) > 1:
            defects.append(f"{section.name}: 'answer any {choose}' but the questions carry different marks {sorted(set(totals))}")
        totals = sorted(totals, reverse=True)[: int(choose)]
    return sum(totals)


def marking_total(node, defects):
    points = node.data.get("marking") or []
    weighted = [point.get("marks") for point in points if isinstance(point, dict) and point.get("marks") is not None]
    if not weighted or node.marks is None:
        return
    if len(weighted) == len(points) and sum(weighted) != node.marks:
        defects.append(f"Q{node.label} marking scheme gives {fmt(sum(weighted))} marks but the question carries {fmt(node.marks)}")


def analyse(spec):
    """Number every question, add up the marks and list what does not add up."""
    defects, warnings = [], []
    needs_marks = spec["kind"] == "exam"
    sections, number = [], 0
    for index, raw in enumerate(raw_sections(spec)):
        default_marks = raw.get("marks_each", spec.get("marks_each"))
        items = []
        for entry in raw.get("questions", []):
            if entry.get("type") in UNNUMBERED:
                items.append(entry)
                continue
            number += 1
            node = make_node(entry, str(number), f"{number}.", 0, index, default_marks)
            tally(node, defects, needs_marks)
            items.append(node)
        section = Section(index=index, data=raw, items=items)
        section.marks = section_total(section, defects)
        declared = raw.get("marks")
        if declared is not None and section.marks is not None and declared != section.marks:
            defects.append(f"{section.name} says {fmt(declared)} marks but its questions add up to {fmt(section.marks)}")
        sections.append(section)
    totals = [section.marks for section in sections]
    total = None if None in totals else sum(totals)
    stated = header(spec).get("total_marks", spec.get("total_marks"))
    if stated is not None and total is not None and stated != total:
        defects.append(f"total marks stated as {fmt(stated)} but the questions add up to {fmt(total)}")
    paper = Paper(sections=sections, total=total, defects=defects, warnings=warnings)
    for node in paper.nodes():
        marking_total(node, defects)
    return paper


def header(spec):
    return spec.get("header", {})


def mcq_letters(node):
    """The keyed options as letters, or an error message."""
    answer = node.data.get("answer")
    options = node.data.get("options", [])
    if answer in (None, "", []):
        return None, f"Q{node.label} (MCQ) has no answer in the key"
    values = answer if isinstance(answer, list) else [answer]
    letters = []
    for value in values:
        text = str(value).strip()
        letter = re.fullmatch(r"\(?([A-Za-z])[).]?", text)
        if letter and LETTERS.index(letter.group(1).lower()) < len(options):
            letters.append(letter.group(1).lower())
        elif text in map(str, options):
            letters.append(LETTERS[list(map(str, options)).index(text)])
        else:
            return None, f"Q{node.label} (MCQ) answer {text!r} is not one of its options a)-{LETTERS[len(options) - 1]})"
    return letters, None


def scale_of(spec, section):
    return section.get("scale") or spec.get("scale") or DEFAULT_SCALE


def bloom_level(node, parent=None):
    value = node.data.get("bloom") or (parent.data.get("bloom") if parent else None)
    if not value:
        return None
    value = str(value).strip().lower().replace("analyze", "analyse")
    return value if value in BLOOM else f"?{value}"


TIME_RANGE = re.compile(r"(\d{1,2})[:.](\d{2})\s*(?:-|–|—|to)\s*(\d{1,2})[:.](\d{2})")


def minutes_range(text):
    match = TIME_RANGE.search(str(text))
    if not match:
        return None
    h1, m1, h2, m2 = map(int, match.groups())
    return h1 * 60 + m1, h2 * 60 + m2
