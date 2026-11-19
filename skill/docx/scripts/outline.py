"""Show a Word document's structure in one call, numbered so you can refer to it.

    python3 outline.py <file.docx> [--limit 400]

Prints body paragraphs with their style, tables with row and column counts and cell text,
headers, footers and the number of pictures. Use it instead of writing inspection code.
"""

import argparse
import sys
from pathlib import Path

from docx import Document
from docx.table import Table
from docx.text.paragraph import Paragraph


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("path", type=Path)
    parser.add_argument("--limit", type=int, default=400, help="most lines to print")
    args = parser.parse_args(argv)
    document = Document(str(args.path))
    lines = []
    para = table = 0
    for block in document.iter_inner_content():
        if isinstance(block, Paragraph):
            para += 1
            if block.text.strip():
                lines.append(f"P{para} [{block.style.name}] {block.text}")
        elif isinstance(block, Table):
            table += 1
            lines.append(f"T{table} table, {len(block.rows)} rows x {len(block.columns)} columns")
            for r, row in enumerate(block.rows, 1):
                cells = [cell.text.strip().replace("\n", " / ") for cell in row.cells]
                lines.append(f"  R{r}: " + " | ".join(cells))
    for number, section in enumerate(document.sections, 1):
        for label, part in (("header", section.header), ("footer", section.footer)):
            text = " / ".join(p.text for p in part.paragraphs if p.text.strip())
            if text:
                lines.append(f"section {number} {label}: {text}")
    section = document.sections[0]
    print(f"{args.path.name}: {para} paragraphs, {table} tables, {len(document.inline_shapes)} inline pictures, "
          f"{len(document.sections)} section(s), page {section.page_width.cm:.1f} x {section.page_height.cm:.1f} cm")
    print("\n".join(lines[: args.limit]))
    if len(lines) > args.limit:
        print(f"... {len(lines) - args.limit} more lines; raise --limit to see them")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
