"""Tests for skill/pptx/scripts/deck.py. Needs python-pptx and Pillow."""
import json
import subprocess
import sys
from pathlib import Path

from PIL import Image
from pptx import Presentation
from pptx.oxml.ns import qn
from pptx.util import Inches

SCRIPT = Path(__file__).resolve().parents[3] / 'skill' / 'pptx' / 'scripts' / 'deck.py'
LAYOUTS = {0: 'cover', 1: 'content', 2: 'section'}


def make_theme(folder):
    presentation = Presentation()
    presentation.slide_width, presentation.slide_height = Inches(13.333), Inches(7.5)
    for index, name in LAYOUTS.items():
        presentation.slide_layouts[index]._element.find(qn('p:cSld')).set('name', name)
    presentation.save(folder / 'Test.pptx')
    (folder / 'Test.json').write_text(json.dumps({
        'name': 'Test', 'description': 'Plain test theme.', 'file': 'Test.pptx',
        'fonts': {'latin': 'Arial', 'bangla': 'Nikosh'},
        'colors': {'primary': '1E86C1', 'accent': 'E54B89', 'emphasis': '166A9A', 'ink': '222222',
                   'muted': '666666', 'tint': 'E6F2FA', 'chart': ['1E86C1', '5CC75C']},
        'layouts': {'cover': {'role': 'cover'}, 'content': {}, 'section': {'role': 'section', 'dark': True}},
    }))


def run(tmp_path, slides, out='deck.pptx'):
    themes = tmp_path / 'themes'
    themes.mkdir(exist_ok=True)
    make_theme(themes)
    spec = tmp_path / 'spec.json'
    spec.write_text(json.dumps({'theme': 'test', 'slides': slides}, ensure_ascii=False))
    result = subprocess.run(
        [sys.executable, SCRIPT, spec, tmp_path / out, '--themes', themes, '--no-check'],
        capture_output=True, text=True,
    )
    return result


def texts(slide):
    found = []
    for shape in slide.shapes:
        if shape.has_text_frame:
            found.append(shape.text_frame.text)
        if shape.has_table:
            found.extend(cell.text for row in shape.table.rows for cell in row.cells)
    return ' | '.join(found)


def test_every_block_builds(tmp_path):
    Image.new('RGB', (400, 300), (30, 90, 140)).save(tmp_path / 'photo.png')
    slides = [
        {'layout': 'cover', 'title': 'Admissions 2026', 'subtitle': 'Board briefing'},
        {'layout': 'content', 'title': 'Admissions rose 12%', 'bullets': ['Sylhet grew most', 'Dhaka held steady'],
         'source': 'Source: Registrar', 'notes': 'Say the number first.'},
        {'layout': 'content', 'title': 'Three needs', 'cards': [['Staff', 'Hire 14'], ['Space', 'Lease a floor'], ['Systems', 'Move portal']]},
        {'layout': 'content', 'title': 'The figures', 'stats': [['4,120', 'admitted, up 12%'], ['৳2.5 cr', 'extra income']]},
        {'layout': 'content', 'title': 'Hiring', 'steps': [['Approve', 'December'], ['Advertise', 'Two weeks'], ['Offer', 'February']]},
        {'layout': 'content', 'title': 'By campus', 'chart': {'type': 'bar', 'labels': ['Dhaka', 'Sylhet'],
         'series': [{'name': 'Admitted', 'values': [1650, 980]}], 'highlight': 1}, 'takeaway': 'Sylhet needs a registrar'},
        {'layout': 'content', 'title': 'Costs', 'table': [['Item', 'Cost'], ['Lecturers', '৳1.40 cr']]},
        {'layout': 'content', 'title': 'In their words', 'quote': 'Hire before spring.', 'by': 'Registrar'},
        {'layout': 'content', 'title': 'The new room', 'text': 'Two racks on backup power.', 'image': str(tmp_path / 'photo.png')},
        {'layout': 'section', 'title': 'Part two'},
    ]
    result = run(tmp_path, slides)
    assert result.returncode == 0, result.stdout
    deck = Presentation(tmp_path / 'deck.pptx')
    assert len(deck.slides) == len(slides)
    assert 'Sylhet grew most' in texts(deck.slides[1]) and 'Source: Registrar' in texts(deck.slides[1])
    assert deck.slides[1].notes_slide.notes_text_frame.text == 'Say the number first.'
    assert 'Lease a floor' in texts(deck.slides[2])
    assert any(shape.has_chart for shape in deck.slides[5].shapes)
    assert 'Sylhet needs a registrar' in texts(deck.slides[5])
    assert '৳1.40 cr' in texts(deck.slides[6])
    assert any(shape.shape_type == 13 for shape in deck.slides[8].shapes)


def test_runs_carry_size_colour_and_bangla_font(tmp_path):
    result = run(tmp_path, [{'layout': 'content', 'title': 'ভর্তি ১২% বেড়েছে', 'bullets': ['সিলেটে সবচেয়ে বেশি', 'Dhaka held steady']}])
    assert result.returncode == 0, result.stdout
    slide = Presentation(tmp_path / 'deck.pptx').slides[0]
    runs = [run for shape in slide.shapes if shape.has_text_frame for p in shape.text_frame.paragraphs for run in p.runs]
    assert all(run.font.size is not None and run.font.color.rgb is not None for run in runs)
    bangla = [run for run in runs if run.text.startswith('সিলেটে')][0]
    latin = [run for run in runs if run.text.startswith('Dhaka')][0]
    rpr = bangla._r.find(qn('a:rPr'))
    assert rpr.get('lang') == 'bn-BD'
    assert rpr.find(qn('a:cs')).get('typeface') == 'Nikosh'
    assert bangla.font.size > latin.font.size


def test_unused_placeholders_are_removed(tmp_path):
    result = run(tmp_path, [{'layout': 'cover', 'title': 'Admissions 2026'}])
    assert result.returncode == 0, result.stdout
    slide = Presentation(tmp_path / 'deck.pptx').slides[0]
    assert [shape.placeholder_format.idx for shape in slide.placeholders] == [0]


def test_problems_are_listed_and_nothing_is_written(tmp_path):
    result = run(tmp_path, [
        {'layout': 'cover', 'title': 'x', 'bullets': ['a']},
        {'layout': 'nope', 'title': 'x'},
        {'layout': 'content', 'title': 'x', 'cards': [['a', 'b'], ['c', 'd']], 'chart': {'type': 'bar'}},
        {'layout': 'content', 'title': 'x', 'cards': [['a', 'b']]},
        {'layout': 'content', 'title': 'x', 'bullets': ['Admissions rose at both new campuses this year'] * 30},
    ])
    assert result.returncode == 2
    assert not (tmp_path / 'deck.pptx').exists()
    lines = result.stdout.splitlines()
    assert lines[0].startswith('not built')
    assert 'slide 1: cover is a cover layout' in result.stdout
    assert "slide 2: no layout 'nope'" in result.stdout and 'cover, content, section' in result.stdout
    assert 'slide 3: one content block per slide' in result.stdout
    assert 'slide 4: cards takes 2-4 items, got 1' in result.stdout
    assert 'slide 5: bullets need more room' in result.stdout


def test_unknown_theme_names_the_themes(tmp_path):
    themes = tmp_path / 'themes'
    themes.mkdir()
    make_theme(themes)
    spec = tmp_path / 'spec.json'
    spec.write_text(json.dumps({'theme': 'Missing', 'slides': [{'layout': 'cover', 'title': 'x'}]}))
    result = subprocess.run([sys.executable, SCRIPT, spec, tmp_path / 'd.pptx', '--themes', themes], capture_output=True, text=True)
    assert result.returncode == 2
    assert "no theme 'Missing'; use one of: Test" in result.stdout


def test_list_shows_layouts(tmp_path):
    themes = tmp_path / 'themes'
    themes.mkdir()
    make_theme(themes)
    result = subprocess.run([sys.executable, SCRIPT, '--list', '--themes', themes], capture_output=True, text=True)
    assert result.returncode == 0
    assert 'Test: Plain test theme.' in result.stdout
    assert 'section (section, dark)' in result.stdout
