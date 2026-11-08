"""Tests for skill/docx/scripts/straighten.py and the page turning in scan_to_docx.upright.

They draw Bangla in Nikosh and need OpenCV, so they run in the sandbox image:
    python -m pytest tests/skill/docx
"""
import sys
from pathlib import Path

import pytest
from PIL import Image, ImageDraw

from test_letter import BODY_LINE, typed_page

SCRIPTS = Path(__file__).resolve().parents[3] / 'skill' / 'docx' / 'scripts'
sys.path.insert(0, str(SCRIPTS))
pytest.importorskip('cv2')
import scan_to_docx  # noqa: E402
import straighten  # noqa: E402


def letter_page():
    return typed_page([(BODY_LINE, 60, 80 + 48 * row, 28, False) for row in range(22)], size=(1400, 1200))


def test_a_tilted_page_measures_its_tilt_and_a_straight_one_none():
    page = letter_page()
    assert straighten.page_tilt(page) == pytest.approx(0, abs=0.2)
    tilted = page.rotate(2.5, fillcolor='white', resample=Image.Resampling.BICUBIC)
    assert straighten.page_tilt(tilted) == pytest.approx(2.5, abs=0.3)


@pytest.mark.parametrize('turn, direction', [(0, None), (90, 'clockwise'), (180, 'upside_down'), (270, 'counterclockwise')])
def test_word_shapes_tell_how_a_page_was_turned(turn, direction):
    page = letter_page().rotate(turn, expand=True, fillcolor='white')
    assert straighten.word_direction(page) == (direction, True)


def test_a_page_with_a_few_words_gives_no_answer():
    page = typed_page([('অফিস আদেশ', 60, 80, 28, False)], size=(800, 600))
    assert straighten.word_direction(page) == (None, False)


def test_a_point_moves_with_the_picture_when_straightened():
    page = Image.new('L', (400, 300), 255)
    ImageDraw.Draw(page).rectangle([300, 40, 304, 44], fill=0)
    turned = page.rotate(10, fillcolor=255)
    ys, xs = zip(*[(y, x) for y in range(300) for x in range(400) if turned.getpixel((x, y)) < 128])
    x, y = straighten.turn_about_center((302, 42), 10, 400, 300)
    assert x == pytest.approx(sum(xs) / len(xs), abs=1.5)
    assert y == pytest.approx(sum(ys) / len(ys), abs=1.5)


def box(x0, y0, x1, y1, width, height):
    return {'coordinates': {'points': [[x0, y0], [x0, y1], [x1, y1], [x1, y0]],
                            'system': 'PixelSpace', 'layout_width': width, 'layout_height': height}}


def test_a_tilted_scan_is_straightened_and_its_boxes_follow(tmp_path):
    page = letter_page().rotate(3, fillcolor='white', resample=Image.Resampling.BICUBIC)
    path = tmp_path / 'page-1.png'
    page.save(path)
    center = straighten.turn_about_center((700, 300), 3, 1400, 1200)
    element = {'type': 'NarrativeText', 'text': 'সংশ্লিষ্ট সকলকে জানানো যাচ্ছে',
               'metadata': {'page_number': 1, **box(center[0] - 50, center[1] - 10, center[0] + 50, center[1] + 10, 1400, 1200)}}
    scan_to_docx.upright([element], [path])
    with Image.open(path) as straightened:
        assert straighten.page_tilt(straightened) == pytest.approx(0, abs=0.3)
    points = element['metadata']['coordinates']['points']
    assert (points[0][0] + points[2][0]) / 2 == pytest.approx(700, abs=3)
    assert (points[0][1] + points[2][1]) / 2 == pytest.approx(300, abs=3)


def test_a_page_too_short_for_the_line_rule_is_turned_by_its_word_shapes(tmp_path):
    page = letter_page().rotate(180, fillcolor='white')
    path = tmp_path / 'page-1.png'
    page.save(path)
    short = [{'type': 'Title', 'text': 'আদেশ', 'metadata': {'page_number': 1, **box(600, 1000, 800, 1040, 1400, 1200)}}]
    scan_to_docx.upright(short, [path])
    with Image.open(path) as turned:
        assert straighten.word_direction(turned) == (None, True)
    points = short[0]['metadata']['coordinates']['points']
    assert min(p[1] for p in points) == pytest.approx(160, abs=1)
