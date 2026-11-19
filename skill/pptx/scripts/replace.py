"""Change text in a Word or PowerPoint file in one call, leaving everything else as it was.

    python3 replace.py <in> <out> "old text" "new text" ["old 2" "new 2" ...] [--expect N]

Matches a phrase even when formatting splits it across runs; the new text takes the
formatting of the run where the phrase starts. Covers the body, tables, headers, footers,
footnotes and text boxes (Word), and slides and their notes (PowerPoint). Then validates the
file. Prints how many times each phrase was replaced. Exit 0 when every phrase matched and the
file is valid, 2 otherwise; nothing is written when a phrase is missing. --expect N fails unless
each phrase matches exactly N times. <in> and <out> may be the same file.
"""

import argparse
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

from lxml import etree

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"
FORMATS = {
    ".docx": (re.compile(r"word/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$"), f"{{{W}}}p", f"{{{W}}}t"),
    ".pptx": (re.compile(r"ppt/(slides/slide|notesSlides/notesSlide)\d+\.xml$"), f"{{{A}}}p", f"{{{A}}}t"),
}


def replace_in_paragraph(paragraph, text_tag, old, new):
    """Replace every `old` across this paragraph's text nodes. Returns the count."""
    count = 0
    start = 0
    while True:
        # Nested paragraphs (a text box inside a run) are handled on their own.
        nodes = [n for n in paragraph.iter(text_tag) if nearest_paragraph(n, paragraph.tag) is paragraph]
        joined = "".join(n.text or "" for n in nodes)
        at = joined.find(old, start)
        if at < 0:
            return count
        end = at + len(old)
        position = 0
        placed = False
        for node in nodes:
            text = node.text or ""
            low, high = position, position + len(text)
            position = high
            if high <= at or low >= end:
                continue
            before = text[: max(0, at - low)]
            after = text[max(0, end - low) :] if end < high else ""
            node.text = before + (new if not placed else "") + after
            placed = True
            if text_tag.endswith("}t") and text_tag.startswith(f"{{{W}"):
                node.set(XML_SPACE, "preserve")
        count += 1
        start = at + len(new)


def nearest_paragraph(node, paragraph_tag):
    parent = node.getparent()
    while parent is not None and parent.tag != paragraph_tag:
        parent = parent.getparent()
    return parent


def apply(path, pairs):
    parts, paragraph_tag, text_tag = FORMATS[path.suffix.lower()]
    counts = [0] * len(pairs)
    changed = {}
    with zipfile.ZipFile(path) as archive:
        for name in archive.namelist():
            if not parts.match(name):
                continue
            root = etree.fromstring(archive.read(name))
            touched = False
            for paragraph in root.iter(paragraph_tag):
                for index, (old, new) in enumerate(pairs):
                    found = replace_in_paragraph(paragraph, text_tag, old, new)
                    if found:
                        counts[index] += found
                        touched = True
            if touched:
                changed[name] = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
    return counts, changed


def write(source, output, changed):
    with zipfile.ZipFile(source) as archive, tempfile.NamedTemporaryFile(suffix=source.suffix, delete=False) as handle:
        temporary = handle.name
        with zipfile.ZipFile(temporary, "w") as out:
            for info in archive.infolist():
                data = changed.get(info.filename)
                out.writestr(info, data if data is not None else archive.read(info.filename))
    shutil.move(temporary, output)


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("pairs", nargs="+", help="old text, new text, ...")
    parser.add_argument("--expect", type=int)
    args = parser.parse_args(argv)
    if len(args.pairs) % 2:
        print("error: give pairs of old text and new text")
        return 1
    if args.source.suffix.lower() not in FORMATS:
        print("error: only .docx and .pptx files; use the xlsx skill's cells.py for workbooks")
        return 1
    pairs = list(zip(args.pairs[::2], args.pairs[1::2]))
    counts, changed = apply(args.source, pairs)
    failed = False
    for (old, new), count in zip(pairs, counts):
        wrong = count == 0 or (args.expect is not None and count != args.expect)
        failed = failed or wrong
        print(f"{'NOT MATCHED' if count == 0 else 'WRONG COUNT' if wrong else 'replaced'} {count}x: {old!r} -> {new!r}")
    if failed:
        print("nothing written. Read the exact text with outline.py and try again.")
        return 2
    write(args.source, args.output, changed)
    validator = Path(__file__).resolve().parent / "office" / "validate.py"
    result = subprocess.run([sys.executable, str(validator), str(args.output)], capture_output=True, text=True)
    if result.returncode != 0:
        print("validation: FAILED\n" + "\n".join((result.stdout + result.stderr).strip().splitlines()[-8:]))
        return 2
    print(f"validation: passed\nfile: {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
