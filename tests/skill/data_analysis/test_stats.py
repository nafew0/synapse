"""Tests for skill/data-analysis/scripts/stats.py, checked against scipy and statsmodels directly."""
import math
import subprocess
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
from openpyxl import Workbook, load_workbook
from scipy import stats as st
from statsmodels.formula.api import ols
from statsmodels.stats.anova import anova_lm

SCRIPT = Path(__file__).resolve().parents[3] / 'skill' / 'data-analysis' / 'scripts' / 'stats.py'


def run(command, source, *args, out):
    return subprocess.run([sys.executable, SCRIPT, command, str(source), *map(str, args), '--out', str(out)],
                          capture_output=True, text=True)


def table(out, sheet, title):
    """Read back one titled table from a results sheet."""
    rows = list(load_workbook(out)[sheet].iter_rows(values_only=True))
    start = next(i for i, row in enumerate(rows) if row[0] == title)
    header = [h for h in rows[start + 1] if h is not None]
    body = []
    for row in rows[start + 2:]:
        if row[0] is None:
            break
        body.append(row[:len(header)])
    return pd.DataFrame(body, columns=header)


def number(value):
    return 0.0 if value == '< .001' else float(value)


@pytest.fixture
def study(tmp_path):
    rng = np.random.default_rng(42)
    n = 72
    faculty = np.repeat(['Arts', 'Science', 'Management'], n // 3)
    gender = np.tile(['F', 'M'], n // 2)
    hours = rng.normal(10, 3, n)
    effect = pd.Series(faculty).map({'Arts': 0, 'Science': 4, 'Management': 2}).to_numpy()
    score = 30 + 2 * hours + effect + (gender == 'M') * 1.5 + rng.normal(0, 4, n)
    frame = pd.DataFrame({'Faculty': faculty, 'Gender': gender, 'Hours': hours, 'Score': score,
                          'Attendance': 60 + 2 * hours + rng.normal(0, 5, n), 'Pre': score - rng.normal(3, 2, n)})
    path = tmp_path / 'study.csv'
    frame.to_csv(path, index=False)
    return path, frame


def test_independent_ttest_matches_scipy(study, tmp_path):
    path, frame = study
    out = tmp_path / 'r.xlsx'
    result = run('ttest', path, '--dv', 'Score', '--group', 'Gender', '--type', 'student', out=out)
    assert result.returncode in (0, 2), result.stderr
    f, m = frame.loc[frame.Gender == 'F', 'Score'], frame.loc[frame.Gender == 'M', 'Score']
    expected = st.ttest_ind(f, m, equal_var=True)
    test = table(out, 'ttest', 'Test').iloc[0]
    assert test['t'] == pytest.approx(expected.statistic, rel=1e-9)
    assert number(test['p']) == pytest.approx(expected.pvalue, abs=1e-9)
    assert test['df'] == len(f) + len(m) - 2
    pooled = math.sqrt(((len(f) - 1) * f.var() + (len(m) - 1) * m.var()) / (len(f) + len(m) - 2))
    assert test["Cohen's d"] == pytest.approx((f.mean() - m.mean()) / pooled)
    assert 'Interpretation:' in result.stdout and 'n = 36' in result.stdout


def test_welch_is_used_when_variances_differ(tmp_path):
    rng = np.random.default_rng(1)
    frame = pd.DataFrame({'Group': ['A'] * 40 + ['B'] * 40,
                          'Value': np.concatenate([rng.normal(50, 2, 40), rng.normal(52, 15, 40)])})
    frame.to_csv(tmp_path / 'w.csv', index=False)
    result = run('ttest', tmp_path / 'w.csv', '--dv', 'Value', '--group', 'Group', out=tmp_path / 'r.xlsx')
    assert result.returncode == 2
    assert "Welch's t-test reported" in result.stdout
    expected = st.ttest_ind(frame.Value[:40], frame.Value[40:], equal_var=False)
    assert table(tmp_path / 'r.xlsx', 'ttest', 'Test').iloc[0]['t'] == pytest.approx(expected.statistic)


def test_paired_ttest_matches_scipy(study, tmp_path):
    path, frame = study
    result = run('ttest', path, '--cols', 'Score', 'Pre', out=tmp_path / 'r.xlsx')
    assert result.returncode in (0, 2), result.stderr
    expected = st.ttest_rel(frame.Score, frame.Pre)
    test = table(tmp_path / 'r.xlsx', 'ttest', 'Test').iloc[0]
    assert test['t'] == pytest.approx(expected.statistic)
    assert test['df'] == len(frame) - 1


def test_two_way_anova_matches_statsmodels(study, tmp_path):
    path, frame = study
    out = tmp_path / 'r.xlsx'
    result = run('anova', path, '--dv', 'Score', '--iv', 'Faculty', 'Gender', out=out)
    assert result.returncode in (0, 2), result.stderr
    model = ols('Score ~ C(Faculty, Sum) * C(Gender, Sum)', data=frame).fit()
    expected = anova_lm(model, typ=3)
    got = table(out, 'anova', 'ANOVA (Type III sums of squares)').set_index('Source')
    assert got.loc['Faculty', 'F'] == pytest.approx(expected.loc['C(Faculty, Sum)', 'F'])
    assert got.loc['Gender', 'F'] == pytest.approx(expected.loc['C(Gender, Sum)', 'F'])
    assert got.loc['Faculty x Gender', 'F'] == pytest.approx(expected.loc['C(Faculty, Sum):C(Gender, Sum)', 'F'])
    assert got.loc['Error', 'df'] == expected.loc['Residual', 'df']
    ss_f, ss_e = expected.loc['C(Faculty, Sum)', 'sum_sq'], expected.loc['Residual', 'sum_sq']
    assert got.loc['Faculty', 'Partial eta squared'] == pytest.approx(ss_f / (ss_f + ss_e))
    assert 'Tukey HSD post-hoc comparisons' in result.stdout
    assert 'Levene' in result.stdout and 'Shapiro-Wilk residuals' in result.stdout
    assert 'The interaction Faculty x Gender' in result.stdout


def test_one_way_anova_matches_scipy_f_oneway(study, tmp_path):
    path, frame = study
    run('anova', path, '--dv', 'Score', '--iv', 'Faculty', out=tmp_path / 'r.xlsx')
    expected = st.f_oneway(*[g.Score for _, g in frame.groupby('Faculty')])
    got = table(tmp_path / 'r.xlsx', 'anova', 'ANOVA (Type III sums of squares)').set_index('Source')
    assert got.loc['Faculty', 'F'] == pytest.approx(expected.statistic)
    assert number(got.loc['Faculty', 'p']) == pytest.approx(expected.pvalue, abs=1e-9)


def test_regression_matches_statsmodels_with_vif(study, tmp_path):
    path, frame = study
    out = tmp_path / 'r.xlsx'
    result = run('regression', path, '--dv', 'Score', '--iv', 'Hours', 'Attendance', out=out)
    assert result.returncode in (0, 2), result.stderr
    model = ols('Score ~ Hours + Attendance', data=frame).fit()
    summary = table(out, 'regression', 'Model summary').iloc[0]
    assert summary['R squared'] == pytest.approx(model.rsquared)
    assert summary['Adjusted R squared'] == pytest.approx(model.rsquared_adj)
    assert summary['F'] == pytest.approx(model.fvalue)
    coefficients = table(out, 'regression', 'Coefficients').set_index('Predictor')
    assert coefficients.loc['Hours', 'B'] == pytest.approx(model.params['Hours'])
    assert coefficients.loc['Attendance', 'SE'] == pytest.approx(model.bse['Attendance'])
    r = frame.Hours.corr(frame.Attendance)
    assert coefficients.loc['Hours', 'VIF'] == pytest.approx(1 / (1 - r ** 2))
    assert coefficients.loc['Hours', 'Beta'] == pytest.approx(model.params['Hours'] * frame.Hours.std() / frame.Score.std())
    assert 'explains' in result.stdout


def test_correlation_matches_scipy(study, tmp_path):
    path, frame = study
    run('correlation', path, '--cols', 'Hours', 'Score', 'Attendance', out=tmp_path / 'r.xlsx')
    pairs = table(tmp_path / 'r.xlsx', 'correlation', 'Pairs').set_index(['Variable 1', 'Variable 2'])
    assert pairs.loc[('Hours', 'Score'), 'r'] == pytest.approx(st.pearsonr(frame.Hours, frame.Score).statistic)
    run('correlation', path, '--cols', 'Hours', 'Score', '--method', 'spearman', out=tmp_path / 's.xlsx')
    pairs = table(tmp_path / 's.xlsx', 'correlation', 'Pairs')
    assert pairs.iloc[0]['rho'] == pytest.approx(st.spearmanr(frame.Hours, frame.Score).statistic)


def test_chisq_and_fisher_for_sparse_two_by_two(tmp_path):
    frame = pd.DataFrame({'Group': ['A'] * 10 + ['B'] * 10, 'Pass': ['yes'] * 9 + ['no'] + ['yes'] * 3 + ['no'] * 7})
    frame.to_csv(tmp_path / 'c.csv', index=False)
    result = run('chisq', tmp_path / 'c.csv', '--row', 'Group', '--col', 'Pass', out=tmp_path / 'r.xlsx')
    assert result.returncode == 2
    tests = table(tmp_path / 'r.xlsx', 'chisq', 'Tests').set_index('Test')
    observed = pd.crosstab(frame.Group, frame.Pass)
    assert tests.loc['Pearson chi-square', 'Value'] == pytest.approx(st.chi2_contingency(observed, correction=False)[0])
    assert number(tests.loc["Fisher's exact test", 'p']) == pytest.approx(st.fisher_exact(observed)[1])


def test_cronbach_alpha_matches_hand_computation(tmp_path):
    items = pd.DataFrame({'Q1': [4, 5, 3, 4, 2, 5], 'Q2': [4, 4, 3, 5, 2, 4], 'Q3': [3, 5, 2, 4, 3, 5]})
    items.to_csv(tmp_path / 'q.csv', index=False)
    result = run('reliability', tmp_path / 'q.csv', '--cols', 'Q1', 'Q2', 'Q3', out=tmp_path / 'r.xlsx')
    assert result.returncode == 0, result.stdout + result.stderr
    # item variances 41/30, 32/30, 44/30 (sum 3.9); total-score variance 281/30; k = 3
    hand = 3 / 2 * (1 - 3.9 / (281 / 30))
    stats_row = table(tmp_path / 'r.xlsx', 'reliability', 'Reliability statistics').iloc[0]
    assert stats_row["Cronbach's alpha"] == pytest.approx(hand, abs=1e-6)
    assert "Cronbach's alpha for the 3 items is .875" in result.stdout


def test_reverse_coded_item_is_warned_then_fixed(tmp_path):
    items = pd.DataFrame({'Q1': [4, 5, 3, 4, 2, 5], 'Q2': [4, 4, 3, 5, 2, 4], 'Q3': [3, 1, 4, 2, 4, 1]})
    items.to_csv(tmp_path / 'q.csv', index=False)
    warned = run('reliability', tmp_path / 'q.csv', '--cols', 'Q1', 'Q2', 'Q3', out=tmp_path / 'r.xlsx')
    assert warned.returncode == 2 and 'Q3' in warned.stdout and '--reverse' in warned.stdout
    fixed = run('reliability', tmp_path / 'q.csv', '--cols', 'Q1', 'Q2', 'Q3', '--reverse', 'Q3',
                '--scale-min', 1, '--scale-max', 5, out=tmp_path / 'r.xlsx')
    assert fixed.returncode == 0


def marks_sheet(path):
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = 'Semester 1'
    sheet['A1'] = 'University of Peradeniya - Department of Physics - Marks'
    sheet.merge_cells('A1:E1')
    sheet.append(['Reg No', 'Name', 'PHY101', 'PHY102', 'PHY103'])
    rows = [('P/01', 'Amal', 65, 72, 58), ('P/02', 'Nimal', 38, 55, 61), ('P/03', 'Kumari', 70, 39, 35),
            ('P/04', 'Saman', 40, 41, 80), ('P/05', 'Dilani', 'AB', 66, 52)]
    for row in rows:
        sheet.append(row)
    workbook.save(path)


def test_flag_returns_low_mark_rows_with_sheet_row_numbers(tmp_path):
    marks_sheet(tmp_path / 'marks.xlsx')
    out = tmp_path / 'r.xlsx'
    result = run('flag', tmp_path / 'marks.xlsx', '--cols', 'PHY101', 'PHY102', 'PHY103', '--below', 40, out=out)
    assert result.returncode == 2
    flagged = table(out, 'flag', 'Flagged rows (2)')
    assert flagged['Name'].tolist() == ['Nimal', 'Kumari']
    assert flagged['Row'].tolist() == [4, 5]
    assert flagged['Low in'].tolist() == ['PHY101', 'PHY102, PHY103']
    odd = table(out, 'flag', 'Entries that are not numbers (check by hand)')
    assert odd.iloc[0].to_dict() == {'Row': 7, 'Reg No': 'P/05', 'Name': 'Dilani', 'Column': 'PHY101', 'Value': 'AB'}
    inclusive = run('flag', tmp_path / 'marks.xlsx', '--cols', 'PHY101', '--below', 40, '--inclusive', out=tmp_path / 'i.xlsx')
    assert 'Flagged rows (2)' in inclusive.stdout


def test_compare_groups_with_total(tmp_path):
    frame = pd.DataFrame({'University': ['Colombo', 'Colombo', 'Ruhuna', 'Ruhuna', 'Jaffna'],
                          'Post': ['Professor', 'Lecturer', 'Professor', 'Lecturer', 'Lecturer'],
                          'Basic': [250000, 120000, 240000, 118000, 119000]})
    frame.to_csv(tmp_path / 's.csv', index=False)
    out = tmp_path / 'r.xlsx'
    result = run('compare', tmp_path / 's.csv', '--group', 'Post', '--cols', 'Basic', '--stats', 'count,mean,sum', '--total', out=out)
    assert result.returncode == 0, result.stderr
    summary = table(out, 'compare', 'Group summary').set_index('Post')
    assert summary.loc['Lecturer', 'Basic mean'] == pytest.approx(119000)
    assert summary.loc['Total', 'Basic sum'] == frame.Basic.sum()
    assert 'highest for Professor' in result.stdout


def test_describe_writes_csv_and_frequencies(study, tmp_path):
    path, frame = study
    out = tmp_path / 'r.csv'
    result = run('describe', path, '--cols', 'Score', 'Faculty', out=out)
    assert result.returncode == 0, result.stderr
    text = out.read_text(encoding='utf-8-sig')
    assert 'Descriptive statistics' in text and 'Frequencies: Faculty' in text
    assert f"{frame.Score.mean():.2f}" in result.stdout


def test_results_workbook_keeps_earlier_sheets(study, tmp_path):
    path, _ = study
    out = tmp_path / 'r.xlsx'
    run('describe', path, out=out)
    run('correlation', path, '--cols', 'Hours', 'Score', out=out)
    run('describe', path, '--cols', 'Score', out=out)
    assert load_workbook(out).sheetnames == ['describe', 'correlation']


@pytest.mark.parametrize('args', [
    ['anova', '--dv', 'Missing', '--iv', 'Faculty'],
    ['ttest', '--dv', 'Score', '--group', 'Faculty'],
    ['regression', '--dv', 'Faculty', '--iv', 'Hours'],
    ['flag', '--cols', 'Score'],
    ['compare', '--group', 'Faculty', '--stats', 'mode'],
    ['nonsense'],
])
def test_bad_arguments_exit_1(study, tmp_path, args):
    path, _ = study
    command, *rest = args
    result = run(command, path, *rest, out=tmp_path / 'r.xlsx')
    assert result.returncode == 1, result.stdout + result.stderr
