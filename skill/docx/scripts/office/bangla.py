"""Bangla text in Office files: what it is, which font draws it, and how much room it needs.

One policy for every skill, so a document, a workbook and a deck built from the same request set
Bangla the same way:

- New Bangla text is set in Nikosh, the font Bangladeshi government and university offices
  already use. The sandbox has the real Nikosh file, so what is measured and rendered here is
  what the user sees. Windows names such as Nirmala UI only resolve to a stand-in in the sandbox.
- Existing Bangla keeps the document's font, unless that font cannot draw Bangla or is a Bijoy
  (ANSI) font whose glyphs no longer match Unicode text.
- Nikosh goes in the complex-script slot only; the Latin slot keeps the document's own font.

Nikosh draws Bangla about 11 % smaller than other Bangla fonts at the same point size, so a size
carried over from another font is converted with `size_for`, not copied.

Everything needing font files (`measure`, `headline`, `size_for`, `can_draw`) degrades to None or
a safe answer when fontconfig, fontTools or HarfBuzz are missing, and callers fall back to their
own estimates.
"""
import re
import subprocess
import unicodedata
from functools import lru_cache

from office import bijoy

DEFAULT_FONT = 'Nikosh'
LANGUAGE = 'bn-BD'
BENGALI = re.compile('[\u0980-\u09ff]')
BENGALI_RUN = re.compile('[\u0980-\u09ff\u200c\u200d]+')
DOTTED_CIRCLE = '\u25cc'
PRIVATE_USE = re.compile('[\ue000-\uf8ff]')
MOJIBAKE = re.compile('à[¦§]')
"""UTF-8 Bangla read as Latin-1: every Bengali code point starts with the bytes E0 A6 or E0 A7."""
CID = re.compile(r'\(cid:\d+\)')
VOWEL_SIGNS = set('\u09be\u09bf\u09c0\u09c1\u09c2\u09c3\u09c4\u09c7\u09c8\u09cb\u09cc\u09d7')
COMBINING = VOWEL_SIGNS | set('\u0981\u0982\u0983\u09bc\u09cd')
"""Signs that belong to the letter before them; a word never starts with one."""
CANDRABINDU_BEFORE_SIGN = re.compile('\u0981([\u09be-\u09cc\u09d7])')
JOINERS_AT_EDGE = re.compile('(^|(?<=\\s))[\u200c\u200d]+|[\u200c\u200d]+(?=\\s|$)')
REPEATED_JOINER = re.compile('([\u200c\u200d])\\1+')

LATIN_ONLY = {
    'arial', 'calibri', 'calibri light', 'cambria', 'times new roman', 'aptos', 'helvetica',
    'liberation sans', 'liberation serif', 'dejavu sans', 'georgia', 'verdana', 'segoe ui',
    'tahoma', 'courier new', 'consolas', 'garamond', 'book antiqua', 'century gothic',
}
"""Fonts with no Bengali glyphs. Naming one for Bangla makes Word, Excel or PowerPoint pick a
substitute on the user's PC, so the text appears in a face nobody chose."""
KNOWN_WINDOWS = {'nirmala ui', 'vrinda', 'shonar bangla'}
"""Bangla fonts that ship with Windows. The sandbox has only stand-ins for them, so they are
accepted by name rather than by reading a font file."""

SPLIT_NUKTA = re.compile('([ডঢয])\u09bc')
PRECOMPOSED = {'ড': '\u09dc', 'ঢ': '\u09dd', 'য': '\u09df'}
"""NFC splits ড় ঢ় য় into letter + nukta (U+09BC): Unicode excludes them from composition. Word
draws the pair with the font's own rules, and Nikosh has none for it, so the dot lands beside the
letter (বিশ্ববিদ্যালয্‌). LibreOffice and macOS compose it themselves, which hides the fault."""

HEADLINE_LETTERS = 'কব'
ROUND_TO = 0.5

SIZES = {
    'docx': {
        'body': 13, 'table': 13, 'letterhead': 15, 'subject': 13, 'heading1': 17, 'heading2': 15,
        'heading3': 13, 'footer': 11,
    },
    'pptx': {'body': 20, 'title': 36, 'subtitle': 24, 'footer': 14},
    'xlsx': {'body': 12, 'title': 15, 'subtitle': 13, 'header': 12, 'notes': 11},
}
"""Point sizes for Nikosh in a new document with nothing to copy sizes from. Provisional: derived
from Nikosh drawing 13.3 pt where other Bangla fonts draw 12 pt, not from real government Word
files. Letters and notices use only body, letterhead, subject and footer. Headings are bold."""


def has_bangla(text):
    return bool(text) and BENGALI.search(text) is not None


def _broken_word(word):
    if word[0] in COMBINING:
        return True
    return any(a in VOWEL_SIGNS and b in VOWEL_SIGNS for a, b in zip(word, word[1:], strict=False))


def classify(text):
    """'none', 'unicode', 'bijoy', 'broken' or 'mixed' for a piece of text.

    Broken text has Bengali code points a keyboard never types: a word starting with a vowel sign
    or virama (the drawn-order text a broken PDF layer gives, িবদালয় for বিদ্যালয়), two vowel
    signs in a row, dotted circles, private-use glyphs, `(cid:N)` placeholders or UTF-8 read as
    Latin-1. Bijoy (ANSI) text has no Bengali code points; without its font name it is recognised
    by its codes and shapes (`bijoy.looks_bijoy`), which is a guess.
    """
    if not text:
        return 'none'
    garbage = bool(PRIVATE_USE.search(text) or MOJIBAKE.search(text) or CID.search(text) or DOTTED_CIRCLE in text)
    words = BENGALI_RUN.findall(unicodedata.normalize('NFC', text))
    if not words:
        if garbage:
            return 'broken'
        return 'bijoy' if bijoy.looks_bijoy(text) else 'none'
    broken = sum(1 for word in words if _broken_word(word))
    if broken == 0 and not garbage:
        return 'unicode'
    if broken == len(words):
        return 'broken'
    return 'mixed'


def normalize(text):
    """The canonical form two Bangla texts are compared in.

    NFC, with candrabindu after the vowel sign it sits on (the order HarfBuzz and Word type it
    in) and zero-width joiners that join nothing removed. NFC decomposes the nukta letters
    ড় ঢ় য় into letter + ়, so input and output compare equal whichever form each used.
    """
    text = unicodedata.normalize('NFC', text or '')
    text = CANDRABINDU_BEFORE_SIGN.sub(lambda m: m.group(1) + '\u0981', text)
    text = REPEATED_JOINER.sub(r'\1', JOINERS_AT_EDGE.sub('', text))
    return unicodedata.normalize('NFC', text)


def compose(text):
    """Text with ড় ঢ় য় as the single characters every Bangla font draws, for writing into a file.

    Comparisons use `normalize`, where both forms are equal; text written for Word uses this."""
    return SPLIT_NUKTA.sub(lambda match: PRECOMPOSED[match.group(1)], text) if text else text


def has_split_nukta(text):
    return bool(text) and SPLIT_NUKTA.search(text) is not None


def is_bijoy_font(name):
    return bijoy.is_font(name)


def to_unicode(text, kind='bijoy'):
    """Unicode Bangla for `text` of the given `classify` kind, normalised.

    Bijoy text is converted with `bijoy.to_unicode`. Broken text from a PDF's text layer can only
    be recovered with the PDF's own glyphs (pdf-to-docx `bangla.py`), so here it is only
    normalised."""
    if kind == 'bijoy':
        text = bijoy.to_unicode(text)
    return normalize(text)


def font_for(existing=None):
    """The font a Bangla run should name in its complex-script slot.

    The document's own font when it can draw Bangla; Nikosh when there is none, when it is a
    Latin-only font, or when it is a Bijoy font (whose text is converted to Unicode)."""
    if not existing or is_bijoy_font(existing) or not can_draw(existing):
        return DEFAULT_FONT
    return existing


def _fontconfig(args):
    try:
        found = subprocess.run(args, capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return ''
    return found.stdout.strip()


@lru_cache(maxsize=64)
def font_path(name, bold=False, italic=False):
    """The file of the installed font whose family is exactly `name`, or None.

    Only an exact family match counts. fc-match always answers with something, and measuring a
    substitute would report the substitute's size as the named font's."""
    if not name:
        return None
    style = ' '.join(part for part, on in (('Bold', bold), ('Italic', italic)) if on)
    listed = _fontconfig(['fc-list', f':family={name}' + (f':style={style}' if style else ''), 'file'])
    if not listed and style:
        listed = _fontconfig(['fc-list', f':family={name}', 'file'])
    files = sorted(line.split(':')[0].strip() for line in listed.splitlines() if line.strip())
    return files[0] if files else None


@lru_cache(maxsize=64)
def substitute_path(name):
    """The file fontconfig draws `name` with, alias or not: what LibreOffice renders."""
    return _fontconfig(['fc-match', '-f', '%{file}', name or DEFAULT_FONT]) or None


@lru_cache(maxsize=64)
def _covers_bengali(path):
    try:
        from fontTools.ttLib import TTFont

        cmap = TTFont(path, lazy=True).getBestCmap() or {}
    except Exception:  # noqa: BLE001 - an unreadable font draws nothing
        return False
    return all(ord(letter) in cmap for letter in 'অকখগবমরলশসহািীুেো্')


def is_bangla_font(name):
    """Whether `name` is a Unicode Bangla font: one Windows ships, or an installed font whose cmap
    covers Bengali. Unlike `can_draw`, a font that is not installed is not trusted."""
    if not name or is_bijoy_font(name):
        return False
    if name.strip().lower() in KNOWN_WINDOWS:
        return True
    path = font_path(name)
    return path is not None and _covers_bengali(path)


def can_draw(name):
    """Whether a font named `name` draws Bangla on the user's PC.

    True for the Bangla fonts Windows ships and for installed fonts whose cmap covers Bengali,
    False for known Latin-only fonts and for Bijoy fonts. A name that is neither installed nor
    known is trusted: the checks cannot see the user's PC, and rejecting every font they have
    not heard of would make an office's own font a failure."""
    if not name:
        return False
    key = name.strip().lower()
    if key in LATIN_ONLY or is_bijoy_font(name):
        return False
    if key in KNOWN_WINDOWS:
        return True
    path = font_path(name)
    if path is None:
        return True
    return _covers_bengali(path)


@lru_cache(maxsize=64)
def _harfbuzz_font(path):
    import uharfbuzz

    face = uharfbuzz.Face(uharfbuzz.Blob.from_file_path(path))
    return uharfbuzz.Font(face), face.upem


def measure(text, font_name, size_pt, bold=False, italic=False):
    """Shaped width of `text` in points, or None when the font or HarfBuzz is missing.

    A conjunct is measured as the one glyph it draws, not as the letters it is typed with. The
    font is the one fontconfig resolves `font_name` to, as LibreOffice renders it."""
    if not text:
        return 0.0
    path = font_path(font_name, bold, italic) or substitute_path(font_name)
    if not path:
        return None
    try:
        import uharfbuzz

        font, upem = _harfbuzz_font(path)
    except Exception:  # noqa: BLE001 - no shaper, or a font HarfBuzz cannot open
        return None
    buffer = uharfbuzz.Buffer()
    buffer.add_str(text)
    buffer.guess_segment_properties()
    uharfbuzz.shape(font, buffer)
    advance = sum(position.x_advance for position in buffer.glyph_positions)
    return advance / upem * size_pt


@lru_cache(maxsize=64)
def headline(font_name):
    """Height of the Bangla headline (মাত্রা) above the baseline, in em, or None.

    The headline is what the eye reads as the size of Bangla text; two fonts look the same size
    when their headlines are equally high."""
    path = font_path(font_name)
    if path is None:
        return None
    try:
        from fontTools.pens.boundsPen import BoundsPen
        from fontTools.ttLib import TTFont

        font = TTFont(path, lazy=True)
        glyphs, cmap = font.getGlyphSet(), font.getBestCmap()
        tops = []
        for letter in HEADLINE_LETTERS:
            pen = BoundsPen(glyphs)
            glyphs[cmap[ord(letter)]].draw(pen)
            tops.append(pen.bounds[3])
        return sum(tops) / len(tops) / font['head'].unitsPerEm
    except Exception:  # noqa: BLE001 - a font without Bengali letters has no headline
        return None


def size_for(source_font, source_pt, target_font=DEFAULT_FONT):
    """The size `target_font` needs to look as large as `source_font` at `source_pt`.

    Rounded to half a point. When either font's headline cannot be read, the size is kept."""
    source, target = headline(source_font), headline(target_font)
    if not source or not target or source_font == target_font:
        return source_pt
    return round(source_pt * source / target / ROUND_TO) * ROUND_TO
