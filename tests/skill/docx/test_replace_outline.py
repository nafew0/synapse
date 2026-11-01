"""Tests for the one-call text edit and outline scripts of the docx and pptx skills."""
import subprocess
import sys
import zipfile
from pathlib import Path

from docx import Document
from docx.oxml.ns import qn
from docx.shared import Pt
from pptx import Presentation
from pptx.util import Inches

ROOT = Path(__file__).resolve().parents[3] / 'skill'
REPLACE = ROOT / 'docx' / 'scripts' / 'replace.py'


def run(script, *args, cwd):
    return subprocess.run([sys.executable, script, *map(str, args)], cwd=cwd, capture_output=True, text=True)


def word(path):
    document = Document()
    document.settings.element.find(qn('w:zoom')).set(qn('w:percent'), '100')
    paragraph = document.add_paragraph()
    paragraph.add_run('ফোন : [').bold = True
    paragraph.add_run('?').font.size = Pt(20)
    paragraph.add_run('] (অফিস)')
    document.add_table(rows=1, cols=1).cell(0, 0).text = 'Total [?]'
    document.sections[0].footer.paragraphs[0].text = 'Draft [?]'
    document.save(path)


def test_replace_matches_across_runs_and_keeps_the_first_runs_formatting(tmp_path):
    word(tmp_path / 'a.docx')

    result = run(REPLACE, 'a.docx', 'b.docx', '[?]', '৫৮১৬০২৩৬', cwd=tmp_path)

    assert result.returncode == 0, result.stdout + result.stderr
    assert 'replaced 3x' in result.stdout
    document = Document(tmp_path / 'b.docx')
    assert document.paragraphs[0].text == 'ফোন : ৫৮১৬০২৩৬ (অফিস)'
    assert document.paragraphs[0].runs[0].bold is True
    assert document.tables[0].cell(0, 0).text == 'Total ৫৮১৬০২৩৬'
    assert 'Draft ৫৮১৬০২৩৬' in document.sections[0].footer.paragraphs[0].text


def test_replace_writes_nothing_when_a_phrase_is_missing_or_the_count_is_wrong(tmp_path):
    word(tmp_path / 'a.docx')

    missing = run(REPLACE, 'a.docx', 'b.docx', 'absent', 'x', cwd=tmp_path)
    count = run(REPLACE, 'a.docx', 'c.docx', '[?]', 'x', '--expect', '1', cwd=tmp_path)

    assert missing.returncode == 2 and 'NOT MATCHED' in missing.stdout
    assert count.returncode == 2 and 'WRONG COUNT' in count.stdout
    assert not (tmp_path / 'b.docx').exists() and not (tmp_path / 'c.docx').exists()


def test_replace_leaves_every_other_part_byte_identical(tmp_path):
    word(tmp_path / 'a.docx')

    run(REPLACE, 'a.docx', 'b.docx', 'অফিস', 'দপ্তর', cwd=tmp_path)

    with zipfile.ZipFile(tmp_path / 'a.docx') as a, zipfile.ZipFile(tmp_path / 'b.docx') as b:
        assert a.namelist() == b.namelist()
        assert [n for n in a.namelist() if a.read(n) != b.read(n)] == ['word/document.xml']


def test_replace_edits_a_deck_and_outline_shows_it(tmp_path):
    deck = Presentation()
    slide = deck.slides.add_slide(deck.slide_layouts[6])
    box = slide.shapes.add_textbox(Inches(1), Inches(1), Inches(4), Inches(1)).text_frame
    box.text = 'Pilot in '
    box.paragraphs[0].add_run().text = 'March'
    deck.save(tmp_path / 'a.pptx')

    replaced = run(ROOT / 'pptx' / 'scripts' / 'replace.py', 'a.pptx', 'b.pptx', 'in March', 'in May', cwd=tmp_path)
    outline = run(ROOT / 'pptx' / 'scripts' / 'outline.py', 'b.pptx', cwd=tmp_path)

    assert 'replaced 1x' in replaced.stdout
    assert 'Pilot in May' in outline.stdout and 'slide 1' in outline.stdout


def test_docx_outline_numbers_paragraphs_and_tables(tmp_path):
    word(tmp_path / 'a.docx')

    result = run(ROOT / 'docx' / 'scripts' / 'outline.py', 'a.docx', cwd=tmp_path)

    assert result.returncode == 0, result.stderr
    assert 'P1 [Normal] ফোন : [?] (অফিস)' in result.stdout
    assert 'R1: Total [?]' in result.stdout
    assert 'footer: Draft [?]' in result.stdout
