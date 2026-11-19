"""Tests for skill/docx/scripts/check.py. Needs LibreOffice and poppler: run in the sandbox image."""
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from docx import Document
from docx.oxml.ns import qn
from PIL import Image

SCRIPT = Path(__file__).resolve().parents[3] / 'skill' / 'docx' / 'scripts' / 'check.py'
pytestmark = pytest.mark.skipif(not shutil.which('soffice'), reason='needs LibreOffice')


def test_a_long_document_is_shown_as_one_grid(tmp_path):
    document = Document()
    for index in range(120):
        document.add_paragraph(f'Paragraph {index}: ' + 'the committee met and agreed the budget. ' * 6)
    zoom = document.settings.element.find(qn('w:zoom'))
    zoom.set(qn('w:percent'), '100')  # python-docx's template omits it, which the validator rightly rejects
    document.save(tmp_path / 'report.docx')

    result = subprocess.run([sys.executable, SCRIPT, 'report.docx'], cwd=tmp_path, capture_output=True, text=True)

    assert result.returncode == 0, result.stdout + result.stderr
    assert 'validation: passed' in result.stdout
    pages = int(next(line for line in result.stdout.splitlines() if line.startswith('pages:')).split()[1])
    assert pages > 3
    grid = Image.open(tmp_path / 'qa' / 'report-pages.jpg')
    assert grid.width <= 1800


def test_a_missing_build_output_is_reported(tmp_path):
    result = subprocess.run([sys.executable, SCRIPT, 'nothing.docx'], cwd=tmp_path, capture_output=True, text=True)

    assert result.returncode == 2
    assert 'no document' in result.stdout
