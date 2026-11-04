"""Tests for skill/data-analysis/scripts/profile_data.py and the shared loader."""
import subprocess
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from openpyxl import Workbook

SCRIPTS = Path(__file__).resolve().parents[3] / 'skill' / 'data-analysis' / 'scripts'
sys.path.insert(0, str(SCRIPTS))
from load import load  # noqa: E402


def profile(*args):
    return subprocess.run([sys.executable, SCRIPTS / 'profile_data.py', *map(str, args)], capture_output=True, text=True)


def marks_with_title(path, absent=False):
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = 'Marks'
    sheet['A1'] = 'Faculty of Science - Semester 1 marks'
    sheet.merge_cells('A1:D1')
    sheet.append([])
    sheet.append(['Reg No', 'Name', 'Maths', 'Physics'])
    rng = np.random.default_rng(3)
    for i in range(20):
        sheet.append([f'SC/{i:03}', f'Student {i}', int(rng.integers(20, 90)), int(rng.integers(20, 90))])
    if absent:
        sheet['C6'] = 'AB'
    workbook.save(path)


def test_title_row_is_skipped_and_rows_keep_sheet_numbers(tmp_path):
    marks_with_title(tmp_path / 'marks.xlsx')
    table = load(tmp_path / 'marks.xlsx')
    assert table.header_row == 3
    assert list(table.data.columns) == ['Reg No', 'Name', 'Maths', 'Physics']
    assert table.data.index[0] == 4 and len(table.data) == 20
    assert pd.api.types.is_numeric_dtype(table.data['Maths'])


def test_clean_file_exits_0_and_describes_columns(tmp_path):
    marks_with_title(tmp_path / 'marks.xlsx')
    result = profile(tmp_path / 'marks.xlsx')
    assert result.returncode == 0, result.stdout + result.stderr
    assert 'header row: 3' in result.stdout
    assert '- Maths [numeric] n=20 missing=0' in result.stdout
    assert '- Name [text]' in result.stdout
    assert 'problems: none' in result.stdout


def test_mixed_text_in_a_number_column_exits_2_with_its_row(tmp_path):
    marks_with_title(tmp_path / 'marks.xlsx', absent=True)
    result = profile(tmp_path / 'marks.xlsx')
    assert result.returncode == 2
    assert "Maths [mixed]" in result.stdout
    assert "row 6: 'AB'" in result.stdout


def test_more_than_a_fifth_missing_exits_2(tmp_path):
    frame = pd.DataFrame({'Name': list('abcdefghij'), 'Score': [1, 2, None, None, None, 6, 7, 8, 9, 10]})
    frame.to_csv(tmp_path / 'scores.csv', index=False)
    result = profile(tmp_path / 'scores.csv')
    assert result.returncode == 2
    assert 'Score: 30% missing' in result.stdout


def test_merged_group_header_prefixes_duplicate_names(tmp_path):
    workbook = Workbook()
    sheet = workbook.active
    sheet.append(['Student', 'Module 1', None, 'Module 2', None])
    sheet.append(['Name', 'CA', 'Exam', 'CA', 'Exam'])
    sheet.append(['A', 10, 50, 12, 40])
    sheet.append(['B', 14, 61, 9, 35])
    sheet.merge_cells('B1:C1')
    sheet.merge_cells('D1:E1')
    workbook.save(tmp_path / 'modules.xlsx')
    table = load(tmp_path / 'modules.xlsx')
    assert list(table.data.columns) == ['Name', 'Module 1 CA', 'Module 1 Exam', 'Module 2 CA', 'Module 2 Exam']
    assert any('merged group header' in note for note in table.notes)


def test_header_row_override_and_missing_file(tmp_path):
    marks_with_title(tmp_path / 'marks.xlsx')
    assert load(tmp_path / 'marks.xlsx', header_row=3).header_row == 3
    assert profile(tmp_path / 'nothing.xlsx').returncode == 1
    assert profile(tmp_path / 'marks.xlsx', '--sheet', 'Nope').returncode == 1


def test_numbers_stored_as_text_are_converted(tmp_path):
    pd.DataFrame({'Item': ['a', 'b', 'c'], 'Cost': ['1,250', '300', '75.5'], 'Done': ['50%', '100%', '0%']}).to_csv(tmp_path / 'c.csv', index=False)
    data = load(tmp_path / 'c.csv').data
    assert data['Cost'].tolist() == [1250.0, 300.0, 75.5]
    assert data['Done'].tolist() == [0.5, 1.0, 0.0]
