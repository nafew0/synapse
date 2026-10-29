"""Tests for skill/docx/scripts/crop.py and letter.py.

Kept outside skill/docx/ on purpose: every file in a deployment skill directory is uploaded
into each user's code sandbox.

The build tests need LibreOffice, pdftoppm and fc-match, so they run in the sandbox image:
    python -m pytest tests/skill/docx
"""
import json
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest
from docx import Document
from PIL import Image, ImageDraw

SCRIPTS = Path(__file__).resolve().parents[3] / 'skill' / 'docx' / 'scripts'
needs_office = pytest.mark.skipif(
    not (shutil.which('soffice') and shutil.which('pdftoppm')), reason='needs LibreOffice and poppler'
)


def run(script, *args, cwd):
    return subprocess.run(
        [sys.executable, str(SCRIPTS / script), *map(str, args)], cwd=cwd, capture_output=True, text=True
    )


@pytest.fixture
def scan(tmp_path):
    """A cream page with a dark square 'logo' at 40-80 and a scribble 'signature' at 300-420."""
    page = Image.new('RGB', (600, 800), (250, 248, 235))
    draw = ImageDraw.Draw(page)
    draw.rectangle((40, 40, 80, 80), fill=(20, 20, 20))
    draw.line((300, 500, 360, 470, 420, 510), fill=(30, 30, 90), width=4)
    path = tmp_path / 'scan.png'
    page.save(path)
    return path


def test_crop_trims_to_ink_and_whitens_paper(scan, tmp_path):
    result = run('crop.py', scan, tmp_path / 'qa', 'logo=20,20,120,120', 'sig=280,440,440,540', cwd=tmp_path)

    assert result.returncode == 0, result.stdout
    logo = Image.open(tmp_path / 'qa' / 'logo.png')
    assert logo.width < 60 and logo.height < 60
    assert logo.getpixel((0, 0)) == (255, 255, 255)
    assert 'sig:' in result.stdout


def test_crop_reports_a_box_with_no_ink(scan, tmp_path):
    result = run('crop.py', scan, tmp_path / 'qa', 'empty=150,150,250,250', cwd=tmp_path)

    assert result.returncode == 1
    assert 'no ink' in result.stdout


def test_crop_read_writes_two_enlarged_halves(scan, tmp_path):
    result = run('crop.py', scan, tmp_path / 'qa', '--read', cwd=tmp_path)

    assert result.returncode == 0
    top = Image.open(tmp_path / 'qa' / 'read-top.png')
    assert top.width == 1200


def spec_for(scan_dir, body_paragraphs=1):
    return {
        'pages': 1,
        'blocks': [
            {'type': 'letterhead', 'logo': str(scan_dir / 'qa' / 'logo.png'), 'logo_width_cm': 1.5,
             'lines': [{'text': 'বাংলাদেশ বিশ্ববিদ্যালয় মঞ্জুরী কমিশন', 'size': 18, 'bold': True}]},
            {'type': 'memo', 'left': 'স্মারক নং- ১২৩', 'right': ['তারিখ : ০১ আশ্বিন ১৪৩৩', '১৬ সেপ্টেম্বর ২০২৬']},
            {'type': 'title', 'text': 'অফিস আদেশ', 'underline': True},
            *[{'type': 'paragraph', 'text': 'কমিশনের আইসিটি বিভাগে পদায়ন করা হলো। ' * 12}] * body_paragraphs,
            {'type': 'signature', 'intro': 'কর্তৃপক্ষের অনুমোদনক্রমে,', 'image': str(scan_dir / 'qa' / 'sig.png'),
             'lines': ['তাহমিনা রহমান', 'যুগ্মসচিব']},
            {'type': 'list', 'items': [['১।', 'সচিব, ইউজিসি, ঢাকা।'], ['২-১২।', 'পরিচালক, ইউজিসি, ঢাকা।']]},
        ],
    }


@needs_office
def test_letter_builds_one_valid_page_with_pictures_and_bangla_font_slot(scan, tmp_path):
    run('crop.py', scan, tmp_path / 'qa', 'logo=20,20,120,120', 'sig=280,440,440,540', cwd=tmp_path)
    (tmp_path / 'spec.json').write_text(json.dumps(spec_for(tmp_path), ensure_ascii=False), encoding='utf-8')

    result = run('letter.py', 'spec.json', 'order.docx', '--source', scan, cwd=tmp_path)

    assert result.returncode == 0, result.stdout + result.stderr
    assert 'pages: 1 (target 1)' in result.stdout
    assert 'pictures placed: 2' in result.stdout
    assert 'validation: passed' in result.stdout
    assert (tmp_path / 'qa' / 'order-compare.jpg').exists()
    document = Document(str(tmp_path / 'order.docx'))
    assert document.core_properties.author == 'Synapse'
    xml = zipfile.ZipFile(tmp_path / 'order.docx').read('word/document.xml').decode()
    assert 'w:cs="Nikosh"' in xml
    assert 'w:bidi="bn-BD"' in xml


@needs_office
def test_letter_shrinks_a_long_order_onto_one_page(scan, tmp_path):
    run('crop.py', scan, tmp_path / 'qa', 'logo=20,20,120,120', 'sig=280,440,440,540', cwd=tmp_path)
    (tmp_path / 'spec.json').write_text(json.dumps(spec_for(tmp_path, 9), ensure_ascii=False), encoding='utf-8')

    result = run('letter.py', 'spec.json', 'order.docx', cwd=tmp_path)

    assert 'pages: 1 (target 1)' in result.stdout, result.stdout + result.stderr
    assert 'builds 1' not in result.stdout
