"""Tests for the shared Bangla modules in skill/*/scripts/office/.

Kept outside skill/ on purpose: every file in a deployment skill directory is uploaded into each
user's code sandbox.

The pure tests (classification, normalisation, font policy) run anywhere. Tests that measure,
embed or check fonts need fontconfig, fontTools and HarfBuzz with the sandbox's Bangla fonts
installed, and are skipped without them:
    python -m pytest tests/skill/office
"""
import filecmp
import importlib.util
import shutil
import sys
from pathlib import Path

import pytest

SKILLS = Path(__file__).resolve().parents[3] / 'skill'
SCRIPTS = SKILLS / 'docx' / 'scripts'
SHARED = ('bangla.py', 'bijoy.py', 'runs.py', 'fix_bangla.py', 'verify_bangla.py', 'render.py')

sys.path.insert(0, str(SCRIPTS))
from office import bangla  # noqa: E402

HAS_TOOLS = (
    shutil.which('fc-list') is not None
    and importlib.util.find_spec('uharfbuzz') is not None
    and importlib.util.find_spec('fontTools') is not None
)
HAS_NIKOSH = HAS_TOOLS and bangla.font_path('Nikosh') is not None
needs_fonts = pytest.mark.skipif(not HAS_NIKOSH, reason='needs fontconfig, fontTools, HarfBuzz and Nikosh')

SENTENCE = 'সরকারি কার্যালয়ের প্রজ্ঞাপন অনুযায়ী সংশ্লিষ্ট কর্মকর্তাকে জানানো হলো'


def test_every_skill_ships_the_same_copy():
    for name in SHARED:
        copies = [SKILLS / skill / 'scripts' / 'office' / name for skill in ('docx', 'xlsx', 'pptx')]
        assert all(copy.is_file() for copy in copies), name
        assert all(filecmp.cmp(copies[0], copy, shallow=False) for copy in copies[1:]), name


def test_pdf_to_docx_ships_the_same_bijoy_converter():
    shared = SKILLS / 'docx' / 'scripts' / 'office' / 'bijoy.py'
    assert filecmp.cmp(shared, SKILLS / 'pdf-to-docx' / 'scripts' / 'office' / 'bijoy.py', shallow=False)


class TestClassify:
    @pytest.mark.parametrize(
        ('text', 'kind'),
        [
            ('', 'none'),
            ('Investigation Committee', 'none'),
            ('বাংলাদেশ বিশ্ববিদ্যালয় মঞ্জুরী কমিশন', 'unicode'),
            ('তারিখ: ১৯ ভাদ্র ১৪৩৩ বঙ্গাব্দ, Dhaka-1207', 'unicode'),
            ('বাংলােদশ িবদালয়', 'broken'),
            ('িরসাচ ে◌', 'broken'),
            ('বাংলাদেশ িবদালয়', 'mixed'),
            ('à¦¬à¦¾à¦‚à¦²à¦¾', 'broken'),
            ('(cid:46)ষমতায়ন', 'mixed'),
            ('', 'broken'),
        ],
    )
    def test_kinds(self, text, kind):
        assert bangla.classify(text) == kind

    def test_real_circular_text_is_broken(self):
        """Lines as pdfplumber extracted them from the Rokeya Chair circular."""
        for line in ('বাংলােদশ িব িবদালয় ম ুরী কমিশন', 'িরসাচ " #া$টস এ $ড এওয়াড " িবভাগ'):
            assert bangla.classify(line) in ('broken', 'mixed')


class TestNormalize:
    def test_nukta_letters_compare_equal_in_either_form(self):
        assert bangla.normalize('য়') == bangla.normalize('য়')
        assert bangla.normalize('ড়') == bangla.normalize('ড়')

    def test_candrabindu_moves_after_its_vowel_sign(self):
        assert bangla.normalize('আগারগঁাও') == bangla.normalize('আগারগাঁও')

    def test_joiners_that_join_nothing_are_dropped(self):
        assert bangla.normalize('‌কমিশন‍') == 'কমিশন'
        assert bangla.normalize('র‍‍্য') == 'র‍্য'


class TestFontPolicy:
    @pytest.mark.parametrize('name', ['SutonnyMJ', 'SutonnyMJ ', 'BijoyBaijayanta', 'Kalpurush ANSI', 'AdarshaLipiMJ'])
    def test_bijoy_fonts(self, name):
        assert bangla.is_bijoy_font(name)
        assert bangla.font_for(name) == 'Nikosh'

    @pytest.mark.parametrize('name', ['SutonnyOMJ', 'Nikosh', 'SolaimanLipi', 'Nirmala UI', None])
    def test_not_bijoy(self, name):
        assert not bangla.is_bijoy_font(name)

    @pytest.mark.parametrize('name', ['Calibri', 'Arial', 'Times New Roman', 'Cambria', None, ''])
    def test_latin_or_missing_fonts_become_nikosh(self, name):
        assert bangla.font_for(name) == 'Nikosh'

    @pytest.mark.parametrize('name', ['Nirmala UI', 'Vrinda', 'Shonar Bangla'])
    def test_windows_bangla_fonts_are_kept(self, name):
        assert bangla.font_for(name) == name

    def test_an_unknown_font_is_trusted(self):
        assert bangla.can_draw('Some Office Font Nobody Installed Here')


@needs_fonts
class TestMeasurement:
    def test_nikosh_headline_matches_the_plan(self):
        assert bangla.headline('Nikosh') == pytest.approx(0.561, abs=0.002)
        assert bangla.headline('SolaimanLipi') == pytest.approx(0.621, abs=0.002)

    def test_size_for_keeps_the_visual_size(self):
        assert bangla.size_for('SolaimanLipi', 10.2) == 11.5
        assert bangla.size_for('Nikosh', 12) == 12
        assert bangla.size_for('A Font That Is Not Installed', 12) == 12

    def test_a_conjunct_is_narrower_than_its_letters(self):
        conjunct = bangla.measure('ক্ষ', 'Nikosh', 12)
        letters = bangla.measure('ক', 'Nikosh', 12) + bangla.measure('ষ', 'Nikosh', 12)
        assert conjunct < letters

    def test_nikosh_is_narrower_than_the_windows_fallback(self):
        nikosh = bangla.measure(SENTENCE, 'Nikosh', 1)
        fallback = bangla.measure(SENTENCE, 'Nirmala UI', 1)
        assert nikosh == pytest.approx(21.48, abs=0.05)
        assert fallback / nikosh > 1.25

    def test_latin_only_fonts_cannot_draw_bangla(self):
        assert not bangla.can_draw('DejaVu Sans')
        assert bangla.can_draw('Nikosh')
