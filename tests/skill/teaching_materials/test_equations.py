"""Tests for skill/teaching-materials/scripts/equations.py: $...$ maths becomes native Word equations.

Conversion needs pandoc (the sandbox has it); those tests skip without it.
"""
import json
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[3] / 'skill' / 'teaching-materials' / 'scripts'
FIXTURES = Path(__file__).resolve().parent / 'fixtures'
sys.path.insert(0, str(SCRIPTS))

import equations  # noqa: E402

needs_pandoc = pytest.mark.skipif(not shutil.which('pandoc'), reason='needs pandoc')


def exam_with(text, answer):
    spec = json.loads((FIXTURES / 'exam.json').read_text(encoding='utf-8'))
    question = spec['sections'][-1]['questions'][0]
    question['text'] = text
    question['model_answer'] = answer
    question['explanation'] = 'Apply the rule to $u = 3x^2 - 1$.'
    return spec


def build(tmp_path, spec, env=None):
    path = tmp_path / 'spec.json'
    path.write_text(json.dumps(spec), encoding='utf-8')
    out = tmp_path / 'paper.docx'
    result = subprocess.run([sys.executable, str(SCRIPTS / 'build.py'), str(path), str(out), '--no-render'],
                            capture_output=True, text=True, env=env)
    return result, out


def document_xml(path):
    return zipfile.ZipFile(path).read('word/document.xml').decode()


def test_pieces_split_inline_and_display_maths():
    assert equations.pieces('Find $x^2$ when $$y = \\frac{1}{x}$$ holds.') == [
        ('text', 'Find '), ('math', ('x^2', False)), ('text', ' when '),
        ('math', ('y = \\frac{1}{x}', True)), ('text', ' holds.')]


@pytest.mark.parametrize('text', ['It costs $5 and $10 later.', 'Pay \\$20 now.', 'A lone $ sign'])
def test_money_and_escaped_dollars_stay_text(text):
    assert [kind for kind, _ in equations.pieces(text)] == ['text']
    assert '\\$' not in equations.pieces(text)[0][1]


def test_fragments_walk_the_whole_spec_once():
    spec = {'a': 'Let $x$ be real.', 'b': [{'c': '$x$ and $$x^2$$'}]}
    assert equations.fragments(spec) == [('x', False), ('x^2', True)]


@needs_pandoc
def test_exam_maths_become_word_equations(tmp_path):
    spec = exam_with('Differentiate $f(x) = (3x^2 - 1)^4$ and evaluate $$\\int_0^1 x^2\\,dx$$',
                     'Using the chain rule, $f\'(x) = 24x(3x^2 - 1)^3$.')
    result, out = build(tmp_path, spec)
    assert result.returncode == 0, result.stdout
    xml = document_xml(out)
    assert xml.count('<m:oMath>') >= 1 and '<m:oMathPara' in xml
    assert '$f(x)' not in xml and '\\int' not in xml
    assert 'equations: 4 of 4 set as Word equations' in result.stdout
    key = out.with_name('paper-answer-key.docx')
    assert '<m:oMath' in document_xml(key) and "$f'(x)" not in document_xml(key)


def test_without_pandoc_maths_stay_as_latex_and_are_reported(tmp_path):
    spec = exam_with('Differentiate $x^3$.', 'It is $3x^2$.')
    (tmp_path / 'empty').mkdir()
    result, out = build(tmp_path, spec, env={**os.environ, 'PATH': str(tmp_path / 'empty')})
    assert result.returncode == 0, result.stdout
    assert 'WARNING: left as LaTeX text (pandoc is not installed)' in result.stdout
    assert '$x^3$' in document_xml(out)
