"""Tests for skill/pptx/scripts/check_layout.py.

Kept outside skill/pptx/ on purpose: every file in a deployment skill directory is uploaded
into each user's code sandbox.

Run with python-pptx and Pillow installed:
    python -m pytest tests/skill/pptx
"""
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest
from pptx import Presentation
from pptx.util import Inches, Pt

SCRIPT = Path(__file__).resolve().parents[3] / 'skill' / 'pptx' / 'scripts' / 'check_layout.py'

spec = importlib.util.spec_from_file_location('check_layout', SCRIPT)
check_layout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check_layout)

LOREM = (
    'Help students and researchers find the right information faster while preserving a human '
    'route for anything sensitive, current, or unclear, and keep the promise short enough to read.'
)


def deck(tmp_path, build, name='deck.pptx'):
    presentation = Presentation()
    presentation.slide_width = Inches(13.333)
    presentation.slide_height = Inches(7.5)
    build(presentation.slides.add_slide(presentation.slide_layouts[6]))
    path = tmp_path / name
    presentation.save(path)
    return path


def textbox(slide, left, top, width, height, text, size=18, insets=0):
    box = slide.shapes.add_textbox(Inches(left), Inches(top), Inches(width), Inches(height))
    frame = box.text_frame
    # Generators set their own insets; python-pptx's 0.05" default would otherwise eat a
    # fifth of the short boxes these tests use and turn every case into an overflow.
    frame.margin_top = frame.margin_bottom = Inches(insets)
    frame.margin_left = frame.margin_right = Inches(insets)
    frame.text = text
    frame.paragraphs[0].runs[0].font.size = Pt(size)
    frame.paragraphs[0].runs[0].font.name = 'Calibri'
    return box


def card(slide, left, top, width, height):
    from pptx.enum.shapes import MSO_SHAPE

    return slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(left), Inches(top), Inches(width), Inches(height))


def kinds(result):
    return [finding['kind'] for finding in result['findings']]


def test_a_tidy_slide_reports_nothing(tmp_path):
    def build(slide):
        textbox(slide, 1, 1, 6, 0.6, 'Quarterly review', size=28)
        textbox(slide, 1, 2, 6, 1.5, 'Three sentences of body copy that comfortably fit.', size=14)

    assert check_layout.check(deck(tmp_path, build))['status'] == 'clean'


def test_text_far_larger_than_its_box_is_reported(tmp_path):
    def build(slide):
        textbox(slide, 1, 1, 4, 0.5, LOREM, size=21)

    result = check_layout.check(deck(tmp_path, build))

    assert result['status'] == 'defects_found'
    assert kinds(result) == ['overflow']
    assert 'text needs' in result['findings'][0]['detail']


def test_a_box_slightly_shorter_than_one_line_is_tolerated(tmp_path):
    """Authors declare tight boxes constantly; the glyphs sit proud and nobody sees it."""

    def build(slide):
        textbox(slide, 1, 1, 4, 0.26, 'Listen', size=16)

    assert check_layout.check(deck(tmp_path, build))['status'] == 'clean'


def test_a_modest_overflow_that_reaches_the_next_text_is_reported(tmp_path):
    """Two lines in a box sized for one and a half: too small to report on its own, but the
    second line lands on the caption underneath, which is what a reader sees."""

    def build(slide):
        textbox(slide, 1, 1, 1.6, 0.30, 'Approved policies, FAQs, service pages', size=12)
        textbox(slide, 1, 1.35, 1.6, 0.22, 'Record access and missing sources', size=12)

    result = check_layout.check(deck(tmp_path, build))

    assert 'overflow' in kinds(result)
    assert 'runs into the text below' in result['findings'][0]['detail']


def test_a_shape_drawn_over_existing_text_is_reported(tmp_path):
    def build(slide):
        textbox(slide, 1, 3, 3, 0.4, 'Fix high-impact failures', size=12)
        card(slide, 1.2, 2.9, 3, 0.9)

    result = check_layout.check(deck(tmp_path, build))

    assert kinds(result) == ['covered']
    assert 'is covered by' in result['findings'][0]['detail']


def test_text_placed_on_a_card_is_not_an_overlap(tmp_path):
    """The card comes first and the text sits on top — the correct authoring order."""

    def build(slide):
        card(slide, 1, 3, 3, 0.9)
        textbox(slide, 1.2, 3.2, 2.6, 0.4, 'Tune', size=16)

    assert check_layout.check(deck(tmp_path, build))['status'] == 'clean'


def test_a_shape_off_the_canvas_is_reported(tmp_path):
    def build(slide):
        textbox(slide, 12.5, 1, 4, 0.5, 'Runs off the right edge', size=14)

    result = check_layout.check(deck(tmp_path, build))

    assert 'off_slide' in kinds(result)


def test_template_furniture_a_hair_past_the_edge_is_tolerated(tmp_path):
    def build(slide):
        textbox(slide, 13.1, 7.1, 0.35, 0.22, '07', size=10)

    assert check_layout.check(deck(tmp_path, build))['status'] == 'clean'


def test_slides_can_be_limited(tmp_path):
    presentation = Presentation()
    presentation.slide_width = Inches(13.333)
    presentation.slide_height = Inches(7.5)
    for _ in range(3):
        slide = presentation.slides.add_slide(presentation.slide_layouts[6])
        textbox(slide, 1, 1, 4, 0.5, LOREM, size=21)
    path = tmp_path / 'many.pptx'
    presentation.save(path)

    result = check_layout.check(path, slides={2})

    assert {finding['slide'] for finding in result['findings']} == {2}


@pytest.mark.parametrize('value, expected', [('2,5', {2, 5}), ('3', {3}), (None, None), ('', None)])
def test_slide_selections_parse(value, expected):
    assert check_layout.parse_slides(value) == expected


def test_a_malformed_slide_selection_is_rejected():
    with pytest.raises(check_layout.InputError):
        check_layout.parse_slides('two')


def sized_deck(tmp_path, width, height, name):
    presentation = Presentation()
    presentation.slide_width = Inches(width)
    presentation.slide_height = Inches(height)
    presentation.slides.add_slide(presentation.slide_layouts[6])
    path = tmp_path / name
    presentation.save(path)
    return path


def test_a_four_three_deck_is_reported(tmp_path):
    result = check_layout.check(sized_deck(tmp_path, 10, 7.5, 'fourthree.pptx'))

    assert kinds(result) == ['aspect']
    assert 'not 16:9' in result['findings'][0]['detail']


def test_a_widescreen_deck_passes(tmp_path):
    assert check_layout.check(sized_deck(tmp_path, 13.333, 7.5, 'wide.pptx'))['status'] == 'clean'


def test_the_smaller_sixteen_nine_canvas_passes_on_ratio(tmp_path):
    """10" x 5.625" is still 16:9 — only a redesign that changes the source's canvas is a defect."""
    assert check_layout.check(sized_deck(tmp_path, 10, 5.625, 'small.pptx'))['status'] == 'clean'


def test_a_redesign_that_changes_the_canvas_is_reported(tmp_path):
    original = sized_deck(tmp_path, 13.333, 7.5, 'original.pptx')
    rebuilt = sized_deck(tmp_path, 10, 5.625, 'rebuilt.pptx')

    result = check_layout.check(rebuilt, original=original)

    assert kinds(result) == ['aspect']
    assert 'canvas changed' in result['findings'][0]['detail']


def test_a_redesign_that_keeps_the_canvas_passes(tmp_path):
    original = sized_deck(tmp_path, 13.333, 7.5, 'original.pptx')
    rebuilt = sized_deck(tmp_path, 13.333, 7.5, 'rebuilt.pptx')

    assert check_layout.check(rebuilt, original=original)['status'] == 'clean'


def cli(*args):
    completed = subprocess.run([sys.executable, str(SCRIPT), *map(str, args)], capture_output=True, text=True)
    return completed.returncode, completed.stdout


def test_cli_exits_zero_and_says_so_when_clean(tmp_path):
    def build(slide):
        textbox(slide, 1, 1, 6, 0.6, 'Quarterly review', size=28)

    code, output = cli(deck(tmp_path, build))

    assert code == 0
    assert 'clean' in output


def test_cli_exits_two_and_lists_defects(tmp_path):
    def build(slide):
        textbox(slide, 1, 1, 4, 0.5, LOREM, size=21)

    code, output = cli(deck(tmp_path, build), '--json')

    assert code == 2
    assert json.loads(output)['findings'][0]['kind'] == 'overflow'


def test_cli_reports_a_missing_file():
    code, output = cli('/nonexistent/deck.pptx')

    assert code == 1
    assert 'not found' in output.lower()
