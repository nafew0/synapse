"""Check an academic draft before delivery.

Usage: python check_draft.py IN.(docx|md|txt) [--style apa|ieee|numeric]

Reports in-text citations, citations with no reference entry, references never cited,
[citation needed] markers, placeholders, unsupported novelty or readiness claims and the
word count under each heading.

Exit codes: 0 no issues, 2 issues listed in the report, 1 bad arguments.
"""
import argparse
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

REFERENCE_HEADINGS = {
    'references', 'reference list', 'bibliography', 'works cited', 'literature cited',
    'list of references', 'sources', 'citations',
}
KNOWN_HEADINGS = REFERENCE_HEADINGS | {
    'abstract', 'introduction', 'background', 'literature review', 'review of literature',
    'methodology', 'methods', 'materials and methods', 'research methodology', 'results',
    'findings', 'discussion', 'results and discussion', 'conclusion', 'conclusions',
    'recommendations', 'limitations', 'acknowledgements', 'acknowledgments', 'appendix',
    'appendices', 'keywords', 'objectives', 'summary', 'major comments', 'minor comments',
    'recommendation', 'expected outcomes', 'beneficiaries', 'implementation period',
}
MONTHS = {
    'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
    'october', 'november', 'december',
}
NOT_AUTHORS = MONTHS | {
    'in', 'the', 'since', 'from', 'year', 'years', 'table', 'figure', 'fig', 'see', 'during',
    'until', 'by', 'of', 'and', 'or', 'act', 'section', 'chapter', 'vol', 'no', 'page', 'pp',
}
ABBREVIATIONS = ('et al.', 'e.g.', 'i.e.', 'cf.', 'Fig.', 'fig.', 'No.', 'no.', 'pp.', 'p.',
                 'vol.', 'Vol.', 'Dr.', 'Prof.', 'Mr.', 'Ms.', 'vs.', 'etc.', 'approx.', 'Eq.')

YEAR = r'(?:1[89]\d{2}|20\d{2})(?![\d])(?:[a-z](?![a-z]))?|n\.d\.'
NAME = r"[A-Z][A-Za-z'’\-]+"
PAREN_GROUP = re.compile(r'\(([^()]*?(?:' + YEAR + r')[^()]*)\)')
YEAR_RE = re.compile(r'\b(?:' + YEAR + r')')
NARRATIVE = re.compile(
    r'\b(' + NAME + r')(?:\s+et\s+al\.?|\s+(?:and|&)\s+' + NAME + r')?\s+\((' + YEAR + r')(?:[,;][^)]*)?\)')
NUMERIC = re.compile(r'\[(\d+(?:\s*[-–—]\s*\d+)?(?:\s*,\s*\d+(?:\s*[-–—]\s*\d+)?)*)\]')
CITATION_NEEDED = re.compile(r'\[citation needed:?\s*([^\]]*)\]', re.IGNORECASE)
PLACEHOLDERS = re.compile(
    r'\[(?!citation needed)[^\[\]]*(?:\.{3}|…)[^\[\]]*\]'
    r'|\[(?:insert|add|tbd|tbc|todo|placeholder|to be|amount|name|date|number|value)\b[^\]]*\]'
    r'|(?<![A-Za-z])X{2,}(?![A-Za-z])',
    re.IGNORECASE)
CLAIMS = re.compile(
    r'\bnovel(?:ty)?\b|\bfirst (?:study|studies|attempt|paper|work|investigation|research|time|to)\b'
    r'|\bfor the first time\b|\bsubmission[- ]ready\b|\bready for (?:journal )?submission\b'
    r'|\bunprecedented\b|\bground-?breaking\b|\bno (?:previous|prior|existing) (?:study|studies|research|work)\b'
    r'|\bhas never been\b|\bhave never been\b',
    re.IGNORECASE)
NUMBERED_HEADING = re.compile(r'^(\d+(?:\.\d+)*)\.?\s+\S')
MARKDOWN_HEADING = re.compile(r'^(#{1,6})\s+(.*?)\s*#*\s*$')
LIST_MARKER = re.compile(r'^\s*(?:[-*+]|\d+[.)]|\[\d+\])\s+')
ENTRY_NUMBER = re.compile(r'^\s*\[?(\d+)[\].)]\s*')


class UsageError(Exception):
    pass


class Parser(argparse.ArgumentParser):
    def error(self, message):
        self.print_usage(sys.stderr)
        print(f'error: {message}', file=sys.stderr)
        sys.exit(1)


@dataclass
class Block:
    text: str
    heading_level: int = 0


@dataclass
class Section:
    title: str
    level: int
    paragraphs: list = field(default_factory=list)

    @property
    def is_references(self):
        return normalise_heading(self.title) in REFERENCE_HEADINGS

    @property
    def words(self):
        return sum(len(p.split()) for p in self.paragraphs)


def normalise_heading(text):
    text = re.sub(r'^\d+(?:\.\d+)*\.?\s*', '', text.strip())
    return re.sub(r'[:.\s]+$', '', text).lower()


def looks_like_heading(line, in_references):
    stripped = line.strip()
    if not stripped or len(stripped.split()) > 12:
        return 0
    if normalise_heading(stripped) in KNOWN_HEADINGS:
        match = NUMBERED_HEADING.match(stripped)
        return match.group(1).count('.') + 1 if match else 1
    if in_references or stripped.endswith(('.', ',', ';', ':')) or YEAR_RE.search(stripped):
        return 0
    match = NUMBERED_HEADING.match(stripped)
    if match and re.search(r'[A-Za-z]', stripped[match.end() - 1:]):
        return match.group(1).count('.') + 1
    letters = re.sub(r'[^A-Za-z]', '', stripped)
    if len(letters) > 3 and letters.isupper():
        return 1
    return 0


def read_docx(path):
    from docx import Document
    from docx.table import Table

    document = Document(str(path))
    blocks = []
    for item in document.iter_inner_content():
        if isinstance(item, Table):
            seen = set()
            for row in item.rows:
                for cell in row.cells:
                    if id(cell._tc) in seen or not cell.text.strip():
                        continue
                    seen.add(id(cell._tc))
                    blocks.append(Block(cell.text.strip()))
            continue
        text = item.text.strip()
        if not text:
            continue
        blocks.append(Block(text, docx_heading_level(item, text, blocks)))
    return blocks


def docx_heading_level(paragraph, text, previous):
    style = (paragraph.style.name if paragraph.style is not None else '') or ''
    if style == 'Title':
        return 1
    match = re.match(r'Heading (\d)', style)
    if match:
        return int(match.group(1))
    in_references = in_reference_section(previous)
    runs = [run for run in paragraph.runs if run.text.strip()]
    all_bold = bool(runs) and all(run.bold for run in runs)
    if all_bold and len(text.split()) <= 12 and not text.endswith('.'):
        return looks_like_heading(text, in_references) or 1
    return looks_like_heading(text, in_references)


def in_reference_section(blocks):
    for block in reversed(blocks):
        if block.heading_level:
            return normalise_heading(block.text) in REFERENCE_HEADINGS
    return False


def read_text(path, markdown):
    blocks, buffer = [], []

    def flush():
        if buffer:
            blocks.append(Block(' '.join(buffer)))
            buffer.clear()

    lines = path.read_text(encoding='utf-8', errors='replace').splitlines()
    for index, raw in enumerate(lines):
        line = raw.rstrip()
        if not line.strip():
            flush()
            continue
        heading = MARKDOWN_HEADING.match(line) if markdown else None
        if heading:
            flush()
            blocks.append(Block(strip_markdown(heading.group(2)), len(heading.group(1))))
            continue
        standalone = (index == 0 or not lines[index - 1].strip()) and (
            index + 1 == len(lines) or not lines[index + 1].strip())
        level = looks_like_heading(strip_markdown(line), in_reference_section(blocks)) if standalone else 0
        if level and (not markdown or normalise_heading(strip_markdown(line)) in KNOWN_HEADINGS):
            flush()
            blocks.append(Block(strip_markdown(line), level))
            continue
        starts_entry = LIST_MARKER.match(line) or (in_reference_section(blocks) and not raw[:1].isspace())
        if starts_entry:
            flush()
        buffer.append(strip_markdown(line.strip()))
    flush()
    return blocks


def strip_markdown(text):
    return re.sub(r'(\*\*|__|\*|_)(.+?)\1', r'\2', text).strip()


def read_blocks(path):
    suffix = path.suffix.lower()
    if suffix == '.docx':
        return read_docx(path)
    if suffix in ('.md', '.markdown'):
        return read_text(path, markdown=True)
    if suffix == '.txt':
        return read_text(path, markdown=False)
    raise UsageError(f'unsupported file type {path.suffix or "(none)"}: use .docx, .md or .txt')


def build_sections(blocks):
    sections = [Section('(before the first heading)', 0)]
    for block in blocks:
        if block.heading_level:
            sections.append(Section(block.text, block.heading_level))
        else:
            sections[-1].paragraphs.append(block.text)
    return [s for s in sections if s.level or s.paragraphs]


def author_key(author_text, year):
    first_author = re.split(r'\s+et\s+al\b|\s+and\s+|&|,', author_text, maxsplit=1)[0]
    words = [w.strip("'’-") for w in re.findall(r"[A-Za-z'’\-]+", first_author)]
    names = [w for w in words if w and w[0].isupper()]
    if not names:
        return None
    surname = names[-1]
    if len(surname) < 2 or surname.lower() in NOT_AUTHORS:
        return None
    return surname.lower(), year


def author_year_citations(text):
    found = []
    for group in PAREN_GROUP.finditer(text):
        for part in group.group(1).split(';'):
            first_year = YEAR_RE.search(part)
            if not first_year:
                continue
            authors = re.sub(r'\b(?:see also|see|e\.g\.,?|cf\.|i\.e\.,?)\s*', '', part[:first_year.start()])
            for year in YEAR_RE.findall(part):
                key = author_key(authors, year)
                if key:
                    found.append(key)
    for match in NARRATIVE.finditer(text):
        key = author_key(match.group(1), match.group(2))
        if key:
            found.append(key)
    return found


def numeric_citations(text):
    found = []
    for match in NUMERIC.finditer(text):
        for piece in match.group(1).split(','):
            bounds = [int(n) for n in re.split(r'[-–—]', piece) if n.strip()]
            if len(bounds) == 2 and 0 < bounds[1] - bounds[0] < 200:
                found.extend(range(bounds[0], bounds[1] + 1))
            else:
                found.extend(bounds[:1])
    return found


def entry_author_key(entry):
    body = ENTRY_NUMBER.sub('', entry, count=1)
    year = YEAR_RE.search(body)
    if not year:
        return None
    author_part = body[:year.start()]
    surname = author_part.split(',')[0] if ',' in author_part else author_part
    return author_key(surname.strip(' .('), year.group(0))


def entry_numbers(entries):
    numbers = []
    for position, entry in enumerate(entries, start=1):
        match = ENTRY_NUMBER.match(entry)
        numbers.append(int(match.group(1)) if match else position)
    return numbers


def split_sentences(text):
    pieces = re.split(r'(?<=[.!?])\s+(?=[A-Z\[(“"])', text)
    sentences = []
    for piece in pieces:
        if sentences and sentences[-1].endswith(ABBREVIATIONS):
            sentences[-1] += ' ' + piece
        else:
            sentences.append(piece)
    return sentences


def short(text, limit=110):
    text = ' '.join(text.split())
    return text if len(text) <= limit else text[:limit - 1] + '…'


def detect_style(requested, author_year, numeric):
    if requested in ('ieee', 'numeric'):
        return 'numeric'
    if requested == 'apa':
        return 'author-year'
    if not author_year and not numeric:
        return None
    return 'numeric' if len(numeric) > len(author_year) else 'author-year'


def check(path, requested_style):
    sections = build_sections(read_blocks(path))
    body = [s for s in sections if not s.is_references]
    entries = [p for s in sections if s.is_references for p in s.paragraphs]
    has_reference_list = any(s.is_references for s in sections)

    author_year, numeric, needed, placeholders, claims = [], [], [], [], []
    for section in body:
        for paragraph in section.paragraphs:
            author_year.extend(author_year_citations(paragraph))
            numeric.extend(numeric_citations(paragraph))
            needed.extend((section.title, m.group(1).strip()) for m in CITATION_NEEDED.finditer(paragraph))
            placeholders.extend((section.title, m.group(0)) for m in PLACEHOLDERS.finditer(paragraph))
            claims.extend((section.title, s) for s in split_sentences(paragraph) if unsupported_claim(s))

    style = detect_style(requested_style, author_year, numeric)
    lines, issues = [f'file: {path.name}'], 0
    total = sum(s.words for s in sections)
    reference_words = sum(s.words for s in sections if s.is_references)
    lines.append(f'words: {total} (body {total - reference_words}, references {reference_words})')
    lines.append('sections:')
    lines.extend(f'  {"  " * max(s.level - 1, 0)}{short(s.title, 60)}: {s.words}' for s in sections)
    lines.append(f'citations: {len(author_year)} author-year ({len(set(author_year))} distinct), '
                 f'{len(numeric)} numeric ({len(set(numeric))} distinct); checked as {style or "none found"}')
    lines.append(f'reference list: {len(entries)} entries' if has_reference_list else 'reference list: none found')

    if style and not has_reference_list:
        lines.append('  note: citations could not be matched because the draft has no References heading')
    elif style == 'author-year':
        issues += report_author_year(lines, author_year, entries)
    elif style == 'numeric':
        issues += report_numeric(lines, numeric, entries)
    elif entries:
        issues += len(entries)
        lines.append(f'in references but never cited ({len(entries)}):')
        lines.extend(f'  - {short(e)}' for e in entries)

    lines.append(f'citation-needed markers: {len(needed)}')
    lines.extend(f'  - [{short(title, 40)}] {short(claim) or "(no claim text)"}' for title, claim in needed)
    lines.append(f'placeholders: {len(placeholders)}')
    lines.extend(f'  - [{short(title, 40)}] {token}' for title, token in placeholders)
    lines.append(f'unsupported novelty or readiness claims: {len(claims)}')
    lines.extend(f'  - [{short(title, 40)}] {short(sentence)}' for title, sentence in claims)
    issues += len(claims)

    if issues:
        lines.append(f'result: {issues} issue(s). Fix them from the user\'s sources or a search in this '
                     'conversation; never invent a reference to close a gap, use [citation needed: ...] instead.')
    else:
        lines.append('result: no issues. Tell the user about every citation-needed marker and placeholder.')
    return '\n'.join(lines), issues


def unsupported_claim(sentence):
    if not CLAIMS.search(sentence):
        return False
    supported = (CITATION_NEEDED.search(sentence) or author_year_citations(sentence)
                 or numeric_citations(sentence))
    return not supported


def report_author_year(lines, citations, entries):
    entry_keys = [entry_author_key(e) for e in entries]
    known = {key for key in entry_keys if key}
    cited = set(citations)
    missing = sorted({key for key in citations if key not in known})
    unused = [e for e, key in zip(entries, entry_keys) if key not in cited]
    lines.append(f'cited but not in references ({len(missing)}):')
    lines.extend(f'  - {surname.title()} {year}' for surname, year in missing)
    lines.append(f'in references but never cited ({len(unused)}):')
    lines.extend(f'  - {short(e)}' for e in unused)
    return len(missing) + len(unused)


def report_numeric(lines, citations, entries):
    numbers = entry_numbers(entries)
    known = set(numbers)
    cited = set(citations)
    missing = sorted(n for n in cited if n not in known)
    unused = [(n, e) for n, e in zip(numbers, entries) if n not in cited]
    lines.append(f'cited but not in references ({len(missing)}):')
    lines.extend(f'  - [{n}]' for n in missing)
    lines.append(f'in references but never cited ({len(unused)}):')
    lines.extend(f'  - [{n}] {short(ENTRY_NUMBER.sub("", e, count=1))}' for n, e in unused)
    return len(missing) + len(unused)


def main(argv=None):
    parser = Parser(description='Check citations, markers and claims in an academic draft.')
    parser.add_argument('path', type=Path, help='the draft: .docx, .md or .txt')
    parser.add_argument('--style', choices=['apa', 'ieee', 'numeric'],
                        help='citation style to check; detected from the draft when omitted')
    args = parser.parse_args(argv)
    if not args.path.is_file():
        print(f'error: no file at {args.path}', file=sys.stderr)
        return 1
    try:
        report, issues = check(args.path, args.style)
    except UsageError as error:
        print(f'error: {error}', file=sys.stderr)
        return 1
    print(report)
    return 2 if issues else 0


if __name__ == '__main__':
    sys.exit(main())
