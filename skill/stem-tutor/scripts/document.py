"""Turn a written solution into Word, and PDF when asked, with native Word equations.

    python3 document.py SOLUTION.md OUT.docx [--pdf]

SOLUTION.md is the answer as it would read in the chat: Markdown headings, numbered steps, `$...$`
inline maths and `$$...$$` display maths. pandoc turns the maths into Word equations. The gate
refuses maths Word would show wrongly: `\\(...\\)` or `\\[...\\]` delimiters, `\\ce{}`, and fractions typed
as a/b. With --pdf, LibreOffice converts the Word file beside it.

Exit codes: 0 built and checked, 2 defects listed (nothing delivered should go out), 1 bad arguments.
"""

import argparse
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

from docx import Document
from docx.shared import Cm

MATH = re.compile(r"(?<!\\)\$\$(.+?)(?<!\\)\$\$|(?<!\\)\$(?=\S)(.+?)(?<=\S)(?<!\\)\$", re.S)
UPRIGHT = re.compile(r"\\(?:mathrm|text|operatorname|mathit|textrm)\{[^{}]*\}")
EXPONENT = re.compile(r"\^\{[^{}]*\}")
CODE = re.compile(r"```.*?```|`[^`\n]*`", re.S)
MATH_MODULE = Path("/usr/lib/libreoffice/program/libsmlo.so")


def maths_of(text):
    return [(m.group(1) or m.group(2)).strip() for m in MATH.finditer(CODE.sub("", text))]


def defects_of(text):
    prose = CODE.sub("", text)
    defects = []
    if re.search(r"\\\(|\\\[", prose):
        defects.append("maths written as \\( \\) or \\[ \\]: use $...$ inline and $$...$$ on its own line")
    maths = maths_of(text)
    chem = [latex for latex in maths if "\\ce{" in latex]
    if chem:
        defects.append(f"\\ce{{}} is not supported; write chemistry with \\mathrm{{}}: {chem[0]}")
    slashed = [latex for latex in maths if "/" in EXPONENT.sub("", UPRIGHT.sub("", latex))]
    if slashed:
        defects.append(f"fractions typed with / show as a slash; write \\frac{{a}}{{b}}: {'; '.join(slashed[:5])}")
    return defects, len(maths)


def build(source, out):
    pandoc = shutil.which("pandoc")
    if not pandoc:
        raise RuntimeError("pandoc is not installed")
    result = subprocess.run([pandoc, "-f", "markdown", "-o", str(out), str(source)], capture_output=True,
                            text=True, timeout=120)
    if result.returncode != 0:
        raise RuntimeError(f"pandoc failed: {result.stderr.strip()[:300]}")
    doc = Document(str(out))
    for section in doc.sections:
        section.page_width, section.page_height = Cm(21.0), Cm(29.7)
        section.left_margin = section.right_margin = Cm(2.5)
        section.top_margin = section.bottom_margin = Cm(2.5)
    doc.core_properties.author = doc.core_properties.last_modified_by = "Synapse"
    doc.save(str(out))


def file_checks(out):
    xml = zipfile.ZipFile(out).read("word/document.xml").decode()
    text = "".join(re.findall(r"<w:t[^>]*>([^<]*)</w:t>", xml))
    defects = []
    if re.search(r"(?<!\\)\$\S", text):
        defects.append("some maths stayed as $...$ text: pandoc could not read it; check its LaTeX")
    return defects, xml.count("<m:oMath>") + xml.count("<m:oMath ")


def to_pdf(out):
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from office.soffice import run_soffice

    with tempfile.TemporaryDirectory() as work:
        run_soffice(["--headless", "--convert-to", "pdf", "--outdir", work, str(out)], capture_output=True,
                    text=True, timeout=180)
        made = Path(work) / f"{out.stem}.pdf"
        if not made.exists():
            return None
        pdf = out.with_suffix(".pdf")
        shutil.copyfile(made, pdf)
        return pdf


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("source", type=Path)
    parser.add_argument("out", type=Path)
    parser.add_argument("--pdf", action="store_true")
    try:
        args = parser.parse_args(argv)
    except SystemExit as stop:
        return 0 if stop.code == 0 else 1
    if not args.source.is_file() or args.out.suffix.lower() != ".docx":
        print("usage: document.py SOLUTION.md OUT.docx [--pdf]")
        return 1
    text = args.source.read_text(encoding="utf-8")
    defects, found = defects_of(text)
    if defects:
        print(f"DEFECTS ({len(defects)}), nothing built:")
        print("\n".join(f"  - {defect}" for defect in defects))
        return 2
    try:
        build(args.source, args.out)
    except (RuntimeError, subprocess.TimeoutExpired) as error:
        print(f"error: {error}")
        return 1
    defects, equations = file_checks(args.out)
    lines = [f"file: {args.out}", f"equations: {equations} Word equations from {found} maths fragments"]
    if args.pdf:
        pdf = to_pdf(args.out)
        lines.append(f"pdf: {pdf}" if pdf else "pdf: LibreOffice could not convert the file")
        if pdf and not MATH_MODULE.exists():
            defects.append("this LibreOffice has no Math module, so the PDF lost its equations; deliver the Word file")
    if defects:
        lines += [f"DEFECTS ({len(defects)}):", *(f"  - {defect}" for defect in defects)]
    else:
        lines.append("defects: none")
    print("\n".join(lines))
    return 2 if defects else 0


if __name__ == "__main__":
    sys.exit(main())
