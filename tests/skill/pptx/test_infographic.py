"""Tests for deck.py's infographic block with the skill's own library. Needs python-pptx and Pillow."""
import json
import subprocess
import sys
from pathlib import Path

from pptx import Presentation
from pptx.oxml.ns import qn

SKILL = Path(__file__).resolve().parents[3] / 'skill' / 'pptx'
SCRIPT = SKILL / 'scripts' / 'deck.py'
CYCLE = [['Plan', 'Set intake targets for each campus'], ['Promote', 'Visit schools and run the campaign'],
         ['Admit', 'Publish the merit list in May'], ['Review', 'Compare intake with the targets']]
BANGLA = [['পরিকল্পনা', 'প্রতিটি ক্যাম্পাসের লক্ষ্য ঠিক করা'], ['প্রচার', 'স্কুল পরিদর্শন ও প্রচার'],
          ['ভর্তি', 'মে মাসে মেধাতালিকা প্রকাশ'], ['পর্যালোচনা', 'লক্ষ্যের সাথে ভর্তি মেলানো']]


def run(tmp_path, slides, theme='Candy', out='deck.pptx'):
    spec = tmp_path / 'spec.json'
    spec.write_text(json.dumps({'theme': theme, 'slides': slides}, ensure_ascii=False))
    return subprocess.run([sys.executable, SCRIPT, spec, tmp_path / out, '--no-check'], capture_output=True, text=True)


def slot_texts(slide):
    texts = {}
    for shape in slide.shapes._spTree.iter(qn('p:sp')):
        name = shape.find(qn('p:nvSpPr') + '/' + qn('p:cNvPr')).get('name', '')
        if name.startswith('slot:'):
            texts[name] = ''.join(t.text or '' for t in shape.iter(qn('a:t')))
    return texts


def manifest():
    return json.loads((SKILL / 'infographics' / 'manifest.json').read_text(encoding='utf8'))


def test_library_files_match_the_manifest():
    designs = manifest()
    assert designs
    for design in designs:
        deck = Presentation(SKILL / 'infographics' / design['file'])
        assert design['slide'] <= len(deck.slides)
        assert 'head' in design['roles'] or 'text' in design['roles']


def test_cycle_is_filled_in_order(tmp_path):
    result = run(tmp_path, [{'layout': 'content', 'title': 'Admissions run as a four-stage cycle',
                             'infographic': {'kind': 'cycle', 'items': CYCLE}}])
    assert result.returncode == 0, result.stdout
    texts = slot_texts(Presentation(tmp_path / 'deck.pptx').slides[0])
    heads = [texts.get(f'slot:item{n}.head') or texts.get(f'slot:item{n}.text', '') for n in range(1, 5)]
    for (head, _), text in zip(CYCLE, heads):
        assert text.startswith(head)
    assert not any('TITLE' in t or 'Make a big impact' in t for t in texts.values())


def test_bangla_items_get_nikosh(tmp_path):
    result = run(tmp_path, [{'layout': 'content', 'title': 'ভর্তি চলে চার ধাপের একটি চক্রে',
                             'infographic': {'kind': 'cycle', 'items': BANGLA}}], theme='Growing_Liberty')
    assert result.returncode == 0, result.stdout
    slide = Presentation(tmp_path / 'deck.pptx').slides[0]
    bangla_runs = [r for r in slide.shapes._spTree.iter(qn('a:r')) if 'পরিকল্পনা' in (r.findtext(qn('a:t')) or '')]
    assert bangla_runs
    rpr = bangla_runs[0].find(qn('a:rPr'))
    assert rpr.find(qn('a:cs')).get('typeface') == 'Nikosh'


def test_same_spec_picks_same_design_and_a_deck_never_repeats_one(tmp_path):
    slides = [{'layout': 'content', 'title': f'Cycle {n}', 'infographic': {'kind': 'cycle', 'items': CYCLE}} for n in range(3)]
    run(tmp_path, slides, out='a.pptx')
    run(tmp_path, slides, out='b.pptx')
    first = [len(list(s.shapes._spTree.iter(qn('p:sp')))) for s in Presentation(tmp_path / 'a.pptx').slides]
    second = [len(list(s.shapes._spTree.iter(qn('p:sp')))) for s in Presentation(tmp_path / 'b.pptx').slides]
    assert first == second
    assert len(set(first)) > 1


def test_designs_are_coloured_by_theme_slots(tmp_path):
    run(tmp_path, [{'layout': 'content', 'title': 'Admissions cycle', 'infographic': {'kind': 'cycle', 'items': CYCLE}}])
    slide = Presentation(tmp_path / 'deck.pptx').slides[0]
    accents = [c for c in slide.shapes._spTree.iter(qn('a:schemeClr')) if c.get('val', '').startswith('accent')]
    assert len(accents) >= 4


def test_problems_name_the_fix(tmp_path):
    result = run(tmp_path, [
        {'layout': 'content', 'title': 'x', 'infographic': {'kind': 'spiral', 'items': CYCLE}},
        {'layout': 'content', 'title': 'x', 'infographic': {'kind': 'cycle', 'items': CYCLE * 3}},
        {'layout': 'content_dark', 'title': 'x', 'infographic': {'kind': 'cycle', 'items': CYCLE}},
        {'layout': 'content', 'title': 'x', 'infographic': {'kind': 'cycle', 'items': [['Admissions' * 120, 'x'], *CYCLE[1:]]}},
    ], theme='Growing_Liberty')
    assert result.returncode == 2
    assert "slide 1: no infographic kind 'spiral'; use one of:" in result.stdout
    assert 'slide 2: cycle designs take 3, 4, 5, 6 items, not 12' in result.stdout
    assert 'slide 3: infographics are drawn for light backgrounds' in result.stdout
    assert 'slide 4: no cycle design fits this text' in result.stdout
