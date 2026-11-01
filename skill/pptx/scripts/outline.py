"""Show a deck's structure in one call, slide by slide.

    python3 outline.py <deck.pptx> [--limit 400]

Prints each slide's layout and shapes with their kind, position in inches and text, and the
speaker notes. Use it instead of writing inspection code.
"""

import argparse
import sys
from pathlib import Path

from pptx import Presentation


def describe(shape):
    position = ""
    if shape.left is not None and shape.top is not None:
        position = f" at {shape.left / 914400:.1f},{shape.top / 914400:.1f} size {shape.width / 914400:.1f}x{shape.height / 914400:.1f}"
    text = shape.text_frame.text.replace("\n", " / ") if shape.has_text_frame else ""
    if getattr(shape, "has_table", False) and shape.has_table:
        text = " || ".join(" | ".join(c.text for c in row.cells) for row in shape.table.rows)
    return f"  {shape.name} [{shape.shape_type}]{position}: {text}" if text else f"  {shape.name} [{shape.shape_type}]{position}"


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("path", type=Path)
    parser.add_argument("--limit", type=int, default=400, help="most lines to print")
    args = parser.parse_args(argv)
    deck = Presentation(str(args.path))
    lines = []
    for number, slide in enumerate(deck.slides, 1):
        lines.append(f"slide {number} [{slide.slide_layout.name}]")
        lines.extend(describe(shape) for shape in slide.shapes)
        if slide.has_notes_slide and slide.notes_slide.notes_text_frame is not None and slide.notes_slide.notes_text_frame.text.strip():
            lines.append("  notes: " + slide.notes_slide.notes_text_frame.text.replace("\n", " / "))
    print(f"{args.path.name}: {len(deck.slides)} slides, {deck.slide_width / 914400:.2f} x {deck.slide_height / 914400:.2f} in")
    print("\n".join(lines[: args.limit]))
    if len(lines) > args.limit:
        print(f"... {len(lines) - args.limit} more lines; raise --limit to see them")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
