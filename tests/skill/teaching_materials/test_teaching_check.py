"""Tests for skill/teaching-materials/scripts/check.py: the gate catches what a teacher would."""
import copy
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[3] / 'skill' / 'teaching-materials' / 'scripts'
FIXTURES = Path(__file__).resolve().parent / 'fixtures'


def fixture(name):
    return json.loads((FIXTURES / f'{name}.json').read_text(encoding='utf-8'))


def write(spec, path):
    path.write_text(json.dumps(spec, ensure_ascii=False), encoding='utf-8')
    return path


def script(name, *args):
    return subprocess.run([sys.executable, str(SCRIPTS / name), *map(str, args)], capture_output=True, text=True)


def build(spec, tmp_path, name='paper'):
    spec_path = write(spec, tmp_path / f'{name}.json')
    out = tmp_path / f'{name}.docx'
    result = script('build.py', spec_path, out, '--no-render', '--qa-dir', tmp_path / 'qa')
    return result, spec_path, out


def check(spec_path, paper, *extra):
    return script('check.py', spec_path, paper, *extra)


def test_a_good_exam_passes_the_standalone_gate(tmp_path):
    _, spec_path, out = build(fixture('exam'), tmp_path)

    result = check(spec_path, out, '--key', tmp_path / 'paper-answer-key.docx')

    assert result.returncode == 0, result.stdout
    assert 'marks: Section A 6 + Section B 24 + Section C 20 = 50 (stated 50)' in result.stdout
    assert 'MCQ key: 3 of 3 keyed' in result.stdout
    assert 'answers in paper: none' in result.stdout
    assert 'defects: none' in result.stdout


def test_stated_total_that_does_not_add_up(tmp_path):
    spec = fixture('exam')
    spec['header']['total_marks'] = 60

    result, _, _ = build(spec, tmp_path)

    assert result.returncode == 2
    assert 'total marks stated as 60 but the questions add up to 50' in result.stdout


def test_parts_and_marking_points_that_do_not_add_up(tmp_path):
    spec = fixture('exam')
    question = spec['sections'][1]['questions'][0]
    question['marks'] = 15
    question['parts'][0]['marking'][0]['marks'] = 4
    spec['sections'][1]['marks'] = 30

    result, _, _ = build(spec, tmp_path)

    assert result.returncode == 2
    assert 'Q4 says 15 marks but its parts add up to 14' in result.stdout
    assert 'Q4(a) marking scheme gives 9 marks but the question carries 8' in result.stdout
    assert 'Section B says 30 marks but its questions add up to 24' in result.stdout


def test_exam_question_without_marks(tmp_path):
    spec = fixture('exam')
    del spec['sections'][1]['questions'][1]['marks']

    result, _, _ = build(spec, tmp_path)

    assert result.returncode == 2
    assert 'Q5 has no marks' in result.stdout


def test_missing_and_double_mcq_keys(tmp_path):
    spec = fixture('mcq')
    del spec['questions'][0]['answer']
    spec['questions'][1]['answer'] = ['a', 'b']
    spec['questions'][2]['answer'] = 'e'

    result, _, _ = build(spec, tmp_path)

    assert result.returncode == 2
    assert 'Q1 (MCQ) has no answer in the key' in result.stdout
    assert 'Q2 (MCQ) keys 2 answers (a, b)' in result.stdout
    assert "Q3 (MCQ) answer 'e' is not one of its options" in result.stdout


def test_multi_answer_mcq_is_allowed_when_the_spec_says_so(tmp_path):
    spec = fixture('mcq')
    spec['questions'][1].update(answer=['a', 'b'], multi=True)

    result, _, _ = build(spec, tmp_path)

    assert result.returncode == 0, result.stdout


def test_answer_leaked_into_the_paper(tmp_path):
    spec = fixture('exam')
    spec['sections'][1]['questions'][1]['text'] += ' Two transactions each hold a lock the other needs and wait forever for it to be released.'

    result, _, _ = build(spec, tmp_path)

    assert result.returncode == 2
    assert 'answer text for Q5 appears in the student paper' in result.stdout
    assert 'answers in paper: FOUND' in result.stdout


def test_answer_marker_in_a_question_stem(tmp_path):
    spec = fixture('mcq')
    spec['questions'][3]['text'] += ' (Answer: b)'

    result, _, _ = build(spec, tmp_path)

    assert result.returncode == 2
    assert "the student paper contains 'Answer:'" in result.stdout


def test_answer_quoting_a_given_constraint_is_not_a_leak(tmp_path):
    spec = fixture('exam')
    spec['sections'][1]['questions'][0]['parts'][0]['marking'].append('A student enrols in one or more courses.')
    spec['sections'][1]['questions'][0]['parts'][0]['marking'] = [
        point['point'] if isinstance(point, dict) else point for point in spec['sections'][1]['questions'][0]['parts'][0]['marking']
    ]

    result, _, _ = build(spec, tmp_path)

    assert result.returncode == 0, result.stdout


def test_duplicate_questions(tmp_path):
    spec = fixture('mcq')
    spec['questions'].append(copy.deepcopy(spec['questions'][0]))
    spec['total_marks'] = 5

    result, _, _ = build(spec, tmp_path)

    assert result.returncode == 2
    assert 'Q1 and Q5 are the same question' in result.stdout


def test_key_that_does_not_match_the_paper(tmp_path):
    shorter = fixture('mcq')
    shorter['questions'].pop()
    shorter['total_marks'] = 3
    build(shorter, tmp_path, name='old')
    _, spec_path, out = build(fixture('mcq'), tmp_path)

    result = check(spec_path, out, '--key', tmp_path / 'old-answer-key.docx')

    assert result.returncode == 2
    assert 'key numbering does not match the questions: missing 4' in result.stdout


def test_answers_without_a_key_document(tmp_path):
    _, spec_path, out = build(fixture('mcq'), tmp_path)

    result = check(spec_path, out)

    assert result.returncode == 2
    assert 'the spec has answers but no key document was given' in result.stdout


def test_paper_built_from_another_spec(tmp_path):
    _, _, out = build(fixture('mcq'), tmp_path)
    longer = fixture('mcq')
    longer['questions'].append({'text': 'Which tag makes a hyperlink?', 'options': ['<a>', '<link>', '<href>', '<url>'], 'answer': 'a'})
    longer['total_marks'] = 5

    result = check(write(longer, tmp_path / 'longer.json'), out, '--key', tmp_path / 'paper-answer-key.docx')

    assert result.returncode == 2
    assert 'paper numbering does not match the questions: missing 5' in result.stdout


def test_likert_sections_on_different_scales(tmp_path):
    spec = fixture('questionnaire')
    spec['sections'][2]['scale'] = ['Never', 'Rarely', 'Sometimes', 'Often', 'Always']

    result, _, _ = build(spec, tmp_path)

    assert result.returncode == 2
    assert 'Section C: Satisfaction uses a different scale' in result.stdout


def test_double_barrelled_likert_item_is_a_warning(tmp_path):
    spec = fixture('questionnaire')
    spec['sections'][1]['items'].append('The computers are fast and the printers work.')

    result, _, _ = build(spec, tmp_path)

    assert result.returncode == 0, result.stdout
    assert 'item 7 may ask two things at once' in result.stdout


def test_timetable_that_does_not_fill_the_session(tmp_path):
    spec = fixture('plan')
    spec['duration_minutes'] = 150

    result, _, _ = build(spec, tmp_path)

    assert result.returncode == 2
    assert 'the timetable spans 180 minutes but the plan is 150 minutes long' in result.stdout


def test_lecture_weeks_with_a_gap(tmp_path):
    spec = fixture('notes')
    spec['weeks'][1]['week'] = 3

    result, _, _ = build(spec, tmp_path)

    assert result.returncode == 2
    assert 'weeks are not numbered 1 to 2 in order: [1, 3]' in result.stdout


def test_bloom_levels_required_but_missing(tmp_path):
    spec = fixture('exam')
    del spec['sections'][2]['questions'][0]['bloom']
    spec['sections'][2]['questions'][1]['bloom'] = 'memorise'

    result, _, _ = build(spec, tmp_path)

    assert result.returncode == 2
    assert 'Q6 has no Bloom level' in result.stdout
    assert "Q7 has an unknown Bloom level 'memorise'" in result.stdout


def test_bad_arguments_exit_1(tmp_path):
    spec_path = write(fixture('mcq'), tmp_path / 'spec.json')

    assert check(spec_path, tmp_path / 'missing.docx').returncode == 1
    assert check(tmp_path / 'missing.json', tmp_path / 'missing.docx').returncode == 1
    assert script('check.py').returncode == 1
    assert check(spec_path, tmp_path / 'x.docx', '--bogus').returncode == 1


@pytest.mark.skipif(not (shutil.which('soffice') and shutil.which('pdftoppm')), reason='needs LibreOffice and poppler')
def test_render_flag_draws_page_one(tmp_path):
    _, spec_path, out = build(fixture('plan'), tmp_path)

    result = check(spec_path, out, '--render', '--qa-dir', tmp_path / 'qa')

    assert result.returncode == 0, result.stdout
    assert (tmp_path / 'qa' / 'paper-page.png').exists()


def test_render_flag_says_when_it_is_skipped(tmp_path):
    if shutil.which('soffice') and shutil.which('pdftoppm'):
        pytest.skip('LibreOffice is installed')
    _, spec_path, out = build(fixture('plan'), tmp_path)

    result = check(spec_path, out, '--render')

    assert result.returncode == 0
    assert 'render: skipped' in result.stdout
