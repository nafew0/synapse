"""Read a csv/tsv/xlsx/xls sheet into a clean DataFrame, shared by profile_data.py and stats.py.

The DataFrame index is the sheet's own row number (1-based, as Excel shows it), so a
flagged row can be found in the user's file.
"""

import math
import re
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

import pandas as pd

SCAN_ROWS = 25
NUMERIC_SHARE = 0.8
MISSING_TOKENS = {"", "-", "--", "na", "n/a", "nan", "null", "none", "."}
NUMBER = re.compile(r"^[-+]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?%?$")


class DataError(Exception):
    """The file cannot be read as a table (exit 1)."""


@dataclass
class Table:
    data: pd.DataFrame
    sheet: str | None
    sheets: list[str]
    header_row: int
    notes: list[str] = field(default_factory=list)
    mixed: dict[str, list[tuple[int, object]]] = field(default_factory=dict)


def excel_names(path):
    if path.suffix.lower() in (".csv", ".tsv", ".txt"):
        return []
    return list(pd.ExcelFile(path).sheet_names)


def convert_xls(path):
    """Fall back to LibreOffice when xlrd is missing, using the xlsx skill's helper."""
    helper = Path(__file__).resolve().parents[2] / "xlsx" / "scripts"
    if not (helper / "office" / "soffice.py").exists():
        raise DataError("cannot read .xls here: xlrd is missing and the xlsx skill's soffice helper was not found")
    sys.path.insert(0, str(helper))
    from office.soffice import run_soffice

    work = Path(tempfile.mkdtemp())
    run_soffice(["--headless", "--convert-to", "xlsx", "--outdir", str(work), str(path)], capture_output=True, timeout=120)
    converted = work / (path.stem + ".xlsx")
    if not converted.exists():
        raise DataError(f"could not convert {path.name} to .xlsx")
    return converted


def read_raw(path, sheet):
    suffix = path.suffix.lower()
    if suffix in (".csv", ".tsv", ".txt"):
        sep = "\t" if suffix == ".tsv" else None
        for encoding in ("utf-8-sig", "cp1252"):
            try:
                return pd.read_csv(path, header=None, dtype=object, sep=sep, engine="python", encoding=encoding, skip_blank_lines=False), None
            except UnicodeDecodeError:
                continue
        raise DataError(f"cannot decode {path.name}")
    if suffix == ".xls":
        try:
            return pd.read_excel(path, sheet_name=sheet or 0, header=None, dtype=object), sheet
        except ImportError:
            path = convert_xls(path)
    names = excel_names(path)
    if sheet is not None and sheet not in names:
        raise DataError(f"no sheet named {sheet!r}; sheets: {', '.join(names)}")
    chosen = sheet or names[0]
    return pd.read_excel(path, sheet_name=chosen, header=None, dtype=object), chosen


def blank(value):
    if value is None:
        return True
    if isinstance(value, float) and math.isnan(value):
        return True
    return isinstance(value, str) and value.strip().lower() in MISSING_TOKENS


def find_header(raw):
    head = raw.head(SCAN_ROWS)
    counts = [sum(not blank(v) for v in row) for row in head.itertuples(index=False)]
    width = max(counts, default=0)
    if width == 0:
        raise DataError("the sheet is empty")
    needed = max(2, math.ceil(width * 0.5)) if width > 1 else 1
    dense = [i for i, count in enumerate(counts) if count >= needed]
    labels = [i for i in dense if wordy(head.iloc[i])]
    if not labels:
        return dense[0]
    row = labels[0]
    if row + 1 < len(counts) and counts[row + 1] > counts[row] and wordy(head.iloc[row + 1]):
        return row + 1
    return row


def wordy(row):
    values = [v for v in row if not blank(v)]
    return bool(values) and sum(isinstance(v, str) for v in values) >= 0.6 * len(values)


def header_names(raw, row, notes):
    names = [None if blank(v) else str(v).strip() for v in raw.iloc[row]]
    parent = [None if blank(v) else str(v).strip() for v in raw.iloc[row - 1]] if row > 0 else []
    if parent and any(parent) and sum(p is not None for p in parent) < sum(n is not None for n in names):
        filled, last = [], None
        for value in parent:
            last = value if value is not None else last
            filled.append(last)
        groups = sorted({p for p in parent if p})
        notes.append(f"row {row} looks like a merged group header ({', '.join(groups[:6])}); column names come from row {row + 1}")
        repeated = {n for n in names if n and names.count(n) > 1}
        if repeated:
            names = [f"{p} {n}" if p and n in repeated else n for p, n in zip(filled, names)]
            notes.append("repeated names were prefixed with their group header")
    seen = {}
    result = []
    for position, name in enumerate(names):
        name = name or f"Column{position + 1}"
        if name in seen:
            seen[name] += 1
            name = f"{name}_{seen[name]}"
        else:
            seen[name] = 0
        result.append(name)
    return result


def to_number(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if not isinstance(value, str):
        return None
    text = value.strip().replace(" ", "")
    if not text or not NUMBER.match(text) or text in ("%", "."):
        return None
    scale = 100.0 if text.endswith("%") else 1.0
    try:
        return float(text.rstrip("%").replace(",", "")) / scale
    except ValueError:
        return None


def coerce(series):
    present = series[~series.map(blank)]
    if present.empty:
        return series.where(False), []
    if pd.api.types.is_datetime64_any_dtype(present) or all(isinstance(v, pd.Timestamp) for v in present):
        return pd.to_datetime(series.where(~series.map(blank)), errors="coerce"), []
    numbers = present.map(to_number)
    parsed = numbers.notna()
    if parsed.mean() < NUMERIC_SHARE:
        return series.where(~series.map(blank)), []
    bad = [(int(i), v) for i, v in present[~parsed].items()]
    return series.map(lambda v: None if blank(v) else to_number(v)).astype(float), bad


def load(path, sheet=None, header_row=None):
    path = Path(path)
    if not path.exists():
        raise DataError(f"file not found: {path}")
    raw, chosen = read_raw(path, sheet)
    sheets = excel_names(path) if path.suffix.lower() in (".xlsx", ".xlsm") else ([chosen] if chosen else [])
    raw.index = range(1, len(raw) + 1)
    if header_row is not None:
        if not 1 <= header_row <= len(raw):
            raise DataError(f"--header-row {header_row} is outside the sheet (1..{len(raw)})")
        row = header_row - 1
    else:
        row = find_header(raw)
    notes = []
    if row > 0:
        notes.append(f"header found on row {row + 1}; rows above it were skipped")
    columns = header_names(raw, row, notes)
    body = raw.iloc[row + 1:].copy()
    body.columns = columns
    empty_rows = body.apply(lambda r: all(blank(v) for v in r), axis=1)
    body = body[~empty_rows]
    empty_cols = [c for c in body.columns if body[c].map(blank).all()]
    if empty_cols:
        unnamed = [c for c in empty_cols if re.fullmatch(r"Column\d+", c)]
        body = body.drop(columns=unnamed)
        if len(unnamed) < len(empty_cols):
            notes.append(f"empty columns: {', '.join(c for c in empty_cols if c not in unnamed)}")
    mixed = {}
    for name in body.columns:
        body[name], bad = coerce(body[name])
        if bad:
            mixed[name] = bad
    return Table(body, chosen, sheets, row + 1, notes, mixed)

