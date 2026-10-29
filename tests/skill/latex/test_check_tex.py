"""Tests for skill/latex/scripts/check_tex.py and the templates it gates.

Kept outside skill/ on purpose: every file in a skill directory is uploaded into each sandbox.
"""
import subprocess
import sys
from pathlib import Path

import pytest

SKILL = Path(__file__).resolve().parents[3] / 'skill' / 'latex'
SCRIPT = SKILL / 'scripts' / 'check_tex.py'
TEMPLATES = SKILL / 'templates'
sys.path.insert(0, str(SCRIPT.parent))

from check_tex import check  # noqa: E402

PREAMBLE = r"""\documentclass{article}
\usepackage{amsmath,amssymb}
\usepackage{graphicx}
\usepackage{booktabs}
\usepackage[hidelinks]{hyperref}
"""


def document(body, preamble=PREAMBLE):
    return f'{preamble}\\begin{{document}}\n{body}\n\\end{{document}}\n'


def run_check(tmp_path, text, name='main.tex', **kwargs):
    path = tmp_path / name
    path.write_text(text, encoding='utf-8')
    return check(path, **kwargs)


def sections(report):
    errors = report.split('errors (', 1)[1].split('warnings (', 1)[0]
    warnings = report.split('warnings (', 1)[1].split('\nresult:', 1)[0]
    return errors, warnings


def cli(*args):
    return subprocess.run([sys.executable, str(SCRIPT), *map(str, args)],
                          capture_output=True, text=True)


@pytest.mark.parametrize('name, args', [
    ('article.tex', []),
    ('solution-sheet.tex', []),
    ('exam.tex', []),
    ('beamer.tex', []),
    ('thesis-chapter.tex', ['--snippet', '--bib', TEMPLATES / 'references.bib']),
])
def test_templates_pass_strict(name, args):
    result = cli(TEMPLATES / name, '--strict', *args)
    assert result.returncode == 0, result.stdout + result.stderr
    assert 'errors (0)' in result.stdout and 'warnings (0)' in result.stdout


def test_article_template_cites_are_checked_against_its_bib():
    report, code = check(TEMPLATES / 'article.tex')
    assert code == 0
    assert 'not in the bibliography' not in report


def test_templates_are_short_and_mark_bib_examples():
    for path in TEMPLATES.glob('*.tex'):
        assert len(path.read_text().splitlines()) < 120, path.name
    assert 'EXAMPLE ENTRIES ONLY' in (TEMPLATES / 'references.bib').read_text()


ERROR_CASES = [
    ('unbalanced close brace', r'Text \textbf{bold}} here.', r'Text \textbf{bold} here.',
     'unmatched }'),
    ('unclosed brace', r'Text \textbf{bold here.', r'Text \textbf{bold} here.',
     '{ is not closed before'),
    ('env mismatch', '\\begin{itemize}\n\\item a\n\\end{enumerate}',
     '\\begin{itemize}\n\\item a\n\\end{itemize}', r'\end{enumerate} without a matching'),
    ('unclosed env', '\\begin{center}\nText', '\\begin{center}\nText\n\\end{center}',
     r'\begin{center} is not closed'),
    ('left without right', r'$\left( x$', r'$\left( x \right)$', r'\left without a matching'),
    ('left across rows', '\\begin{align}\n  a &= \\left( b \\\\\n  c \\right)\n\\end{align}',
     '\\begin{align}\n  a &= \\left( b \\right. \\\\\n  &\\left. c \\right)\n\\end{align}',
     r'before the \\ row break'),
    ('unclosed dollar', 'Value $x + 1.\n\nNext paragraph.', 'Value $x + 1$.\n\nNext paragraph.',
     'not closed before the blank line'),
    ('stray display close', r'Text \] here.', r'Text \[ x \] here.', r'\] without a matching'),
    ('align inside display', '\\[\n\\begin{align} a &= b \\end{align}\n\\]',
     '\\[\n\\begin{aligned} a &= b \\end{aligned}\n\\]', 'inside maths'),
    ('undefined ref', r'See Figure~\ref{fig:none}.',
     '\\section{A}\\label{fig:none}\nSee Figure~\\ref{fig:none}.', 'has no matching \\label'),
    ('duplicate label', '\\section{A}\\label{sec:a}\n\\section{B}\\label{sec:a}',
     '\\section{A}\\label{sec:a}\n\\section{B}\\label{sec:b}', 'duplicate \\label{sec:a}'),
    ('underscore in text', 'The file_name is long.', r'The file\_name is long.',
     'unescaped _ in text'),
    ('ampersand in text', 'Smith & Sons.', r'Smith \& Sons.', 'unescaped &'),
    ('hash in text', 'Item #3.', r'Item \#3.', 'unescaped #'),
    ('percent after number', 'Pass rate 50% this year.', r'Pass rate 50\% this year.',
     'starts a comment'),
    ('blank line in equation', '\\begin{equation}\n  x = 1\n\n\\end{equation}',
     '\\begin{equation}\n  x = 1\n\\end{equation}', 'blank line inside {equation}'),
    ('markdown fence', '```latex\nText\n```', 'Text', 'Markdown code fence'),
    ('mathjax bbox', r'$\bbox[yellow]{x}$', r'$\boxed{x}$', 'MathJax-only'),
    ('usepackage in body', '\\usepackage{xcolor}\nText', 'Text', 'after \\begin{document}'),
    ('undefined theorem', '\\begin{theorem}\nA.\n\\end{theorem}', 'Text.',
     'environment theorem is not defined'),
]


@pytest.mark.parametrize('label, bad, good, message', ERROR_CASES, ids=[c[0] for c in ERROR_CASES])
def test_error_rule_fires_and_clears(tmp_path, label, bad, good, message):
    report, code = run_check(tmp_path, document(bad))
    errors, _ = sections(report)
    assert code == 2, report
    assert message in errors, report
    report, code = run_check(tmp_path, document(good))
    errors, _ = sections(report)
    assert message not in errors, report
    assert code == 0, report


PACKAGE_CASES = [
    ('align', '\\begin{align}\n  x &= 1\n\\end{align}', 'amsmath'),
    ('cases', '\\[\n\\begin{cases} 1 & x > 0 \\end{cases}\n\\]', 'amsmath'),
    ('text', r'$x \text{ if } y$', 'amsmath'),
    ('eqref', '\\begin{equation}x\\label{eq:a}\\end{equation}\nSee~\\eqref{eq:a}.', 'amsmath'),
    ('DeclareMathOperator', r'Text.', 'amsmath'),
    ('mathbb', r'$\mathbb{R}$', 'amssymb'),
    ('mathfrak', r'$\mathfrak{g}$', 'amssymb'),
    ('includegraphics', r'\includegraphics[width=\linewidth]{example-image}', 'graphicx'),
    ('toprule', '\\begin{tabular}{ll}\n\\toprule\na & b \\\\\n\\bottomrule\n\\end{tabular}',
     'booktabs'),
    ('SI', r'\SI{5}{\metre}', 'siunitx'),
    ('qty', r'\qty{5}{\metre}', 'siunitx'),
    ('url', r'\url{https://example.org}', 'url'),
    ('href', r'\href{https://example.org}{site}', 'hyperref'),
    ('cref', '\\section{A}\\label{sec:a}\n\\cref{sec:a}', 'cleveref'),
    ('lstlisting', '\\begin{lstlisting}\nx = 1\n\\end{lstlisting}', 'listings'),
    ('minted', '\\begin{minted}{python}\nx = 1\n\\end{minted}', 'minted'),
    ('textcolor', r'\textcolor{red}{x}', 'xcolor'),
    ('tikzpicture', '\\begin{tikzpicture}\n\\draw (0,0) -- (1,1);\n\\end{tikzpicture}', 'tikz'),
    ('multirow', '\\begin{tabular}{ll}\n\\multirow{2}{*}{a} & b \\\\\n\\end{tabular}', 'multirow'),
    ('longtable', '\\begin{longtable}{ll}\na & b \\\\\n\\end{longtable}', 'longtable'),
    ('subfigure', '\\begin{figure}[htbp]\n\\begin{subfigure}{0.4\\linewidth}\n\\caption{a}\n'
                  '\\end{subfigure}\n\\caption{b}\n\\end{figure}', 'subcaption'),
]


@pytest.mark.parametrize('name, body, package', PACKAGE_CASES, ids=[c[0] for c in PACKAGE_CASES])
def test_missing_package_is_an_error(tmp_path, name, body, package):
    preamble = '\\documentclass{article}\n'
    if name == 'DeclareMathOperator':
        preamble += '\\DeclareMathOperator{\\tr}{tr}\n'
    report, code = run_check(tmp_path, document(body, preamble))
    errors, _ = sections(report)
    assert code == 2, report
    assert f'needs \\usepackage{{{package}}}' in errors, report
    loaded = f'{preamble}\\usepackage{{{package}}}\n'
    if name == 'subfigure':
        loaded += '\\usepackage{graphicx}\n'
    report, _ = run_check(tmp_path, document(body, loaded))
    assert f'needs \\usepackage{{{package}}}' not in report, report


def test_package_implied_by_another_or_by_the_class(tmp_path):
    body = '\\begin{align} x &= \\mathbb{R} \\end{align}\n\\textcolor{red}{y}'
    preamble = '\\documentclass{article}\n\\usepackage{mathtools,amssymb,tikz}\n'
    report, code = run_check(tmp_path, document(body, preamble))
    assert code == 0, report
    beamer = '\\documentclass{beamer}\n'
    report, code = run_check(tmp_path, document('\\begin{frame}{T}$\\mathbb{R}$\\end{frame}',
                                                beamer))
    assert code == 0, report


def test_unknown_class_downgrades_package_findings_to_warnings(tmp_path):
    report, code = run_check(tmp_path, document(r'$\mathbb{R}$', '\\documentclass{elsarticle}\n'))
    errors, warnings = sections(report)
    assert code == 0, report
    assert 'unless class elsarticle loads it' in warnings


def test_local_class_file_is_read_for_packages_and_macros(tmp_path):
    (tmp_path / 'icas_UoV.cls').write_text(
        '\\NeedsTeXFormat{LaTeX2e}\n\\LoadClass[a4paper]{article}\n'
        '\\RequirePackage{amsmath,amssymb}\n\\newcommand{\\keywords}[1]{#1}\n', encoding='utf-8')
    body = '\\keywords{a, b}\n\\begin{align} x &= \\mathbb{R} \\end{align}'
    report, code = run_check(tmp_path, document(body, '\\documentclass{icas_UoV}\n'))
    assert code == 0, report
    custom = '\\documentclass{icas_UoV}\n'
    report, code = run_check(tmp_path, document(r'\includegraphics{x}', custom))
    assert code == 2 and 'needs \\usepackage{graphicx}' in report


WARNING_CASES = [
    ('double dollar', '$$ x = 1 $$', r'\[ x = 1 \]', '$$...$$ is plain TeX'),
    ('eqnarray', '\\begin{eqnarray} a &=& b \\end{eqnarray}',
     '\\begin{align} a &= b \\end{align}', 'eqnarray'),
    ('bf', r'{\bf bold}', r'\textbf{bold}', r'\bf is obsolete'),
    ('it', r'{\it italic}', r'\textit{italic}', r'\it is obsolete'),
    ('over', r'${a \over b}$', r'$\frac{a}{b}$', r'\over is obsolete'),
    ('centerline', r'\centerline{Title}', '\\begin{center}\nTitle\n\\end{center}',
     r'\centerline is obsolete'),
    ('center in float', '\\begin{figure}[htbp]\n\\begin{center}\nX\n\\end{center}\n'
                        '\\caption{A}\\label{fig:a}\n\\end{figure}',
     '\\begin{figure}[htbp]\n\\centering\nX\n\\caption{A}\\label{fig:a}\n\\end{figure}',
     'center environment inside a float'),
    ('label before caption', '\\begin{table}[htbp]\n\\centering\n\\label{tab:a}\n'
                             '\\caption{A}\n\\end{table}',
     '\\begin{table}[htbp]\n\\centering\n\\caption{A}\n\\label{tab:a}\n\\end{table}',
     'before \\caption'),
    ('ref without tilde', '\\section{A}\\label{sec:a}\nSee Section \\ref{sec:a}.',
     '\\section{A}\\label{sec:a}\nSee Section~\\ref{sec:a}.', 'non-breaking space'),
    ('vertical rules', '\\begin{tabular}{|l|r|}\n\\toprule\na & b \\\\\n\\bottomrule\n'
                       '\\end{tabular}',
     '\\begin{tabular}{lr}\n\\toprule\na & b \\\\\n\\bottomrule\n\\end{tabular}',
     'vertical rules'),
    ('ascii quotes', 'He said "yes".', "He said ``yes''.", 'ASCII " quote'),
    ('three dots', 'And so on...', r'And so on\dots', r'write \dots'),
    ('hyphen range', 'See pages 12-15.', 'See pages 12--15.', 'en-dash'),
    ('newline at paragraph end', 'First paragraph.\\\\\n\nSecond.', 'First paragraph.\n\nSecond.',
     'end of a paragraph'),
    ('empty label', '\\section{A}\\label{}', '\\section{A}\\label{sec:a}', 'empty \\label{}'),
    ('markdown bold', 'This is **important**.', r'This is \textbf{important}.',
     'Markdown **bold**'),
]


@pytest.mark.parametrize('label, bad, good, message', WARNING_CASES,
                         ids=[c[0] for c in WARNING_CASES])
def test_warning_rule_fires_and_clears(tmp_path, label, bad, good, message):
    report, code = run_check(tmp_path, document(bad))
    _, warnings = sections(report)
    assert message in warnings, report
    assert code == 0, report
    report, _ = run_check(tmp_path, document(good))
    assert message not in report, report


def test_hyperref_and_cleveref_order(tmp_path):
    preamble = ('\\documentclass{article}\n\\usepackage{cleveref}\n\\usepackage{hyperref}\n'
                '\\usepackage{graphicx}\n')
    report, _ = run_check(tmp_path, document('Text.', preamble))
    _, warnings = sections(report)
    assert 'load hyperref after the other packages (found after it: graphicx)' in warnings
    assert 'load cleveref after hyperref' in warnings
    good = '\\documentclass{article}\n\\usepackage{graphicx}\n\\usepackage{hyperref}\n' \
           '\\usepackage{cleveref}\n'
    report, _ = run_check(tmp_path, document('Text.', good))
    assert 'warnings (0)' in report, report


def test_strict_makes_warnings_fail(tmp_path):
    path = tmp_path / 'main.tex'
    path.write_text(document('$$ x $$'), encoding='utf-8')
    assert cli(path).returncode == 0
    assert cli(path, '--strict').returncode == 2


def test_beamer_listing_without_fragile_is_an_error(tmp_path):
    frame = ('\\begin{frame}{Code}\n\\begin{lstlisting}\nfor i in range(3):\n    print(i)\n'
             '\\end{lstlisting}\n\\end{frame}')
    preamble = '\\documentclass{beamer}\n\\usepackage{listings}\n'
    report, code = run_check(tmp_path, document(frame, preamble))
    assert code == 2 and 'needs \\begin{frame}[fragile]' in report, report
    fixed = frame.replace('\\begin{frame}{Code}', '\\begin{frame}[fragile]{Code}')
    report, code = run_check(tmp_path, document(fixed, preamble))
    assert code == 0, report
    verb = '\\begin{frame}{V}\nUse \\verb|x_1|.\n\\end{frame}'
    report, code = run_check(tmp_path, document(verb, '\\documentclass{beamer}\n'))
    assert code == 2 and '[fragile]' in report, report


def test_exam_question_without_marks(tmp_path):
    preamble = '\\documentclass[addpoints]{exam}\n'
    body = ('\\begin{questions}\n\\question[5] One.\n\\question Two.\n'
            '\\question Three.\n\\begin{parts}\n\\part[2] a\n\\end{parts}\n\\end{questions}')
    report, code = run_check(tmp_path, document(body, preamble))
    _, warnings = sections(report)
    assert 'main.tex:5: \\question without marks' in warnings, report
    assert ':7:' not in warnings
    report, _ = run_check(tmp_path, document(body.replace('\\question Two', '\\question[3] Two'),
                                             preamble))
    assert 'without marks' not in report


def test_comments_and_verbatim_bodies_are_ignored(tmp_path):
    body = ('% a_b & #1 \\begin{itemize} $x\n'
            'Text. % 100% sure, a_b, \\end{center}\n'
            '\\begin{verbatim}\na_b & # $ { \\begin{x}\n\\end{verbatim}\n'
            '\\begin{lstlisting}\nprint("a_b", 50%) {\n\\end{lstlisting}\n'
            'Inline \\verb|a_b{#| and \\url{https://x.org/a_b%20c#d}.')
    preamble = PREAMBLE.replace('\\usepackage[hidelinks]{hyperref}',
                                '\\usepackage{listings}\n\\usepackage[hidelinks]{hyperref}')
    report, code = run_check(tmp_path, document(body, preamble))
    assert code == 0, report
    assert 'warnings (0)' in report, report


def test_input_files_are_followed(tmp_path):
    (tmp_path / 'chapters').mkdir()
    (tmp_path / 'chapters' / 'intro.tex').write_text(
        '\\section{Intro}\\label{sec:intro}\nThe file_name.\n', encoding='utf-8')
    report, code = run_check(tmp_path, document('\\input{chapters/intro}\nSee~\\ref{sec:intro}.'))
    assert '(+1 included file)' in report
    assert 'chapters/intro.tex:2: unescaped _' in report, report
    assert 'has no matching' not in report
    report, code = run_check(tmp_path, document('\\include{missing}\nSee~\\ref{sec:x}.'))
    _, warnings = sections(report)
    assert 'file "missing" not found' in warnings
    assert 'has no matching \\label in the files checked' in warnings
    assert code == 0, report


def test_cite_keys_checked_against_bib(tmp_path):
    (tmp_path / 'refs.bib').write_text(
        '@article{perera2020rain,\n  title={T},\n  year={2020}\n}\n'
        '@book{silva2019,\n  title={B},\n  year={2019}\n}\n', encoding='utf-8')
    body = 'As shown~\\cite{perera2020rain, silva2019} and~\\cite[p.~4]{fernando2018}.\n' \
           '\\bibliographystyle{plain}\n\\bibliography{refs}'
    report, code = run_check(tmp_path, document(body))
    errors, _ = sections(report)
    assert code == 2
    assert '\\cite key "fernando2018" is not in the bibliography' in errors
    assert 'perera2020rain' not in errors and 'silva2019' not in errors
    cleaned = body.replace(' and~\\cite[p.~4]{fernando2018}', '')
    report, code = run_check(tmp_path, document(cleaned))
    assert code == 0, report


def test_cli_bib_and_missing_bibliography(tmp_path):
    bib = tmp_path / 'other.bib'
    bib.write_text('@misc{key2020,\n  title={T}\n}\n', encoding='utf-8')
    path = tmp_path / 'main.tex'
    path.write_text(document('Text~\\cite{key2020}.'), encoding='utf-8')
    result = cli(path)
    assert result.returncode == 2 and 'citations but no bibliography' in result.stdout
    result = cli(path, '--bib', bib)
    assert result.returncode == 0, result.stdout


def test_sinhala_needs_unicode_engine_and_font(tmp_path):
    body = 'ශ්‍රී ලංකාව'
    report, code = run_check(tmp_path, document(body), engine='pdflatex')
    assert code == 2 and 'Sinhala text cannot be typeset by pdfLaTeX' in report
    report, code = run_check(tmp_path, document(body))
    assert code == 2 and 'Sinhala' in report
    preamble = ('\\documentclass{article}\n\\usepackage{fontspec}\n'
                '\\newfontfamily\\sinhalafont{Noto Serif Sinhala}\n')
    report, code = run_check(tmp_path, document(body, preamble), engine='xelatex')
    assert code == 0, report
    assert 'Sinhala' not in report
    report, code = run_check(tmp_path, document(body, preamble), engine='pdflatex')
    assert code == 2 and 'fontspec needs XeLaTeX or LuaLaTeX' in report


def test_unicode_maths_with_pdflatex(tmp_path):
    report, code = run_check(tmp_path, document('$α ≤ 1$'))
    assert code == 2 and 'U+03B1' in report and 'U+2264' in report
    report, code = run_check(tmp_path, document(r'$\alpha \leq 1$'))
    assert code == 0, report


def test_snippet_mode(tmp_path):
    body = '\\section{A}\\label{sec:a}\nSee~\\ref{sec:a} and~\\ref{ch:other}.\n$\\mathbb{R}$'
    report, code = run_check(tmp_path, body, snippet=True)
    _, warnings = sections(report)
    assert code == 0, report
    assert 'has no matching \\label in the files checked' in warnings
    report, code = run_check(tmp_path, body)
    assert code == 2 and 'no \\documentclass' in report


def test_user_macros_are_not_flagged(tmp_path):
    preamble = PREAMBLE + ('\\newcommand{\\R}{\\mathbb{R}}\n'
                           '\\newenvironment{answer}{\\begin{center}\\bfseries}{\\end{center}}\n'
                           '\\newtheorem{theorem}{Theorem}\n\\def\\half#1{\\frac{#1}{2}}\n')
    body = ('\\begin{answer}\nYes.\n\\end{answer}\n\\begin{theorem}\n$x \\in \\R$, '
            '$\\half{x}$\n\\end{theorem}')
    report, code = run_check(tmp_path, document(body, preamble))
    assert code == 0, report
    assert 'warnings (0)' in report, report


def test_maths_text_and_intervals_are_not_false_positives(tmp_path):
    body = ('For $x \\in [0, 1)$ and $f(x) = \\text{max of $a_1$ and } b$, '
            'see~\\cite[p.~5]{key} \\\\[2pt] item.\n'
            '\\begin{itemize}[leftmargin=*]\n\\item[(a)] one\n\\end{itemize}\n'
            '\\begin{tabular}{ll}\na & b \\\\\n\\end{tabular}\n'
            'In 2023-10-05 the ISO date and COVID-19 are fine.')
    (tmp_path / 'refs.bib').write_text('@misc{key,\n title={T}\n}\n', encoding='utf-8')
    report, code = run_check(tmp_path, document(body + '\n\\bibliography{refs}'))
    assert code == 0, report
    assert 'warnings (0)' in report, report


def test_todo_markers_are_counted(tmp_path):
    report, code = run_check(tmp_path, document('Text. % TODO: add data\nMore [citation needed].'))
    assert code == 0
    assert 'info: 2 TODO/placeholder marker(s)' in report


def test_exit_codes_for_bad_arguments(tmp_path):
    assert cli(tmp_path / 'missing.tex').returncode == 1
    path = tmp_path / 'main.tex'
    path.write_text(document('Text.'), encoding='utf-8')
    assert cli(path, '--engine', 'context').returncode == 1
    assert cli(path, '--bib', tmp_path / 'none.bib').returncode == 1
    assert cli(path).returncode == 0
