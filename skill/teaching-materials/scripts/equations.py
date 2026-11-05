"""LaTeX maths in spec text, $...$ inline and $$...$$ on its own line, as native Word equations.

Every fragment in a spec is converted in one pandoc call. A fragment pandoc cannot parse stays as
its LaTeX source, and the build report lists it.
"""

import copy
import functools
import re
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path

from lxml import etree

MATH = re.compile(r"(?<!\\)\$\$(.+?)(?<!\\)\$\$|(?<!\\)\$(?=\S)(.+?)(?<=\S)(?<!\\)\$", re.S)
NS = {"m": "http://schemas.openxmlformats.org/officeDocument/2006/math",
      "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}


def pieces(text):
    """Split text into ("text", str) and ("math", (latex, display)) pieces."""
    found, start = [], 0
    for match in MATH.finditer(text):
        if match.start() > start:
            found.append(("text", text[start:match.start()].replace("\\$", "$")))
        display = match.group(1) is not None
        found.append(("math", ((match.group(1) if display else match.group(2)).strip(), display)))
        start = match.end()
    if start < len(text):
        found.append(("text", text[start:].replace("\\$", "$")))
    return found


def fragments(value, found=None):
    """Every maths fragment in a spec, in first-seen order."""
    found = {} if found is None else found
    if isinstance(value, str):
        for kind, piece in pieces(value):
            if kind == "math":
                found.setdefault(piece, None)
    elif isinstance(value, dict):
        for item in value.values():
            fragments(item, found)
    elif isinstance(value, list):
        for item in value:
            fragments(item, found)
    return list(found)


UPRIGHT = re.compile(r"\\(?:mathrm|text|operatorname|mathit|textrm)\{[^{}]*\}")
EXPONENT = re.compile(r"\^\{[^{}]*\}")


def slashed(spec):
    """Fragments with a fraction typed as a/b: Word shows the slash, \\frac{a}{b} stacks it.

    A slash in a unit (\\mathrm{J/K}) or an exponent (8^{2/3}) is how those are written, so it passes.
    """
    return [latex for latex, _ in fragments(spec) if "/" in EXPONENT.sub("", UPRIGHT.sub("", latex))]


def for_spec(spec):
    """Converted fragments for a spec, from one pandoc call however many documents use them."""
    return convert(tuple(fragments(spec)))


def failed(spec):
    """LaTeX of the fragments left as source: pandoc missing, or a fragment it could not parse."""
    return [latex for (latex, _), element in for_spec(spec).items() if element is None]


@functools.lru_cache(maxsize=8)
def convert(found):
    """Map each (latex, display) to an OMML element, or None when it could not be converted."""
    if not found:
        return {}
    pandoc = shutil.which("pandoc")
    if not pandoc:
        return dict.fromkeys(found)
    source = "\n\n".join(f"$${latex}$$" if display else f"${latex}$" for latex, display in found)
    with tempfile.TemporaryDirectory() as work:
        out = Path(work) / "maths.docx"
        result = subprocess.run([pandoc, "-f", "markdown", "-o", str(out)], input=source, text=True,
                                capture_output=True, timeout=120)
        if result.returncode != 0 or not out.exists():
            return dict.fromkeys(found)
        body = etree.fromstring(zipfile.ZipFile(out).read("word/document.xml")).find("w:body", NS)
    paragraphs = body.findall("w:p", NS)
    if len(paragraphs) != len(found):
        return dict.fromkeys(found)
    converted = {}
    for key, paragraph in zip(found, paragraphs):
        maths = paragraph.find("m:oMathPara", NS) if key[1] else paragraph.find("m:oMath", NS)
        if maths is None and key[1]:
            maths = paragraph.find("m:oMath", NS)
        converted[key] = maths
    return converted


def place(paragraph, element, alone):
    """A display equation keeps its own line only when it is the whole text; inside a sentence it goes inline."""
    if not alone and element.tag.endswith("}oMathPara"):
        element = element.find("m:oMath", NS)
    paragraph._p.append(copy.deepcopy(element))
