"""Profile a data file before analysing it.

    python3 profile_data.py IN [--sheet NAME] [--header-row N]

Reads csv/tsv/xlsx/xls, finds the header row (skipping title rows and merged group headers),
and prints one line per column: type, n, missing, unique, min/max/mean for numbers and the
top values for text. Exit 0 clean, 2 data problems found (mixed types, more than 20% missing,
empty columns), 1 the file could not be read or bad arguments.
"""

import argparse
import sys

import pandas as pd

from load import DataError, load

MISSING_LIMIT = 0.2


class Parser(argparse.ArgumentParser):
    def error(self, message):
        self.print_usage(sys.stderr)
        print(f"error: {message}", file=sys.stderr)
        sys.exit(1)


def kind(series, mixed):
    if series.notna().sum() == 0:
        return "empty"
    if pd.api.types.is_datetime64_any_dtype(series):
        return "date"
    if pd.api.types.is_numeric_dtype(series):
        return "mixed" if mixed else "numeric"
    return "text"


def number(value):
    return f"{value:,.4g}" if abs(value) < 1e6 else f"{value:,.0f}"


def describe(name, series, mixed):
    total = len(series)
    present = series.dropna()
    missing = total - len(present)
    column_kind = kind(series, mixed)
    line = f"- {name} [{column_kind}] n={len(present)} missing={missing} ({missing / total:.0%}) unique={present.nunique()}"
    if column_kind in ("numeric", "mixed"):
        line += f" min={number(present.min())} max={number(present.max())} mean={number(present.mean())}"
    elif column_kind == "date":
        line += f" from={present.min():%Y-%m-%d} to={present.max():%Y-%m-%d}"
    elif column_kind == "text":
        top = present.astype(str).value_counts().head(3)
        line += " top: " + ", ".join(f"{value!r} ({count})" for value, count in top.items())
    if mixed:
        sample = ", ".join(f"row {row}: {value!r}" for row, value in mixed[:3])
        line += f" | {len(mixed)} non-numeric: {sample}"
    return line, column_kind, missing / total if total else 0


def main():
    parser = Parser(description=__doc__.split("\n")[0])
    parser.add_argument("input")
    parser.add_argument("--sheet")
    parser.add_argument("--header-row", type=int, help="1-based row holding the column names, when detection is wrong")
    args = parser.parse_args()
    try:
        table = load(args.input, args.sheet, args.header_row)
    except (DataError, ValueError, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1

    data = table.data
    print(f"file: {args.input}")
    if table.sheets:
        print(f"sheets: {', '.join(table.sheets)} | profiled: {table.sheet}")
    print(f"header row: {table.header_row} | data rows: {len(data)} (rows {data.index.min()}-{data.index.max()}) | columns: {data.shape[1]}")
    for note in table.notes:
        print(f"note: {note}")

    problems = []
    print("columns:")
    for name in data.columns:
        line, column_kind, missing_share = describe(name, data[name], table.mixed.get(name, []))
        print(line)
        if column_kind == "mixed":
            problems.append(f"{name}: numbers mixed with text; those cells are treated as missing")
        if column_kind == "empty":
            problems.append(f"{name}: no values")
        elif missing_share > MISSING_LIMIT:
            problems.append(f"{name}: {missing_share:.0%} missing")
    duplicates = data.index[data.duplicated(keep="first")]
    if len(duplicates):
        print(f"note: {len(duplicates)} duplicate rows (first at row {duplicates[0]})")

    if problems:
        print("problems:")
        for problem in problems:
            print(f"- {problem}")
        return 2
    print("problems: none")
    return 0


if __name__ == "__main__":
    sys.exit(main())
