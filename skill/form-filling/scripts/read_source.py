"""Read a spreadsheet as a form's data source: every filled cell as it is displayed, with its address.

Usage: python read_source.py DATA.xlsx|.xlsm|.xls|.csv|.tsv [--sheet NAME] [--find TEXT] [--out cells.json]

Prints each sheet as rows of "B4=value" so a value can be cited as "staff.xlsx, Sheet1!B4".
--find keeps only the data rows holding TEXT (ignoring case), plus the sheet's first row as its header.

Exit codes: 0 read, 2 read with something to check (formulas with no stored result, --find matched
nothing or several rows), 1 bad arguments or an unreadable file.
"""

import argparse
import csv
import datetime
import json
import re
import sys
from pathlib import Path

DATE_PARTS = [("yyyy", "%Y"), ("yy", "%y"), ("mmmm", "%B"), ("mmm", "%b"), ("mm", "%m"), ("dd", "%d"),
              ("hh", "%H"), ("ss", "%S")]
SECTION = re.compile(r'"[^"]*"|\[[^\]]*\]|\\.')


def date_text(value, number_format):
    """The date as its cell format shows it; an unrecognised format falls back to dd.mm.yyyy."""
    pattern = SECTION.sub("", (number_format or "").split(";")[0]).lower()
    if not re.search(r"[dy]", pattern) and isinstance(value, datetime.datetime) and value.time() != datetime.time():
        return value.strftime("%H:%M")
    if not re.search(r"[dy]", pattern):
        return value.strftime("%d.%m.%Y")
    result, index = "", 0
    while index < len(pattern):
        for token, code in DATE_PARTS:
            if pattern.startswith(token, index):
                result += code
                index += len(token)
                break
        else:
            single = {"d": "%-d", "m": "%-m"}.get(pattern[index])
            result += single or pattern[index].replace("%", "%%")
            index += 1
    return value.strftime(result).strip(" -/.")


def number_text(value, number_format):
    """The number as its cell format shows it: decimals, thousands, percent and leading zeros."""
    fmt = SECTION.sub("", (number_format or "General").split(";")[0])
    if fmt.lower() in ("general", "@", ""):
        return str(int(value)) if float(value).is_integer() else repr(round(float(value), 10))
    percent = "%" in fmt
    shown = float(value) * 100 if percent else float(value)
    decimals = len(fmt.split(".")[1].rstrip("%").replace(" ", "")) if "." in fmt else 0
    grouped = "," in fmt.split(".")[0]
    text = f"{shown:,.{decimals}f}" if grouped else f"{shown:.{decimals}f}"
    zeros = len(re.fullmatch(r"0+", fmt).group()) if re.fullmatch(r"0+", fmt) else 0
    return text.zfill(zeros) + ("%" if percent else "")


def cell_text(value, number_format):
    if value is None:
        return ""
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (datetime.datetime, datetime.date)):
        return date_text(value, number_format)
    if isinstance(value, datetime.time):
        return value.strftime("%H:%M")
    if isinstance(value, (int, float)):
        return number_text(value, number_format)
    return str(value).strip()


def read_xlsx(path):
    from openpyxl import load_workbook
    from openpyxl.utils import get_column_letter

    values = load_workbook(path, data_only=True)
    formulas = load_workbook(path, data_only=False)
    sheets = []
    for sheet in values.worksheets:
        merged = {cell: str(rng) for rng in sheet.merged_cells.ranges for cell in [rng.coord.split(":")[0]]}
        rows, missing = [], []
        for row in sheet.iter_rows():
            cells = []
            for cell in row:
                address = f"{get_column_letter(cell.column)}{cell.row}"
                raw = formulas[sheet.title][address].value
                if cell.value is None and isinstance(raw, str) and raw.startswith("="):
                    missing.append(address)
                    continue
                text = cell_text(cell.value, cell.number_format)
                if text:
                    cells.append({"cell": address, "value": text})
            if cells:
                rows.append(cells)
        hidden_rows = [n for n, d in sheet.row_dimensions.items() if d.hidden]
        hidden_cols = [c for c, d in sheet.column_dimensions.items() if d.hidden]
        sheets.append({"sheet": sheet.title, "hidden": sheet.sheet_state != "visible", "rows": rows,
                       "merged": sorted(merged.values()), "no_result": missing,
                       "hidden_rows": hidden_rows, "hidden_columns": hidden_cols})
    return sheets


def read_xls(path):
    import xlrd
    from openpyxl.utils import get_column_letter

    book = xlrd.open_workbook(path, formatting_info=False)
    sheets = []
    for sheet in book.sheets():
        rows = []
        for r in range(sheet.nrows):
            cells = []
            for c in range(sheet.ncols):
                cell = sheet.cell(r, c)
                if cell.ctype == xlrd.XL_CELL_DATE:
                    text = xlrd.xldate_as_datetime(cell.value, book.datemode).strftime("%d.%m.%Y")
                else:
                    text = cell_text(cell.value if cell.ctype != xlrd.XL_CELL_EMPTY else None, "General")
                if text:
                    cells.append({"cell": f"{get_column_letter(c + 1)}{r + 1}", "value": text})
            if cells:
                rows.append(cells)
        sheets.append({"sheet": sheet.name, "hidden": False, "rows": rows, "merged": [], "no_result": [],
                       "hidden_rows": [], "hidden_columns": []})
    return sheets


def read_delimited(path, delimiter):
    from openpyxl.utils import get_column_letter

    with open(path, newline="", encoding="utf-8-sig") as handle:
        rows = [[{"cell": f"{get_column_letter(c + 1)}{r + 1}", "value": text.strip()}
                 for c, text in enumerate(row) if text.strip()] for r, row in enumerate(csv.reader(handle, delimiter=delimiter))]
    return [{"sheet": Path(path).name, "hidden": False, "rows": [row for row in rows if row], "merged": [],
             "no_result": [], "hidden_rows": [], "hidden_columns": []}]


def read_source(path):
    suffix = Path(path).suffix.lower()
    if suffix in (".xlsx", ".xlsm"):
        return read_xlsx(path)
    if suffix == ".xls":
        return read_xls(path)
    if suffix in (".csv", ".tsv"):
        return read_delimited(path, "\t" if suffix == ".tsv" else ",")
    raise ValueError(f"not a spreadsheet: {path}")


def keep_matches(sheet, wanted):
    """Rows holding the text, plus the first row as the header when it is not one of them."""
    header, data = sheet["rows"][:1], sheet["rows"][1:]
    matches = [row for row in data if any(wanted.lower() in cell["value"].lower() for cell in row)]
    return {**sheet, "rows": header + matches, "matches": len(matches)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("source")
    parser.add_argument("--sheet")
    parser.add_argument("--find")
    parser.add_argument("--out")
    try:
        args = parser.parse_args(argv)
    except SystemExit as stop:
        return 0 if stop.code == 0 else 1
    try:
        sheets = read_source(args.source)
    except Exception as error:
        print(f"cannot read {args.source}: {error}")
        return 1
    if args.sheet:
        sheets = [sheet for sheet in sheets if sheet["sheet"] == args.sheet]
        if not sheets:
            print(f"no sheet named {args.sheet!r}")
            return 1
    warned = False
    if args.find:
        sheets = [keep_matches(sheet, args.find) for sheet in sheets]
        total = sum(sheet["matches"] for sheet in sheets)
        if total != 1:
            print(f"WARNING: {args.find!r} matches {total} rows; " + ("ask which one." if total else "check the spelling."))
            warned = True
    for sheet in sheets:
        hidden = " (hidden sheet)" if sheet["hidden"] else ""
        print(f"Sheet {sheet['sheet']!r}{hidden}: {len(sheet['rows'])} rows")
        for row in sheet["rows"]:
            print("  " + " | ".join(f"{cell['cell']}={cell['value']}" for cell in row))
        if sheet["no_result"]:
            warned = True
            print(f"  WARNING: formulas with no stored result (open and save in Excel): {', '.join(sheet['no_result'][:20])}")
        if sheet["hidden_rows"] or sheet["hidden_columns"]:
            print(f"  note: hidden rows {sheet['hidden_rows'][:20]}, hidden columns {sheet['hidden_columns'][:20]} are included above")
    if args.out:
        Path(args.out).write_text(json.dumps(sheets, ensure_ascii=False, indent=1), encoding="utf-8")
    return 2 if warned else 0


if __name__ == "__main__":
    sys.exit(main())
