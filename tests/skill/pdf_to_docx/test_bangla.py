"""Tests for skill/pdf-to-docx/scripts/bangla.py: Bangla recovered from a broken PDF text layer.

The broken layer is reproduced without a Qt-built PDF: a word is shaped with HarfBuzz into the
glyphs a renderer draws, in the order it draws them, and each glyph is reported the way a
subsetting producer reports it — its character when it stands for one, `(cid:N)` when it is a
conjunct or a form. Recovering the original word from that is the whole job.
"""
import importlib.util
import unicodedata

import pytest

from helpers import load

bangla = load('bangla')

NOTO = next(
    (
        path
        for path in (
            '/usr/share/fonts/truetype/noto/NotoSansBengali-Regular.ttf',
            '/usr/share/fonts/google-noto/NotoSansBengali-Regular.ttf',
        )
        if __import__('pathlib').Path(path).is_file()
    ),
    None,
)
HAS_SHAPER = importlib.util.find_spec('uharfbuzz') is not None and importlib.util.find_spec('fontTools') is not None

WORDS = [
    'বাংলাদেশ', 'বিশ্ববিদ্যালয়', 'মঞ্জুরী', 'কমিশন', 'আগারগাঁও', 'শেরে', 'রিসার্চ', 'গ্রান্টস',
    'স্কলারশিপ', 'ফেলোশিপ', 'ভাদ্র', 'বঙ্গাব্দ', 'স্মারক', 'নম্বর', 'সেপ্টেম্বর', 'খ্রিস্টাব্দ',
    'নিয়োগের', 'নিমিত্ত', 'মনোনয়ন', 'আহ্বান', 'শিক্ষা', 'ক্ষমতায়ন', 'উন্নয়ন', 'অগ্রগতির',
    'ক্ষেত্রে', 'যাচ্ছেন', 'স্বীকৃতি', 'প্রদানের', 'লক্ষ্যে', 'অধ্যাপক', 'সর্বোচ্চ', 'কর্তৃপক্ষের',
    'বৃত্তান্তসহ', 'সংযুক্ত', 'বিজ্ঞপ্তি', 'উল্লেখ্য', 'সম্মাননা', 'কৃষি', 'প্রকৌশল', 'জ্যেষ্ঠতার',
    'রেজিস্ট্রার', 'কৌশল', 'দায়িত্ব', 'চট্টগ্রাম', 'শ্রী', 'ত্রৈমাসিক', 'পৌরসভা', 'কার্যার্থে',
]


class TestLogicalOrder:
    """Glyph texts in drawn order, as the fixed Qt output of a real UGC circular reported them."""

    @pytest.mark.parametrize(
        ('drawn', 'typed'),
        [
            (['ক', 'ি', 'ম', 'শ', 'ন'], 'কমিশন'),
            (['ে', 'স', 'ে', 'প্ট', 'ম্ব', 'র'], 'সেপ্টেম্বর'),
            (['ি', 'খ্র', 'স্ট', 'া', 'ব্দ'], 'খ্রিস্টাব্দ'),
            (['ি', 'ন', 'ে', 'য়', 'া', 'ে', 'গ', 'র'], 'নিয়োগের'),
            (['ি', 'ব', 'শ্ব', 'ি', 'ব', 'দ', '্য', 'া', 'ল', 'য়'], 'বিশ্ববিদ্যালয়'),
            (['আ', 'গ', 'া', 'র', 'গ', 'ঁ', 'া', 'ও'], 'আগারগাঁও'),
        ],
    )
    def test_pre_base_signs_and_split_vowels_go_back_where_they_are_typed(self, drawn, typed):
        assert bangla.logical_order(drawn) == typed

    @pytest.mark.parametrize(
        ('drawn', 'typed'),
        [
            (['স', 'ে', 'ব', 'া', 'র্', 'চ্চ'], 'সর্বোচ্চ'),
            (['ক', 'ত', 'ৃ', 'র্', 'প', 'ে', 'ক্ষ', 'র'], 'কর্তৃপক্ষের'),
        ],
    )
    def test_a_reph_drawn_after_its_syllable_is_typed_before_it(self, drawn, typed):
        assert bangla.logical_order(drawn) == typed

    def test_the_result_is_nfc(self):
        assert bangla.logical_order(['ে', 'ল', 'া']) == unicodedata.normalize('NFC', 'লো')

    def test_latin_passes_through(self):
        assert bangla.logical_order(['M', 'S', ' ', 'W', 'o', 'r', 'd']) == 'MS Word'


def test_an_old_spec_below_base_form_reads_as_virama_then_consonant():
    """`beng` fonts list ba-phala as ব + ্; read literally that is a half form, or for র a reph."""
    assert bangla._subjoined('ব্') == '্ব'
    assert bangla._subjoined('র্') == '্র'
    assert bangla._subjoined('্য') == '্য'
    assert bangla._subjoined('ক্ষ') == 'ক্ষ'


class TestDedupe:
    def char(self, x0, text='ক', top=100.0):
        return {'text': text, 'fontname': 'ABCDEF+SolaimanLipi', 'top': top, 'x0': x0, 'x1': x0 + 6}

    def test_a_glyph_overprinted_for_fake_bold_is_dropped_and_its_twin_marked_bold(self):
        first, twin = self.char(100.0), self.char(100.4)
        kept, bold = bangla.dedupe([first, twin])
        assert kept == [first]
        assert bold == {id(first)}

    def test_the_same_letter_twice_in_a_word_is_kept(self):
        kept, bold = bangla.dedupe([self.char(100.0), self.char(106.0)])
        assert len(kept) == 2 and not bold


def test_font_names_lose_their_subset_tag_and_slash():
    assert bangla.family_of('QWBAAA+SolaimanLipiNormal') == 'SolaimanLipiNormal'
    assert bangla.family_of('/Nikosh') == 'Nikosh'


@pytest.mark.skipif(NOTO is None or not HAS_SHAPER, reason='needs Noto Sans Bengali, uharfbuzz and fontTools')
class TestRecovery:
    """Every word, shaped and reported the way a subsetting producer reports it, comes back."""

    @pytest.fixture(scope='class')
    def decoder(self):
        from fontTools.ttLib import TTFont

        font = TTFont(NOTO)
        names = font.getGlyphOrder()
        glyph_names = {gid: name for gid, name in enumerate(names)}
        cmap = {name: chr(code) for code, name in font.getBestCmap().items()}
        unicode_map = {gid: cmap[name] for gid, name in glyph_names.items() if name in cmap}
        decoder = bangla.Decoder('Noto', unicode_map, glyph_names, bangla.glyph_texts(NOTO), NOTO)
        return decoder, unicode_map

    def drawn(self, word, unicode_map):
        """The glyph texts a producer reports for `word` as drawn, and the glyphs it drew."""
        import uharfbuzz

        font = uharfbuzz.Font(uharfbuzz.Face(uharfbuzz.Blob.from_file_path(NOTO)))
        buffer = uharfbuzz.Buffer()
        buffer.add_str(word)
        buffer.guess_segment_properties()
        uharfbuzz.shape(font, buffer)
        gids = [info.codepoint for info in buffer.glyph_infos]
        return [unicode_map.get(gid, f'(cid:{gid})') for gid in gids], gids

    @pytest.mark.parametrize('word', WORDS)
    def test_the_word_comes_back_as_typed_and_verifies(self, word, decoder):
        decoder, unicode_map = decoder
        reported, gids = self.drawn(word, unicode_map)
        tokens = [decoder.token(text) for text in reported]
        assert all(text is not None for text, _ in tokens), reported
        recovered = bangla.logical_order([text for text, _ in tokens])
        assert recovered == unicodedata.normalize('NFC', word)
        assert bangla.verify(recovered, decoder.glyph_names, gids, NOTO) is True

    def test_a_word_read_in_drawn_order_fails_verification(self, decoder):
        decoder, unicode_map = decoder
        _, gids = self.drawn('কমিশন', unicode_map)
        assert bangla.verify('কিমশন', decoder.glyph_names, gids, NOTO) is False


def _chars(text, fontname='ABCDEF+SutonnyMJ', x=10.0, top=100.0, size=12.0, advance=6.0):
    chars = []
    for letter in text:
        chars.append({'text': letter, 'fontname': fontname, 'x0': x, 'x1': x + advance, 'top': top, 'size': size})
        x += advance
    return chars


class TestBijoyPdf:
    """A PDF typed in SutonnyMJ extracts as the Latin codes that were typed."""

    @pytest.mark.parametrize('name', ['ABCDEF+SutonnyMJ', 'SutonnyMJ-Bold', 'SutonnyMJ,Bold', '/SutonnyMJ'])
    def test_bijoy_font_names(self, name):
        assert bangla.is_bijoy(name)

    def test_a_family_from_the_name_table_counts(self):
        assert bangla.is_bijoy('ABCDEF+Font1', {'Font1': 'SutonnyMJ'})
        assert not bangla.is_bijoy('ABCDEF+SolaimanLipiNormal', {'SolaimanLipiNormal': 'SolaimanLipi'})

    def test_words_are_converted_and_merged(self):
        chars = _chars('Avwg') + _chars('evsjv', x=50.0) + _chars('Dhaka', fontname='ABCDEF+Arial', x=90.0)
        counts = bangla.convert_bijoy_chars(chars)
        assert counts == {'SutonnyMJ': 2}
        kept = [char['text'] for char in chars if not bangla.merged_away(char)]
        assert kept == ['আমি', 'বাংলা', 'D', 'h', 'a', 'k', 'a']
        assert chars[0]['x1'] == chars[3]['x1']


class TestWordFont:
    """A run the PDF set in a Bangla font becomes Nikosh at the size that looks the same."""

    @pytest.fixture(autouse=True)
    def semantic(self):
        from office import bangla as fonts

        if fonts.font_path('Nikosh') is None or fonts.font_path('SolaimanLipi') is None:
            pytest.skip('needs Nikosh and SolaimanLipi installed')
        return load('semantic')

    def test_a_bangla_font_becomes_nikosh_at_the_converted_size(self, semantic):
        assert semantic._word_font('SolaimanLipi', 10.2) == ('Nikosh', 11.5)

    def test_nikosh_and_latin_fonts_keep_their_size(self, semantic):
        assert semantic._word_font('Nikosh', 12.04) == ('Nikosh', 12.0)
        assert semantic._word_font('NimbusSans', 10.24) == ('NimbusSans', 10.2)

    def test_no_size_stays_unset(self, semantic):
        assert semantic._word_font('SolaimanLipi', None) == ('Nikosh', None)
