"""Show a workbook's structure in one call, with cell addresses.

    python3 outline.py <file.xlsx> [--sheet NAME] [--limit 400]

Prints what an openpyxl save would damage, then each sheet's size, merged ranges, frozen panes,
and every filled cell with its address, formula, computed value, number format, bold and fill.
Use it instead of writing inspection code.
"""

import argparse
import sys
import warnings
from pathlib import Path

from openpyxl import load_workbook

sys.path.insert(0, str(Path(__file__).resolve().parent))
from preflight import inspect as preflight  # noqa: E402


def style_note(cell):
    """What sets this cell apart, so a neighbour's look can be copied without another read."""
    notes = []
    if cell.number_format != "General":
        notes.append(cell.number_format)
    if cell.font.b:
        notes.append("bold")
    if cell.fill.fill_type:
        notes.append(f"fill {cell.fill.fgColor.rgb if isinstance(cell.fill.fgColor.rgb, str) else 'theme'}")
    return f"  [{', '.join(notes)}]" if notes else ""


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("path", type=Path)
    parser.add_argument("--sheet")
    parser.add_argument("--limit", type=int, default=400, help="most cells to print per sheet")
    args = parser.parse_args(argv)
    warnings.simplefilter("ignore")
    _, findings, unsafe = preflight(args.path)
    for label, count, _ in findings:
        print(f"- {label}: {count}")
    print(f"openpyxl save: {'UNSAFE' if unsafe else 'avoid unless adding rows, columns or sheets'}; write cells with cells.py")
    formulas = load_workbook(args.path, rich_text=True)
    values = load_workbook(args.path, data_only=True)
    for ws in formulas:
        if args.sheet and ws.title != args.sheet:
            continue
        merged = sorted(str(r) for r in ws.merged_cells.ranges)
        print(f"\n## {ws.title} {ws.dimensions} state={ws.sheet_state} frozen={ws.freeze_panes} merged({len(merged)}): {', '.join(merged[:40])}")
        shown = total = 0
        for row in ws.iter_rows():
            for cell in row:
                if cell.value is None:
                    continue
                total += 1
                if shown >= args.limit:
                    continue
                shown += 1
                text = str(cell.value)
                if text.startswith("="):
                    text += f"  -> {values[ws.title][cell.coordinate].value!r}"
                print(f"{cell.coordinate}: {text}{style_note(cell)}")
        if total > shown:
            print(f"... {total - shown} more cells; raise --limit or use --sheet")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
