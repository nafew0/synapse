"""Tests for skill/pptx/scripts/check.py. Needs LibreOffice, python-pptx and markitdown."""
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from pptx import Presentation
from pptx.util import Inches, Pt

SCRIPT = Path(__file__).resolve().parents[3] / 'skill' / 'pptx' / 'scripts' / 'check.py'
pytestmark = pytest.mark.skipif(not (shutil.which('soffice') and shutil.which('markitdown')), reason='needs LibreOffice')


def deck(path, slides):
    presentation = Presentation()
    presentation.slide_width, presentation.slide_height = Inches(13.333), Inches(7.5)
    for title, body in slides:
        slide = presentation.slides.add_slide(presentation.slide_layouts[6])
        box = slide.shapes.add_textbox(Inches(0.5), Inches(0.4), Inches(12), Inches(0.8))
        box.text_frame.text = title
        box.text_frame.paragraphs[0].runs[0].font.size = Pt(32)
        box.text_frame.paragraphs[0].runs[0].font.name = 'Arial'
        if body:
            text = slide.shapes.add_textbox(Inches(0.5), Inches(1.5), Inches(4), Inches(1))
            text.text_frame.word_wrap = True
            text.text_frame.text = body
            text.text_frame.paragraphs[0].runs[0].font.size = Pt(18)
            text.text_frame.paragraphs[0].runs[0].font.name = 'Arial'
    presentation.save(path)


def test_a_clean_deck_passes_with_one_grid(tmp_path):
    deck(tmp_path / 'deck.pptx', [('Synapse AI', None), ('The problem', 'Short line.')])

    result = subprocess.run([sys.executable, SCRIPT, 'deck.pptx'], cwd=tmp_path, capture_output=True, text=True)

    assert result.returncode == 0, result.stdout + result.stderr
    assert 'layout: clean' in result.stdout
    assert (tmp_path / 'qa' / 'deck-grid.jpg').exists()


def test_overflow_and_placeholder_text_are_reported(tmp_path):
    deck(tmp_path / 'deck.pptx', [('Lorem ipsum', None), ('The problem', 'A long line that will not fit. ' * 30)])

    result = subprocess.run([sys.executable, SCRIPT, 'deck.pptx'], cwd=tmp_path, capture_output=True, text=True)

    assert result.returncode == 2
    assert 'overflow' in result.stdout
    assert 'Lorem ipsum' in result.stdout
