"""Tests for skill/stem-tutor: verify.py checks maths, document.py builds Word with native equations.

The build tests need pandoc (the sandbox has it) and skip without it.
"""
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest
from docx import Document

SKILL = Path(__file__).resolve().parents[3] / 'skill' / 'stem-tutor'
VERIFY = SKILL / 'scripts' / 'verify.py'
DOCUMENT = SKILL / 'scripts' / 'document.py'
needs_pandoc = pytest.mark.skipif(not shutil.which('pandoc'), reason='needs pandoc')


def verify(*checks):
    return subprocess.run([sys.executable, str(VERIFY), *checks], capture_output=True, text=True)


@pytest.mark.parametrize('check', [
    'diff(sin(x)^2, x) == sin(2x)',
    'integrate(x^2, (x, 0, 1)) == 1/3',
    'x^2 - 5x + 6 == 0 | x=3',
    'sqrt(2*9.81*20) == 19.8',
    '(a + b)^2 == a^2 + 2a b + b^2',
    '1 - 300/400 == 0.25',
    'cos(x)^2 + sin(x)^2 == 1',
])
def test_correct_maths_passes(check):
    result = verify(check)
    assert result.returncode == 0, result.stdout
    assert result.stdout.startswith('PASS')


@pytest.mark.parametrize('check,detail', [
    ('diff(sin(x)^2, x) == 2cos(x)', 'at x='),
    ('sqrt(2*9.81*20) == 18', '19.8'),
    ('x^2 - 5x + 6 == 0 | x=4', '2 vs 0'),
    ('(a + b)^2 == a^2 + b^2', 'at a='),
])
def test_wrong_maths_fails_with_the_values(check, detail):
    result = verify(check)
    assert result.returncode == 2, result.stdout
    assert result.stdout.startswith('FAIL') and detail in result.stdout


def test_rounding_follows_the_digits_written():
    assert verify('sqrt(2*9.81*20) == 19.81').returncode == 0
    assert verify('sqrt(2*9.81*20) == 19.7').returncode == 2
    assert verify('sqrt(2*9.81*20) == 20').returncode == 0


@pytest.mark.parametrize('check', ['x + 1', 'x == == 2', 'x == 1 | x2', 'sqrt( == 2'])
def test_unreadable_checks_exit_one(check):
    result = verify(check)
    assert result.returncode == 1 and 'ERROR' in result.stdout


def test_several_checks_report_each_and_a_total():
    result = verify('2 + 2 == 4', '2 + 2 == 5')
    assert result.returncode == 2
    assert '1 of 2 passed' in result.stdout


def build(tmp_path, markdown, *extra):
    source = tmp_path / 'solution.md'
    source.write_text(markdown, encoding='utf-8')
    out = tmp_path / 'Solution.docx'
    result = subprocess.run([sys.executable, str(DOCUMENT), str(source), str(out), *extra],
                            capture_output=True, text=True)
    return result, out


SOLUTION = '''# Speed of a falling ball

**Given:** $m = 2\\,\\mathrm{kg}$, $h = 20\\,\\mathrm{m}$. **Find:** the speed $v$ just before impact.

1. **Conservation of energy.** Potential energy becomes kinetic energy: $mgh = \\frac{1}{2}mv^2$.
2. Solve for $v$:

$$v = \\sqrt{2gh} = \\sqrt{2 \\times 9.81 \\times 20}$$

**Answer:** $v \\approx 19.8\\,\\mathrm{m/s}$. Water is $\\mathrm{H_2O}$.
'''


@pytest.mark.parametrize('markdown,message', [
    ('Here \\(x^2\\) is wrong.', '\\( \\)'),
    ('Use $$\\ce{2H2 + O2 -> 2H2O}$$ here.', '\\ce{}'),
    ('Efficiency $\\eta = 1 - T_C/T_H$.', 'write \\frac{a}{b}: \\eta = 1 - T_C/T_H'),
])
def test_maths_word_would_show_wrongly_is_refused(tmp_path, markdown, message):
    result, out = build(tmp_path, markdown)
    assert result.returncode == 2 and message in result.stdout, result.stdout
    assert not out.exists()


def test_units_and_powers_may_keep_a_slash(tmp_path):
    result, _ = build(tmp_path, 'Here $5.76\\,\\mathrm{J/K}$ and $8^{2/3} = 4$.')
    assert 'slash' not in result.stdout


def test_code_blocks_are_not_read_as_maths(tmp_path):
    result, _ = build(tmp_path, '```\nprint(\\(1/2\\))\n```\n')
    assert 'DEFECTS' not in result.stdout


@needs_pandoc
def test_a_solution_becomes_word_with_native_equations(tmp_path):
    result, out = build(tmp_path, SOLUTION)
    assert result.returncode == 0, result.stdout
    xml = zipfile.ZipFile(out).read('word/document.xml').decode()
    assert xml.count('<m:oMath') >= 7 and '<m:f>' in xml and '$' not in xml
    assert 'defects: none' in result.stdout
    section = Document(str(out)).sections[0]
    assert round(section.page_width.cm, 1) == 21.0 and round(section.page_height.cm, 1) == 29.7


def test_bad_arguments_exit_one(tmp_path):
    assert subprocess.run([sys.executable, str(DOCUMENT)], capture_output=True).returncode == 1
    source = tmp_path / 'a.md'
    source.write_text('x', encoding='utf-8')
    assert subprocess.run([sys.executable, str(DOCUMENT), str(source), str(tmp_path / 'a.pdf')],
                          capture_output=True).returncode == 1


def test_skill_frontmatter():
    head = (SKILL / 'SKILL.md').read_text().split('---')[1].strip().splitlines()
    assert [line.split(':')[0] for line in head] == ['name', 'description', 'user-invocable', 'license']
    description = head[1].split(': ', 1)[1]
    assert description.startswith('"') and description.endswith('"') and len(description) - 2 <= 250
