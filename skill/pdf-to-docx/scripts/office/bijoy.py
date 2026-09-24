"""Bijoy (ANSI) Bangla: recognise it and convert it to Unicode.

Before Unicode, Bangladeshi offices typed Bangla with the Bijoy keyboard into fonts such as
SutonnyMJ, which draw Bangla shapes at Latin and Windows-1252 code points: আমি is stored as
`Avwg`, বাংলা as `evsjv`. The text reads as Bangla only in a Bijoy font. Anywhere else, on a PC
without SutonnyMJ, in a search, a screen reader or a language model, it is Latin gibberish. Bijoy
fonts are commercial and are not in the sandbox, so Bijoy text is converted to Unicode and set in
Nikosh.

Conversion has two steps:

1. Each glyph code is replaced by the Unicode it draws, longest code first: a conjunct is one code
   (`¶` ক্ষ) or a letter and a joining form (`¯Í` স্ত).
2. The characters are put in Unicode's logical order. Bijoy stores text in the order it is drawn:
   ি ে ৈ come before the consonant (cluster) they belong to (`wK` কি, `‡cÖ` প্রে), and the reph
   র্ after the consonant it sits on (`Kg©` কর্ম). The vowel signs are moved after their cluster,
   ে + া and ে + ৗ joined into ো and ৌ, and the reph moved before its cluster.

The table is the SutonnyMJ layout every Bijoy font shares.
"""
import re
import unicodedata

FONT = re.compile(r'(?i)^(bijoy.*|.*[^o]mj|kalpurush ansi)$')
"""Bijoy (ANSI) fonts: SutonnyMJ and the other `…MJ` faces, `Bijoy…`, Kalpurush ANSI. SutonnyOMJ is
the Unicode cut of Sutonny and is not one of them."""

REPH = ''
"""Stand-in for the reph while the text is reordered; never left in the result."""
VIRAMA = '্'
NUKTA = '়'
CANDRABINDU = 'ঁ'
ZWNJ = '‌'
PRE_BASE = set('িেৈ')
POST_BASE = set('াীুূৃৄৗ')
SIGNS_AFTER = POST_BASE | PRE_BASE | set('ংঃঁ')
"""Signs that stand between a consonant and a reph typed after it."""
CONSONANTS = set(chr(c) for c in range(0x0995, 0x09ba)) | set('ৎড়ঢ়য়')

GLYPHS = {
    'Av': 'আ', 'A': 'অ', 'B': 'ই', 'C': 'ঈ', 'D': 'উ', 'E': 'ঊ', 'F': 'ঋ', 'G': 'এ', 'H': 'ঐ',
    'I': 'ও', 'J': 'ঔ',
    'K': 'ক', 'L': 'খ', 'M': 'গ', 'N': 'ঘ', 'O': 'ঙ', 'P': 'চ', 'Q': 'ছ', 'R': 'জ', 'S': 'ঝ',
    'T': 'ঞ', 'U': 'ট', 'V': 'ঠ', 'W': 'ড', 'X': 'ঢ', 'Y': 'ণ', 'Z': 'ত', '_': 'থ', '`': 'দ',
    'a': 'ধ', 'b': 'ন', 'c': 'প', 'd': 'ফ', 'e': 'ব', 'f': 'ভ', 'g': 'ম', 'h': 'য', 'i': 'র',
    'j': 'ল', 'k': 'শ', 'l': 'ষ', 'm': 'স', 'n': 'হ', 'o': 'ড়', 'p': 'ঢ়', 'q': 'য়', 'r': 'ৎ',
    's': 'ং', 't': 'ঃ', 'u': 'ঁ',
    '0': '০', '1': '১', '2': '২', '3': '৩', '4': '৪', '5': '৫', '6': '৬', '7': '৭', '8': '৮',
    '9': '৯',
    'v': 'া', 'w': 'ি', 'x': 'ী', 'y': 'ু', 'z': 'ু', '“': 'ু', '–': 'ু', '~': 'ূ', 'ƒ': 'ূ',
    '‚': 'ূ', '„': 'ৃ', '…': 'ৃ', '†': 'ে', '‡': 'ে', 'ˆ': 'ৈ', '‰': 'ৈ', 'Š': 'ৗ',
    '|': '।', '&': VIRAMA + ZWNJ, '©': REPH,
    '^': '্ব', '‘': '্তু', '’': '্থ', '‹': '্ক', 'Œ': '্ক্র', '”': 'চ্', '—': '্ত', 'Í': '্ত',
    '˜': 'দ্', '™': 'দ্', 'š': 'ন্', '›': 'ন্', 'œ': '্ন', 'Ÿ': '্ব', '¡': '্ব', '¢': '্ভ',
    '£': '্ভ্র', '¤': 'ম্', '¥': '্ম', '¦': '্ব', '§': '্ম', '¨': '্য', 'ª': '্র', '«': '্র',
    '¬': '্ল', '­': '্ল', '®': 'ষ্', '¯': 'স্', '•': 'ঙ্', 'Ö': '্র', 'è': '্ণ', 'ú': '্প',
    '¿': '্ত্র',
    '°': 'ক্ক', '±': 'ক্ট', '²': 'ক্ষ্ণ', '³': 'ক্ত', '´': 'ক্ম', 'µ': 'ক্র', '¶': 'ক্ষ',
    '·': 'ক্স', '¸': 'গু', '¹': 'জ্ঞ', 'º': 'গ্দ', '»': 'গ্ধ', '¼': 'ঙ্ক', '½': 'ঙ্গ', '¾': 'জ্জ',
    'À': 'জ্ঝ', 'Á': 'জ্ঞ', 'Â': 'ঞ্চ', 'Ã': 'ঞ্ছ', 'Ä': 'ঞ্জ', 'Å': 'ঞ্ঝ', 'Æ': 'ট্ট', 'Ç': 'ড্ড',
    'È': 'ণ্ট', 'É': 'ণ্ঠ', 'Ê': 'ণ্ড', 'Ë': 'ত্ত', 'Ì': 'ত্থ', 'Î': 'ত্র', 'Ï': 'দ্দ', '×': 'দ্ধ',
    'Ø': 'দ্ব', 'Ù': 'দ্ম', 'Ú': 'ন্ঠ', 'Û': 'ন্ড', 'Ü': 'ন্ধ', 'Ý': 'ন্স', 'Þ': 'প্ট', 'ß': 'প্ত',
    'à': 'প্প', 'á': 'প্স', 'â': 'ব্জ', 'ã': 'ব্দ', 'ä': 'ব্ধ', 'å': 'ভ্র', 'æ': 'ম্ন', 'ç': 'ম্ফ',
    'é': 'ল্ক', 'ê': 'ল্গ', 'ë': 'ল্ট', 'ì': 'ল্ড', 'í': 'ল্প', 'î': 'ল্ফ', 'ï': 'শু', 'ð': 'শ্চ',
    'ñ': 'শ্ছ', 'ò': 'ষ্ণ', 'ó': 'ষ্ট', 'ô': 'ষ্ঠ', 'õ': 'ষ্ফ', 'ö': 'স্খ', '÷': 'স্ট', 'ø': '্ল',
    'ù': 'স্ফ', 'û': 'হু', 'ü': 'হৃ', 'ý': 'হ্ন', 'þ': 'হ্ম', 'ÿ': 'ক্ষ',
    'Ð': '–', 'Ñ': '–', 'Ò': '“', 'Ó': '”', 'Ô': '‘', 'Õ': '’',
}
"""SutonnyMJ glyph code -> the Unicode it draws. Codes not listed (space, `.,:;!?()-/%+=`) draw
themselves."""
CODES = re.compile('|'.join(re.escape(code) for code in sorted(GLYPHS, key=len, reverse=True)))
TYPING_SLIPS = [(re.compile('yy'), 'y'), (re.compile('vv'), 'v'), (re.compile('„„'), '„')]
"""Signs typed twice, which the font draws on top of each other so nobody saw them."""
WINDOWS_1252 = {
    code: bytes([code]).decode('cp1252') for code in range(0x80, 0xa0) if code not in (0x81, 0x8d, 0x8f, 0x90, 0x9d)
}
"""Bijoy codes 0x80–0x9F read as Latin-1 control characters, as some PDF and XLS readers report
them, mapped back to the Windows-1252 characters the font draws (0x87 is ‡)."""
DOUBLE_VIRAMA = re.compile(VIRAMA + '{2,}')
COLON = re.compile(r'(?<=[০-৯\s\]\[])ঃ|^ঃ')
"""A visarga after a digit, a space or a bracket is a colon typed with the visarga key."""

DISTINCTIVE = set('†‡ˆ‰Š‹Œš›œŸ¨ª«¬¯°±²³´µ¶·¸¹º»¼½¾¿×÷¤¥¦§¢£¡®„…ƒÿ')
"""Codes Bijoy text is full of and European text almost never uses."""
REPH_ON_LETTER = re.compile(r'(?<=[A-Za-z])©|©(?=[A-Za-z])')
SHAPES = re.compile(r'[a-z][A-Z]|[A-Z_`]v|(?:^|[^A-Za-z])w[A-Z_`]')
"""ASCII-only Bijoy words: a consonant then া (`Kv`), ি before a consonant (`wK`), a letter then a
capital inside a word (`mvaviY`). English has them too (`Avenue`, `iPhone`), so they count only
among many words."""
LETTER = re.compile(r'[A-Za-z]')
MIN_WORDS = 3
BIJOY_SHARE = 0.5


def is_font(name):
    """Whether `name` is a Bijoy (ANSI) font."""
    return bool(name) and FONT.match(name.strip()) is not None


def _surely_bijoy(word):
    return any(char in DISTINCTIVE for char in word) or REPH_ON_LETTER.search(word) is not None


def looks_bijoy(text):
    """Whether text with no Bengali code points reads as Bijoy rather than as English.

    Without the font name this is a guess, so it is used for notes, never to change text. Text of
    three words or more looks Bijoy when at least half its words have a code European text rarely
    uses (`‡`, `¨`, `¯`, a reph against a letter) or a Bijoy shape (`Kv`, `wK`, `mvaviY`); shorter
    text only when every word has such a code."""
    if not text or re.search('[\u0980-\u09ff]', text):
        return False
    words = [word for word in text.split() if LETTER.search(word)]
    if not words:
        return False
    if len(words) < MIN_WORDS:
        return all(_surely_bijoy(word) for word in words)
    bijoy = sum(1 for word in words if _surely_bijoy(word) or SHAPES.search(word))
    return bijoy / len(words) >= BIJOY_SHARE


def _cluster_end(chars, start):
    """Index just after the consonant cluster starting at `start`: a consonant, its nukta, and every
    virama + consonant joined to it."""
    if start >= len(chars) or chars[start] not in CONSONANTS:
        return start
    end = start + 1
    while end < len(chars):
        if chars[end] == NUKTA:
            end += 1
        elif chars[end] == VIRAMA and end + 1 < len(chars) and chars[end + 1] in CONSONANTS:
            end += 2
        else:
            break
    return end


def _signs_before_joins(chars):
    """A vowel sign or candrabindu typed before a joining form (`Kv¨`) goes after it (ক্যা)."""
    for index in range(len(chars) - 2):
        if chars[index] in POST_BASE | {CANDRABINDU} and chars[index + 1] == VIRAMA and chars[index + 2] in CONSONANTS:
            chars[index], chars[index + 1], chars[index + 2] = chars[index + 1], chars[index + 2], chars[index]


def _pre_base_after_cluster(chars):
    """Move each ি ে ৈ after the cluster it is drawn in front of, joining ে with a following া or ৗ.

    A candrabindu typed between the sign and its consonant (`wuK`) goes after the sign."""
    result, index = [], 0
    while index < len(chars):
        char = chars[index]
        if char not in PRE_BASE:
            result.append(char)
            index += 1
            continue
        start = index + 1
        while start < len(chars) and chars[start] == CANDRABINDU:
            start += 1
        end = _cluster_end(chars, start)
        if end == start:
            result.append(char)
            index += 1
            continue
        marks = chars[index + 1:start]
        result.extend(chars[start:end])
        following = end
        while following < len(chars) and chars[following] == CANDRABINDU:
            marks.append(chars[following])
            following += 1
        if char == 'ে' and following < len(chars) and chars[following] in 'াৗ':
            result.append('ো' if chars[following] == 'া' else 'ৌ')
            following += 1
        else:
            result.append(char)
        result.extend(marks)
        index = following
    return result


def _reph_before_cluster(chars):
    """Put each reph before the cluster it is drawn on, past the signs typed between them."""
    result = []
    for char in chars:
        if char != REPH:
            result.append(char)
            continue
        position = len(result)
        while position > 0 and result[position - 1] in SIGNS_AFTER:
            position -= 1
        if position > 0 and result[position - 1] == NUKTA:
            position -= 1
        if position > 0 and result[position - 1] in CONSONANTS:
            position -= 1
            while position > 1 and result[position - 1] == VIRAMA and result[position - 2] in CONSONANTS:
                position -= 2
        else:
            position = len(result)
        result[position:position] = ['র', VIRAMA]
    return result


def to_unicode(text):
    """Unicode Bangla for text typed in a Bijoy font, in logical order and NFC."""
    if not text:
        return text
    text = text.translate(WINDOWS_1252)
    for pattern, replacement in TYPING_SLIPS:
        text = pattern.sub(replacement, text)
    mapped = DOUBLE_VIRAMA.sub(VIRAMA, CODES.sub(lambda match: GLYPHS[match.group(0)], text))
    chars = list(mapped)
    _signs_before_joins(chars)
    chars = _reph_before_cluster(_pre_base_after_cluster(chars))
    result = COLON.sub(':', ''.join(chars).replace('অা', 'আ'))
    return unicodedata.normalize('NFC', result)


def convert_pieces(pieces):
    """Convert text split across pieces (a paragraph's runs, a cell's rich-text runs) as one text.

    Bijoy's reordering crosses piece boundaries: `w` in one run and `K` in the next are one কি. The
    joined text is converted word by word, and each converted word goes to the piece its first
    character was in, so a word split across runs lands whole in the first of them. Whitespace
    stays in the piece it was in."""
    owners = [index for index, piece in enumerate(pieces) for _ in piece]
    joined = ''.join(pieces)
    converted = [''] * len(pieces)
    for match in re.finditer(r'\s+|\S+', joined):
        token = match.group(0)
        owner = owners[match.start()]
        converted[owner] += token if token.isspace() else to_unicode(token)
    return converted
