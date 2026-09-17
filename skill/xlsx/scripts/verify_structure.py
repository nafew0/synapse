#!/usr/bin/env python3
"""Verify that editing a workbook changed only the cells the edit was meant to change.

Compares the user's original file with the edited output and fails when anything outside the
declared edit ranges differs: sheets, merged ranges, column widths, row heights, data validation,
conditional formatting, images and charts, or any cell's value or formatting.

Usage:
    python verify_structure.py ORIGINAL OUTPUT --allow 'Sheet 2!B12:D14' --allow 'Sheet 2!A19'

Ranges accept a cell (A1), a block (A1:D9), whole rows (12:14) or whole columns (B:D). Quote the
sheet name or not: 'Sheet 2'!A1 and Sheet 2!A1 are both accepted.

Prints JSON and exits 0 on success, 2 when unexpected changes are found, 1 on bad input.
"""
import argparse
import json
import re
import sys
import zipfile
from pathlib import Path

from openpyxl import load_workbook
from openpyxl.utils.cell import column_index_from_string, coordinate_from_string
from openpyxl.utils.exceptions import CellCoordinatesException

DEFAULT_COLUMN_WIDTH = 8.43
DEFAULT_ROW_HEIGHT = 15.0
COLUMN_WIDTH_TOLERANCE = 0.75
# LibreOffice stores row heights in 0.75pt steps, so a re-save shifts them by up to that much.
ROW_HEIGHT_TOLERANCE = 1.0
RANGE_OPERATORS = {'between', 'notBetween'}
MAX_ISSUES = 100
UNBOUNDED = 1_048_576


class InputError(Exception):
    pass


def parse_allow(spec):
    """Turn "Sheet!RANGE" into (sheet, min_col, min_row, max_col, max_row)."""
    if '!' not in spec:
        raise InputError(f"--allow must name the sheet, e.g. 'Sheet 2!B12:D14': {spec}")
    sheet, ref = spec.rsplit('!', 1)
    sheet = sheet.strip().strip("'")
    ref = ref.strip().replace('$', '').upper()
    if not sheet or not ref:
        raise InputError(f'Invalid --allow range: {spec}')
    start, _, end = ref.partition(':')
    end = end or start
    try:
        if start.isdigit() and end.isdigit():
            return sheet, 1, int(start), UNBOUNDED, int(end)
        if start.isalpha() and end.isalpha():
            return sheet, column_index_from_string(start), 1, column_index_from_string(end), UNBOUNDED
        start_col, start_row = coordinate_from_string(start)
        end_col, end_row = coordinate_from_string(end)
    except (ValueError, CellCoordinatesException) as error:
        raise InputError(f'Invalid --allow range {spec}: {error}') from error
    min_col, max_col = sorted((column_index_from_string(start_col), column_index_from_string(end_col)))
    min_row, max_row = sorted((start_row, end_row))
    return sheet, min_col, min_row, max_col, max_row


def is_allowed(allowed, sheet, row, column):
    return any(
        name == sheet and min_col <= column <= max_col and min_row <= row <= max_row
        for name, min_col, min_row, max_col, max_row in allowed
    )


def color_key(color):
    """Compare colors by meaning: an ARGB value's alpha byte is rewritten on a LibreOffice save."""
    if color is None:
        return None
    if color.type == 'rgb' and isinstance(color.rgb, str):
        return color.rgb[-6:].upper()
    if color.type == 'theme':
        return f'theme:{color.theme}:{round(color.tint or 0, 4)}'
    if color.type == 'indexed':
        return f'indexed:{color.indexed}'
    return None


def style_key(cell):
    font, fill, border, alignment = cell.font, cell.fill, cell.border, cell.alignment
    fill_key = None
    if fill is not None and fill.fill_type:
        fill_key = (fill.fill_type, color_key(fill.fgColor))
    return (
        (font.name, float(font.sz or 0), bool(font.b), bool(font.i), font.u, bool(font.strike), color_key(font.color)),
        fill_key,
        tuple(
            (side.style, color_key(side.color) if side.style else None)
            for side in (border.left, border.right, border.top, border.bottom)
        ),
        # An unset alignment and Excel's defaults render the same; LibreOffice writes the defaults out.
        (alignment.horizontal or 'general', alignment.vertical or 'bottom', bool(alignment.wrap_text), alignment.indent or 0),
        cell.number_format,
    )


def value_key(value):
    if value is None or value == '':
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return round(float(value), 9)
    return value


def media_counts(path):
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
    return {
        'images': sum(1 for name in names if name.startswith('xl/media/')),
        'charts': sum(1 for name in names if re.match(r'xl/charts/chart\d+\.xml$', name)),
        'drawings': sum(1 for name in names if re.match(r'xl/drawings/drawing\d+\.xml$', name)),
    }


def dimension_changes(kind, original, output, default, tolerance):
    """Differences that exceed tolerance; an unset size counts as the sheet default."""
    changes = []
    for key in sorted(set(original) | set(output), key=str):
        before = original.get(key) or default
        after = output.get(key) or default
        if abs(before - after) > tolerance:
            changes.append(f'{kind} {key}: {before} -> {after}')
    return changes


def compare_sheet(name, before, after, allowed, report):
    before_merges = {str(r) for r in before.merged_cells.ranges}
    after_merges = {str(r) for r in after.merged_cells.ranges}
    for ref in sorted(before_merges - after_merges):
        report('unmerged', name, f'merged range {ref} was removed')
    for ref in sorted(after_merges - before_merges):
        report('merged', name, f'merged range {ref} was added')

    widths = dimension_changes(
        'column',
        {k: v.width for k, v in before.column_dimensions.items() if v.width},
        {k: v.width for k, v in after.column_dimensions.items() if v.width},
        DEFAULT_COLUMN_WIDTH,
        COLUMN_WIDTH_TOLERANCE,
    )
    heights = dimension_changes(
        'row',
        {k: v.height for k, v in before.row_dimensions.items() if v.height},
        {k: v.height for k, v in after.row_dimensions.items() if v.height},
        before.sheet_format.defaultRowHeight or DEFAULT_ROW_HEIGHT,
        ROW_HEIGHT_TOLERANCE,
    )
    for detail in widths + heights:
        report('dimension', name, detail)

    def validations(ws):
        # Only "between" rules read a second bound; LibreOffice fills in an unused one on save.
        return {
            (dv.type, dv.operator, str(dv.sqref), dv.formula1, dv.formula2 if dv.operator in RANGE_OPERATORS else None)
            for dv in ws.data_validations.dataValidation
        }

    if validations(before) != validations(after):
        report('data_validation', name, 'data validation rules changed')

    def conditional(ws):
        return {(str(rng.sqref), len(rng.rules)) for rng in ws.conditional_formatting}

    if conditional(before) != conditional(after):
        report('conditional_formatting', name, 'conditional formatting changed')

    coordinates = {(c.row, c.column) for c in before._cells.values()} | {
        (c.row, c.column) for c in after._cells.values()
    }
    checked = changed_in_allowed = 0
    for row, column in sorted(coordinates):
        old, new = before.cell(row=row, column=column), after.cell(row=row, column=column)
        value_changed = value_key(old.value) != value_key(new.value)
        style_changed = style_key(old) != style_key(new)
        if is_allowed(allowed, name, row, column):
            changed_in_allowed += int(value_changed or style_changed)
            continue
        checked += 1
        if value_changed:
            report('value', name, f'{old.coordinate}: {old.value!r} -> {new.value!r}')
        elif style_changed:
            report('style', name, f'{old.coordinate}: formatting changed')
    return checked, changed_in_allowed, len(before_merges)


def verify(original, output, allowed):
    issues = []

    def report(kind, sheet, detail):
        issues.append({'kind': kind, 'sheet': sheet, 'detail': detail})

    before_wb = load_workbook(original)
    after_wb = load_workbook(output)
    unknown = {sheet for sheet, *_ in allowed} - set(before_wb.sheetnames)
    if unknown:
        raise InputError(f'--allow names sheets that are not in the original: {sorted(unknown)}')
    if before_wb.sheetnames != after_wb.sheetnames:
        report('sheets', None, f'sheets {before_wb.sheetnames} -> {after_wb.sheetnames}')

    before_media, after_media = media_counts(original), media_counts(output)
    for kind, count in before_media.items():
        if after_media[kind] < count:
            report('media', None, f'{kind}: {count} in the original, {after_media[kind]} in the output')

    cells_checked = allowed_changes = merges_checked = 0
    for name in before_wb.sheetnames:
        if name not in after_wb.sheetnames:
            continue
        checked, changed, merges = compare_sheet(name, before_wb[name], after_wb[name], allowed, report)
        cells_checked += checked
        allowed_changes += changed
        merges_checked += merges

    return {
        'status': 'changes_found' if issues else 'success',
        'sheets_checked': len(before_wb.sheetnames),
        'merged_ranges_checked': merges_checked,
        'cells_checked_outside_allowed': cells_checked,
        'cells_changed_inside_allowed': allowed_changes,
        'total_issues': len(issues),
        'issues': issues[:MAX_ISSUES],
        'issues_truncated': max(0, len(issues) - MAX_ISSUES),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('original', type=Path, help="the user's workbook, before any edit")
    parser.add_argument('output', type=Path, help='the edited workbook you intend to deliver')
    parser.add_argument(
        '--allow',
        action='append',
        default=[],
        metavar="'Sheet!RANGE'",
        help='a range the edit was meant to change; repeat for each range',
    )
    args = parser.parse_args()

    try:
        for path in (args.original, args.output):
            if not path.is_file():
                raise InputError(f'File not found: {path}')
        if args.original.resolve() == args.output.resolve():
            raise InputError('ORIGINAL and OUTPUT are the same file; save the edit under a new name')
        allowed = [parse_allow(spec) for spec in args.allow]
        result = verify(args.original, args.output, allowed)
    except InputError as error:
        print(json.dumps({'error': str(error)}, indent=2))
        return 1

    print(json.dumps(result, indent=2))
    return 0 if result['status'] == 'success' else 2


if __name__ == '__main__':
    sys.exit(main())
