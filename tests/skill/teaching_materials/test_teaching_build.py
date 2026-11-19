"""Tests for skill/teaching-materials/scripts/build.py: each kind builds a Word file with the right structure.

Kept outside skill/ on purpose: every file in a deployment skill directory is uploaded into each
user's code sandbox. The render test needs LibreOffice and poppler and skips without them.
"""
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from docx import Document

SCRIPTS = Path(__file__).resolve().parents[3] / 'skill' / 'teaching-materials' / 'scripts'
FIXTURES = Path(__file__).resolve().parent / 'fixtures'
needs_office = pytest.mark.skipif(
    not (shutil.which('soffice') and shutil.which('pdftoppm')), reason='needs LibreOffice and poppler'
)


def build(spec, out, *extra):
    if isinstance(spec, dict):
        path = out.parent / f'{out.stem}-spec.json'
        path.write_text(json.dumps(spec), encoding='utf-8')
        spec = path
    return subprocess.run(
        [sys.executable, str(SCRIPTS / 'build.py'), str(spec), str(out), '--no-render', '--qa-dir', str(out.parent / 'qa'), *extra],
        capture_output=True,
        text=True,
    )


def fixture(name):
    return json.loads((FIXTURES / f'{name}.json').read_text(encoding='utf-8'))


def text_of(doc):
    return '\n'.join(p.text for p in doc.paragraphs)


def styled(doc, style):
    return [p.text for p in doc.paragraphs if p.style.name == style]


def footer_xml(doc):
    return doc.sections[0].footer._element.xml


def test_exam_paper_has_header_sections_marks_and_page_numbers(tmp_path):
    result = build(FIXTURES / 'exam.json', tmp_path / 'paper.docx')

    assert result.returncode == 0, result.stdout + result.stderr
    doc = Document(tmp_path / 'paper.docx')
    text = text_of(doc)
    assert 'IS 2104 – Database Systems' in text
    assert 'Instructions to candidates' in text
    assert styled(doc, 'Heading 2') == ['Section A (6 marks)', 'Section B (24 marks)', 'Section C (20 marks)']
    assert 'Each question carries 2 marks.' in text
    assert 'Answer any one question.' in text
    assert any(line.startswith('(a)\tDraw an ER diagram') for line in styled(doc, 'Question Part'))
    assert any(line.endswith('\t[8 marks]') for line in styled(doc, 'Question Part'))
    assert '[Total 14 marks]' in text
    assert any(line.startswith('5.\t') and line.endswith('[10 marks]') for line in styled(doc, 'Question'))
    assert 'a) WHERE\tb) HAVING\tc) ORDER BY\td) LIMIT' in text
    header_cells = [cell.text for cell in doc.tables[0].rows[0].cells]
    assert header_cells == ['Duration: Two (2) hours', 'Total marks: 50']
    assert 'instr="PAGE"' in footer_xml(doc) and 'instr="NUMPAGES"' in footer_xml(doc)
    assert 'Page' in doc.sections[0].footer.paragraphs[0].text


def test_exam_answers_go_only_to_the_key(tmp_path):
    result = build(FIXTURES / 'exam.json', tmp_path / 'paper.docx')

    assert result.returncode == 0, result.stdout
    key_path = tmp_path / 'paper-answer-key.docx'
    assert f'key: {key_path}' in result.stdout
    paper, key = text_of(Document(tmp_path / 'paper.docx')), text_of(Document(key_path))
    for answer in ('HAVING is applied after GROUP BY', 'Many-to-many enrolment relationship', 'composite primary key'):
        assert answer not in paper
        assert answer in key
    assert '(b) HAVING' in key
    assert 'Answer key and marking scheme' in key
    assert 'key numbering: matches the paper (7 entries)' in result.stdout


def test_key_path_can_be_chosen(tmp_path):
    result = build(FIXTURES / 'mcq.json', tmp_path / 'quiz.docx', '--key', str(tmp_path / 'answers.docx'))

    assert result.returncode == 0, result.stdout
    key = Document(tmp_path / 'answers.docx')
    assert styled(key, 'Question') == ['1.\t(c) <h1>\t[1 mark]', '2.\t(b) color\t[1 mark]',
                                       '3.\t(b) The first li that is a direct child of a ul\t[1 mark]', '4.\t(b) alt\t[1 mark]']


def test_mcq_set_shows_code_and_options(tmp_path):
    result = build(FIXTURES / 'mcq.json', tmp_path / 'quiz.docx')

    assert result.returncode == 0, result.stdout
    doc = Document(tmp_path / 'quiz.docx')
    text = text_of(doc)
    assert 'ul > li:first-child { font-weight: bold; }' in text
    assert 'a) title\tb) alt\tc) src\td) longdesc' in text
    assert 'a)\tEvery li inside any ul' in text
    assert 'CSS uses the property name color' not in text
    assert 'placeholders' not in result.stdout


def test_missing_header_fields_become_placeholders(tmp_path):
    spec = fixture('exam')
    for key in ('institution', 'course_code', 'duration'):
        del spec['header'][key]

    result = build(spec, tmp_path / 'paper.docx')

    assert result.returncode == 0, result.stdout
    text = text_of(Document(tmp_path / 'paper.docx'))
    assert '[Institution name]' in text and '[Course code]' in text
    assert 'placeholders to fill in: [Institution name], [Course code], [Duration]' in result.stdout


def test_questionnaire_has_likert_tables_choices_and_answer_lines(tmp_path):
    result = build(FIXTURES / 'questionnaire.json', tmp_path / 'survey.docx')

    assert result.returncode == 0, result.stdout
    doc = Document(tmp_path / 'survey.docx')
    scale = fixture('questionnaire')['scale']
    likert = [table for table in doc.tables if [c.text for c in table.rows[0].cells][-5:] == scale]
    assert [len(table.rows) for table in likert] == [4, 3]
    assert [c.text for c in likert[0].rows[1].cells] == ['4', 'There are enough computers in the library for students.'] + ['☐'] * 5
    assert likert[0].rows[0]._tr.trPr.find('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}tblHeader') is not None
    text = text_of(doc)
    assert '☐ First\t☐ Second\t☐ Third\t☐ Fourth' in text
    lines = [p for p in doc.paragraphs if not p.text and p._p.pPr is not None and p._p.pPr.find(
        '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}pBdr') is not None]
    assert len(lines) >= 4
    assert 'Likert: 5 items on a 5-point scale' in result.stdout
    assert 'key: none' in result.stdout


def test_lecture_notes_have_a_heading_per_week(tmp_path):
    result = build(FIXTURES / 'notes.json', tmp_path / 'notes.docx')

    assert result.returncode == 0, result.stdout
    doc = Document(tmp_path / 'notes.docx')
    assert styled(doc, 'Heading 1') == ['Week 1: Introduction to software engineering', 'Week 2: Process models']
    assert styled(doc, 'Heading 2').count('Learning outcomes') == 2
    assert 'The software life cycle' in styled(doc, 'Heading 3')
    assert 'instr="NUMPAGES"' in footer_xml(doc)


def test_workshop_plan_has_aim_objectives_and_timetable(tmp_path):
    result = build(FIXTURES / 'plan.json', tmp_path / 'plan.docx')

    assert result.returncode == 0, result.stdout
    doc = Document(tmp_path / 'plan.docx')
    assert styled(doc, 'Heading 2')[:4] == ['Aim', 'Objectives', 'Introduction', 'Timetable']
    timetable = doc.tables[1]
    assert [c.text for c in timetable.rows[0].cells] == ['Time', 'Activity', 'Details', 'Resources']
    assert len(timetable.rows) == 7
    assert 'timetable: 6 rows, 09:00 to 12:00, 180 minutes' in result.stdout


def test_bangla_text_uses_the_complex_script_font(tmp_path):
    spec = fixture('mcq')
    spec['questions'][0]['text'] = 'কোন উপাদানটি সবচেয়ে বড় শিরোনাম?'

    result = build(spec, tmp_path / 'quiz.docx')

    assert result.returncode == 0, result.stdout
    fonts = Document(tmp_path / 'quiz.docx').styles['Normal'].element.rPr.rFonts
    assert fonts.get('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}cs') == 'Nikosh'
    assert fonts.get('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}ascii') == 'Times New Roman'


def test_bad_spec_and_arguments_exit_1(tmp_path):
    (tmp_path / 'broken.json').write_text('{"kind": "exam",', encoding='utf-8')

    assert build(tmp_path / 'broken.json', tmp_path / 'a.docx').returncode == 1
    assert build({'kind': 'poster'}, tmp_path / 'b.docx').returncode == 1
    assert build(FIXTURES / 'exam.json', tmp_path / 'c.pdf').returncode == 1
    assert build(tmp_path / 'missing.json', tmp_path / 'd.docx').returncode == 1


@needs_office
def test_render_writes_page_one(tmp_path):
    result = subprocess.run(
        [sys.executable, str(SCRIPTS / 'build.py'), str(FIXTURES / 'exam.json'), str(tmp_path / 'paper.docx'),
         '--qa-dir', str(tmp_path / 'qa')],
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert (tmp_path / 'qa' / 'paper-page.png').exists()
    assert 'pages: ' in result.stdout


def test_worksheet_shows_worked_examples_and_answer_space(tmp_path):
    result = build(FIXTURES / 'worksheet.json', tmp_path / 'sheet.docx')

    assert result.returncode == 0, result.stdout
    doc = Document(tmp_path / 'sheet.docx')
    text = text_of(doc)
    assert 'Example 1. Is the relation R(A, B, C)' in text
    assert 'Solution: No. C depends on A only through B' in text
    assert 'R1(A, B) and R2(B, C)' not in text
    assert styled(doc, 'Question') == ['1.\tGive one reason for normalising a database.',
                                       '2.\tDecompose R(A, B, C) above into relations in 3NF.']
    assert 'R1(A, B) and R2(B, C)' in text_of(Document(tmp_path / 'sheet-answer-key.docx'))
    assert 'End of paper' not in text


def test_paper_and_key_are_a4_times_new_roman_11_with_larger_headers(tmp_path):
    result = build(fixture('exam'), tmp_path / 'paper.docx')
    assert result.returncode == 0, result.stdout

    for name in ('paper.docx', 'paper-answer-key.docx'):
        doc = Document(tmp_path / name)
        section = doc.sections[0]
        assert round(section.page_width.cm, 1) == 21.0 and round(section.page_height.cm, 1) == 29.7
        assert doc.styles['Normal'].font.name == 'Times New Roman'
        assert doc.styles['Normal'].font.size.pt == 11
        assert doc.styles['Heading 1'].font.size.pt > 11


def test_the_user_can_still_ask_for_another_size(tmp_path):
    spec = fixture('exam')
    spec['font'] = {'size': 12}
    assert build(spec, tmp_path / 'paper.docx').returncode == 0
    assert Document(tmp_path / 'paper.docx').styles['Normal'].font.size.pt == 12
