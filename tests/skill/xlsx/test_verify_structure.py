"""Tests for skill/xlsx/scripts/verify_structure.py.

Kept outside skill/xlsx/ on purpose: every file in a deployment skill directory is uploaded into
each user's code sandbox.

Run with openpyxl and pytest installed:
    python -m pytest tests/skill/xlsx
The LibreOffice round-trip test is skipped when `soffice` is not on PATH.
"""
import importlib.util
import json
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest
from openpyxl import Workbook, load_workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.worksheet.datavalidation import DataValidation

SCRIPTS = Path(__file__).resolve().parents[3] / 'skill' / 'xlsx' / 'scripts'
SCRIPT = SCRIPTS / 'verify_structure.py'
SHEET = 'Sheet 2'

spec = importlib.util.spec_from_file_location('verify_structure', SCRIPT)
verify_structure = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify_structure)


def make_form(path):
    """A requisition form shaped like the ones users send: merged header, bordered table, totals."""
    wb = Workbook()
    ws = wb.active
    ws.title = SHEET
    thin = Side(style='thin')
    ws['A2'] = 'Research and Education Network Trust'
    ws['A2'].font = Font(name='Arial', bold=True, size=14)
    ws.merge_cells('A2:F2')
    ws['A4'] = 'REQUISITION FORM'
    ws.merge_cells('A4:F4')
    for column, heading in zip('ABCDEF', ['Sl. #', 'Description', 'Quantity', 'Unit Cost', 'Estimated Cost', 'Budget Line']):
        ws[f'{column}9'] = heading
        ws[f'{column}9'].fill = PatternFill('solid', fgColor='00D9D9D9')
        ws[f'{column}9'].border = Border(top=thin, bottom=thin, left=thin, right=thin)
        ws.merge_cells(f'{column}9:{column}10')
    for row in (12, 13, 14):
        ws[f'A{row}'] = row - 11
        ws[f'E{row}'] = f'=D{row}*C{row}'
    ws['B12'] = 'USB hub'
    ws['C12'] = 1
    ws['D12'] = 4999
    ws['B18'] = 'Total Estimated cost'
    ws.merge_cells('B18:C18')
    ws['E18'] = '=SUM(E12:E17)'
    ws['A19'] = 'Amount in words: Four thousand nine hundred ninety-nine only'
    ws.merge_cells('A19:F19')
    ws.column_dimensions['B'].width = 42
    ws.row_dimensions[2].height = 28
    validation = DataValidation(type='whole', operator='greaterThan', formula1='0')
    ws.add_data_validation(validation)
    validation.add('C12:C14')
    wb.save(path)
    return path


@pytest.fixture
def original(tmp_path):
    return make_form(tmp_path / 'original.xlsx')


def edit(original, tmp_path, change):
    output = tmp_path / 'output.xlsx'
    shutil.copy(original, output)
    wb = load_workbook(output)
    change(wb[SHEET])
    wb.save(output)
    return output


def fill_items(ws):
    ws['B12'] = 'Monitor'
    ws['D12'] = 30000
    ws['B13'] = 'Laptop'
    ws['C13'] = 1
    ws['D13'] = 165000
    ws['A19'] = 'Amount in words: One lakh ninety-five thousand only'


ITEM_RANGES = [f'{SHEET}!B12:D13', f'{SHEET}!A19']


def run(original, output, allow):
    allowed = [verify_structure.parse_allow(spec) for spec in allow]
    return verify_structure.verify(original, output, allowed)


def kinds(result):
    return {issue['kind'] for issue in result['issues']}


def test_an_edit_inside_the_declared_ranges_passes(original, tmp_path):
    output = edit(original, tmp_path, fill_items)

    result = run(original, output, ITEM_RANGES)

    assert result['status'] == 'success'
    assert result['cells_changed_inside_allowed'] == 6
    assert result['merged_ranges_checked'] == 10


def test_unmerging_the_form_fails(original, tmp_path):
    def unmerge_everything(ws):
        for merged in list(ws.merged_cells.ranges):
            ws.unmerge_cells(str(merged))
        fill_items(ws)

    result = run(original, edit(original, tmp_path, unmerge_everything), ITEM_RANGES)

    assert result['status'] == 'changes_found'
    removed = [issue['detail'] for issue in result['issues'] if issue['kind'] == 'unmerged']
    assert len(removed) == 10
    assert 'merged range A2:F2 was removed' in removed


def test_writing_into_the_header_fails_and_names_the_cell(original, tmp_path):
    def write_in_header(ws):
        ws['B6'] = 'Monitor'

    result = run(original, edit(original, tmp_path, write_in_header), ITEM_RANGES)

    assert result['status'] == 'changes_found'
    assert any(issue['kind'] == 'value' and issue['detail'].startswith('B6:') for issue in result['issues'])


def test_hardcoding_a_total_over_its_formula_fails(original, tmp_path):
    def hardcode_total(ws):
        fill_items(ws)
        ws['E18'] = 195000

    result = run(original, edit(original, tmp_path, hardcode_total), ITEM_RANGES)

    assert any(issue['detail'].startswith("E18: '=SUM(E12:E17)'") for issue in result['issues'])


def test_restyling_a_cell_outside_the_ranges_fails(original, tmp_path):
    def restyle_heading(ws):
        ws['B9'].font = Font(name='Calibri', size=9)

    result = run(original, edit(original, tmp_path, restyle_heading), ITEM_RANGES)

    assert kinds(result) == {'style'}


def test_formatting_inside_the_ranges_is_allowed(original, tmp_path):
    def restyle_item(ws):
        fill_items(ws)
        ws['D12'].number_format = '#,##0.00'

    assert run(original, edit(original, tmp_path, restyle_item), ITEM_RANGES)['status'] == 'success'


def test_resizing_a_column_fails(original, tmp_path):
    def widen(ws):
        ws.column_dimensions['B'].width = 60

    result = run(original, edit(original, tmp_path, widen), ITEM_RANGES)

    assert any(issue['kind'] == 'dimension' and 'column B' in issue['detail'] for issue in result['issues'])


def test_libreoffice_rounding_of_row_heights_is_tolerated(original, tmp_path):
    def round_like_libreoffice(ws):
        ws.row_dimensions[2].height = 27.75
        ws.row_dimensions[12].height = 15.0

    assert run(original, edit(original, tmp_path, round_like_libreoffice), [])['status'] == 'success'


def test_an_alpha_byte_on_a_fill_color_is_tolerated(original, tmp_path):
    def set_alpha(ws):
        ws['B9'].fill = PatternFill('solid', fgColor='FFD9D9D9')

    assert run(original, edit(original, tmp_path, set_alpha), [])['status'] == 'success'


def test_a_different_fill_color_fails(original, tmp_path):
    def recolor(ws):
        ws['B9'].fill = PatternFill('solid', fgColor='FFFF0000')

    assert kinds(run(original, edit(original, tmp_path, recolor), [])) == {'style'}


def test_explicit_default_alignment_is_tolerated(original, tmp_path):
    def spell_out_defaults(ws):
        ws['A12'].alignment = Alignment(horizontal='general', vertical='bottom')

    assert run(original, edit(original, tmp_path, spell_out_defaults), [])['status'] == 'success'


def test_removing_data_validation_fails(original, tmp_path):
    def drop_validation(ws):
        ws.data_validations.dataValidation = []

    assert 'data_validation' in kinds(run(original, edit(original, tmp_path, drop_validation), []))


def test_an_unused_second_bound_on_validation_is_tolerated(original, tmp_path):
    def add_unused_bound(ws):
        ws.data_validations.dataValidation[0].formula2 = '0'

    assert run(original, edit(original, tmp_path, add_unused_bound), [])['status'] == 'success'


def test_renaming_a_sheet_fails(original, tmp_path):
    def rename(ws):
        ws.title = 'Requisition'

    assert 'sheets' in kinds(run(original, edit(original, tmp_path, rename), []))


def test_losing_an_image_fails(original, tmp_path):
    with_logo = tmp_path / 'with_logo.xlsx'
    shutil.copy(original, with_logo)
    with zipfile.ZipFile(with_logo, 'a') as archive:
        archive.writestr('xl/media/image1.png', b'\x89PNG logo')

    result = run(with_logo, original, [])

    assert result['status'] == 'changes_found'
    assert any(issue['kind'] == 'media' and issue['detail'].startswith('images: 1') for issue in result['issues'])


@pytest.mark.parametrize(
    ('spec', 'expected'),
    [
        ("Sheet 2!B12", ('Sheet 2', 2, 12, 2, 12)),
        ("'Sheet 2'!D13:B12", ('Sheet 2', 2, 12, 4, 13)),
        ('Sheet 2!$B$12:$D$14', ('Sheet 2', 2, 12, 4, 14)),
        ('Sheet 2!12:14', ('Sheet 2', 1, 12, verify_structure.UNBOUNDED, 14)),
        ('Sheet 2!b:d', ('Sheet 2', 2, 1, 4, verify_structure.UNBOUNDED)),
    ],
)
def test_allow_ranges_accept_cells_blocks_rows_and_columns(spec, expected):
    assert verify_structure.parse_allow(spec) == expected


def test_a_whole_row_allowance_covers_every_column(original, tmp_path):
    def fill_whole_row(ws):
        ws['F12'] = '12000500'
        ws['B12'] = 'Monitor'

    assert run(original, edit(original, tmp_path, fill_whole_row), [f'{SHEET}!12:12'])['status'] == 'success'


@pytest.mark.parametrize('spec', ['B12:D14', 'Sheet 2!', 'Sheet 2!not-a-range'])
def test_malformed_allow_ranges_are_rejected(spec):
    with pytest.raises(verify_structure.InputError):
        verify_structure.parse_allow(spec)


def test_an_allowance_for_an_unknown_sheet_is_rejected(original, tmp_path):
    output = edit(original, tmp_path, fill_items)

    with pytest.raises(verify_structure.InputError, match='Sheet 3'):
        run(original, output, ['Sheet 3!A1'])


def cli(*args):
    completed = subprocess.run([sys.executable, str(SCRIPT), *map(str, args)], capture_output=True, text=True)
    return completed.returncode, json.loads(completed.stdout)


def test_cli_exits_zero_on_success(original, tmp_path):
    code, payload = cli(original, edit(original, tmp_path, fill_items), '--allow', ITEM_RANGES[0], '--allow', ITEM_RANGES[1])

    assert (code, payload['status']) == (0, 'success')


def test_cli_exits_two_when_changes_are_found(original, tmp_path):
    code, payload = cli(original, edit(original, tmp_path, fill_items))

    assert (code, payload['status']) == (2, 'changes_found')


def test_cli_refuses_to_compare_a_file_with_itself(original):
    code, payload = cli(original, original)

    assert code == 1
    assert 'same file' in payload['error']


@pytest.mark.skipif(shutil.which('soffice') is None, reason='LibreOffice is not installed')
def test_a_correct_edit_still_passes_after_libreoffice_recalculates_it(original, tmp_path):
    output = edit(original, tmp_path, fill_items)
    recalc = subprocess.run(
        [sys.executable, str(SCRIPTS / 'recalc.py'), str(output), '90'], capture_output=True, text=True
    )
    assert json.loads(recalc.stdout).get('status') == 'success', recalc.stdout + recalc.stderr

    assert run(original, output, ITEM_RANGES)['status'] == 'success'
