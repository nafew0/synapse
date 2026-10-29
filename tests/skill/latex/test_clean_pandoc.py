"""Tests for skill/latex/scripts/clean_pandoc.py.

fixtures/pandoc_docx.tex is hand-written in the shape of `pandoc -s` output from a .docx (pandoc is
not needed to run these tests).
"""
import subprocess
import sys
from pathlib import Path

SKILL = Path(__file__).resolve().parents[3] / 'skill' / 'latex'
SCRIPT = SKILL / 'scripts' / 'clean_pandoc.py'
FIXTURE = Path(__file__).resolve().parent / 'fixtures' / 'pandoc_docx.tex'
sys.path.insert(0, str(SCRIPT.parent))

from clean_pandoc import clean  # noqa: E402


def run(*args):
    return subprocess.run([sys.executable, str(SCRIPT), *map(str, args)],
                          capture_output=True, text=True)


def test_pandoc_output_becomes_checker_clean(tmp_path):
    out = tmp_path / 'report.tex'
    result = run(FIXTURE, out)
    assert result.returncode == 0, result.stdout + result.stderr
    assert 'errors (0)' in result.stdout and 'warnings (0)' in result.stdout
    text = out.read_text(encoding='utf-8')
    for noise in ('\\tightlist', '\\def\\labelenum', '\\hypertarget', '\\pandocbounded',
                  '\\noalign', '\\endhead', '\\begin{minipage}', '\\(', '$$', '{[}', 'secnumdepth',
                  '\\ifPDFTeX', '\\makeatletter', 'KOMAClassName', 'pdfcreator'):
        assert noise not in text, noise
    assert text.index('\\usepackage[hidelinks]{hyperref}') > text.index('\\usepackage{booktabs}')


def test_body_details_are_cleaned():
    output, notes, scripts = clean(FIXTURE.read_text(encoding='utf-8'))
    assert scripts == []
    assert '\\section{Introduction}\\label{introduction}' in output
    assert '\\subsection{Results}' in output
    assert '$s_i = x_i / n$' in output
    assert '\\[\\bar{x} = \\frac{1}{n}\\sum_{i=1}^{n} x_i\\]' in output
    assert 'The range is [0, 1].' in output
    assert '\\item Collect the marks.' in output
    assert '\\begin{enumerate}[label={(\\alph*)}]' in output
    assert '\\includegraphics[max width=\\linewidth]{media/image1.png}' in output
    assert '\\begin{figure}[htbp]' in output
    assert '\\title{Annual Report on Student Progress}' in output
    assert '\\author{}' not in output
    assert any('2 longtable(s) became table+tabular' in note for note in notes)


def test_short_longtable_becomes_booktabs_table():
    output, _, _ = clean(FIXTURE.read_text(encoding='utf-8'))
    table = output.split('\\begin{table}[htbp]', 1)[1].split('\\end{table}', 1)[0]
    assert '\\caption{Marks by group}\n  \\label{tbl:marks}' in table
    assert table.count('\\toprule') == 1 and table.count('\\bottomrule') == 1
    assert table.count('Group & Mean & SD') == 1
    assert 'A & 65.2 & 8.1 \\\\' in table
    assert 'p{0.36\\linewidth}' in table
    assert '\\begin{center}\n  \\begin{tabular}{@{}ll@{}}' in output


def test_long_table_stays_longtable():
    rows = '\n'.join(f'r{i} & {i} \\\\' for i in range(40))
    raw = ('\\documentclass{article}\n\\begin{document}\n'
           '\\begin{longtable}[]{@{}ll@{}}\n\\toprule\\noalign{}\nName & Value \\\\\n'
           f'\\midrule\\noalign{{}}\n\\endhead\n\\bottomrule\\noalign{{}}\n\\endlastfoot\n{rows}\n'
           '\\end{longtable}\n\\end{document}\n')
    output, notes, _ = clean(raw)
    assert '\\begin{longtable}{@{}ll@{}}' in output and '\\endhead' in output
    assert '\\usepackage{longtable}' in output
    assert '\\noalign' not in output and '\\endlastfoot' not in output
    assert any('1 kept as longtable' in note for note in notes)


def test_sinhala_body_gets_lualatex_preamble(tmp_path):
    raw = tmp_path / 'raw.tex'
    raw.write_text('\\documentclass{article}\n\\begin{document}\nශ්‍රී ලංකාව and English.\n'
                   '\\end{document}\n', encoding='utf-8')
    out = tmp_path / 'si.tex'
    result = run(raw, out)
    assert result.returncode == 0, result.stdout
    assert 'compile with LuaLaTeX' in result.stdout
    assert 'engine LuaLaTeX' in result.stdout
    text = out.read_text(encoding='utf-8')
    assert '\\babelfont[sinhala]{rm}{Noto Serif Sinhala}' in text
    assert '\\usepackage[T1]{fontenc}' not in text


def test_body_without_preamble_and_bad_arguments(tmp_path):
    raw = tmp_path / 'body.tex'
    raw.write_text('\\chapter{One}\nText with \\(x\\).\n', encoding='utf-8')
    out = tmp_path / 'out.tex'
    assert run(raw, out).returncode == 0
    assert '\\documentclass[11pt,a4paper]{report}' in out.read_text(encoding='utf-8')
    assert run(tmp_path / 'missing.tex', out).returncode == 1
    assert run(raw, raw).returncode == 1


def test_defects_left_in_the_body_exit_2(tmp_path):
    raw = tmp_path / 'raw.tex'
    raw.write_text('\\begin{document}\nSee~\\ref{nowhere}.\n\\end{document}\n', encoding='utf-8')
    result = run(raw, tmp_path / 'out.tex')
    assert result.returncode == 2
    assert '\\ref{nowhere} has no matching \\label' in result.stdout
