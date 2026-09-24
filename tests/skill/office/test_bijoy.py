"""Tests for office/bijoy.py: Bijoy (SutonnyMJ) text recognised and converted to Unicode.

The Bijoy strings are written the way the Bijoy keyboard stores them: ি ে ৈ before their consonant,
the reph after it. Pure Python, no fonts needed.
"""
import sys
import unicodedata

import pytest

from test_policy import SCRIPTS

sys.path.insert(0, str(SCRIPTS))
from office import bangla, bijoy  # noqa: E402

PAIRS = [
    ('miKvwi Kvh©vj‡qi cÖÁvcb Abyhvqx mswkøó Kg©KZ©v‡K Rvbv‡bv n‡jv',
     'সরকারি কার্যালয়ের প্রজ্ঞাপন অনুযায়ী সংশ্লিষ্ট কর্মকর্তাকে জানানো হলো'),
    ('welq: ‡iv‡Kqv ‡Pqvi 2026 wb‡qv‡Mi wbwgË g‡bvbqb AvnŸvb|',
     'বিষয়: রোকেয়া চেয়ার ২০২৬ নিয়োগের নিমিত্ত মনোনয়ন আহ্বান।'),
    ('Avwg evsjvq Mvb MvB', 'আমি বাংলায় গান গাই'),
    ('evsjv‡`k wek¦we`¨vjq gÄyix Kwgkb', 'বাংলাদেশ বিশ্ববিদ্যালয় মঞ্জুরী কমিশন'),
    ('MYcÖRvZš¿x evsjv‡`k miKvi', 'গণপ্রজাতন্ত্রী বাংলাদেশ সরকার'),
    ('Dch©y³ wel‡qi †cÖwÿ‡Z Rvbv‡bv hv‡”Q †h', 'উপর্যুক্ত বিষয়ের প্রেক্ষিতে জানানো যাচ্ছে যে'),
    ('wkÿv gš¿Yvjq', 'শিক্ষা মন্ত্রণালয়'),
    ('e¨e¯’v cÖwZôvb ¯^vÿi Awa`ßi', 'ব্যবস্থা প্রতিষ্ঠান স্বাক্ষর অধিদপ্তর'),
    ('‡gŠwjK ‡PŠayix', 'মৌলিক চৌধুরী'),
    ('ag© evZ©v Z`šÍ Z`š—', 'ধর্ম বার্তা তদন্ত তদন্ত'),
    ('W. ‡gvt Avãyjøvn', 'ড. মোঃ আব্দুল্লাহ'),
    ('ZvwiL: 19/09/2026', 'তারিখ: ১৯/০৯/২০২৬'),
    ('`yb©xwZ m~h© Avw_©K wb‡`©kbv KY©dzjx', 'দুর্নীতি সূর্য আর্থিক নির্দেশনা কর্ণফুলী'),
    ('Abywjwc cÖ‡qvRbxq e¨e¯’v Mªn‡Yi Rb¨', 'অনুলিপি প্রয়োজনীয় ব্যবস্থা গ্রহণের জন্য'),
    ('‡iwR÷ªvi DcvPvh© Aa¨vcK', 'রেজিস্ট্রার উপাচার্য অধ্যাপক'),
    ('¯œvZ‡KvËi', 'স্নাতকোত্তর'),
]


class TestToUnicode:
    @pytest.mark.parametrize(('typed', 'text'), PAIRS)
    def test_official_text(self, typed, text):
        assert bijoy.to_unicode(typed) == unicodedata.normalize('NFC', text)

    def test_vowel_signs_move_after_the_whole_cluster(self):
        assert bijoy.to_unicode('‡cÖg') == 'প্রেম'
        assert bijoy.to_unicode('w¯Íi') == 'স্তির'

    def test_o_and_au_signs_are_joined(self):
        assert bijoy.to_unicode('‡Kv') == 'কো'
        assert bijoy.to_unicode('‡KŠ') == 'কৌ'

    def test_reph_goes_before_its_cluster_past_vowel_signs(self):
        assert bijoy.to_unicode('Kgx©') == 'কর্মী'
        assert bijoy.to_unicode('Avw_©K') == 'আর্থিক'
        assert bijoy.to_unicode('wb‡`©k') == 'নির্দেশ'

    def test_a_candrabindu_typed_before_the_consonant_follows_the_sign(self):
        assert bijoy.to_unicode('‡uK') == unicodedata.normalize('NFC', 'কেঁ')

    def test_signs_typed_twice_count_once(self):
        assert bijoy.to_unicode('Kvv') == 'কা'

    def test_c1_controls_from_latin_1_readers(self):
        assert bijoy.to_unicode('\x87K') == 'কে'

    def test_nothing_private_is_left(self):
        for typed, _ in PAIRS:
            assert '' not in bijoy.to_unicode(typed)

    def test_bangla_to_unicode_normalises(self):
        assert bangla.to_unicode('evsjv', 'bijoy') == 'বাংলা'
        assert bangla.to_unicode('য়', 'unicode') == bangla.normalize('য়')


class TestConvertPieces:
    def test_a_word_split_across_runs_lands_whole_in_the_first(self):
        assert bijoy.convert_pieces(['w', 'K ', 'Kg', '©']) == ['কি', ' ', 'কর্ম', '']

    def test_whitespace_stays_in_its_piece(self):
        assert bijoy.convert_pieces(['Avwg ', 'evsjv']) == ['আমি ', 'বাংলা']

    def test_empty_pieces(self):
        assert bijoy.convert_pieces(['', 'evsjv', '']) == ['', 'বাংলা', '']


class TestRecognition:
    @pytest.mark.parametrize('name', ['SutonnyMJ', 'SutonnyMJ ', 'BijoyBaijayanta', 'Kalpurush ANSI', 'AdarshaLipiMJ'])
    def test_bijoy_fonts(self, name):
        assert bijoy.is_font(name)

    @pytest.mark.parametrize('name', ['SutonnyOMJ', 'Nikosh', 'Arial', None, ''])
    def test_other_fonts(self, name):
        assert not bijoy.is_font(name)

    @pytest.mark.parametrize('text', [typed for typed, _ in PAIRS[:6]] + ['Kg©KZ©v', 'wkÿv'])
    def test_bijoy_text(self, text):
        assert bangla.classify(text) == 'bijoy'

    @pytest.mark.parametrize(
        'text',
        [
            'Investigation Committee Report 2026',
            '© 2026 BdREN',
            'Café Müller bought an iPhone on Park Avenue',
            'VAT & AIT',
            'Memo No. 37.01.0000',
            'বাংলাদেশ',
            '',
        ],
    )
    def test_english_and_unicode_are_not_bijoy(self, text):
        assert not bijoy.looks_bijoy(text)
        assert bangla.classify(text) != 'bijoy'
