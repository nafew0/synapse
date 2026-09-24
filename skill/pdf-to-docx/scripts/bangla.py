"""Recover real Unicode Bangla from a PDF whose text layer only looks right.

Many Bangla PDFs from Bangladeshi offices — wkhtmltopdf and Qt output above all — draw correct
glyphs over a broken text layer. The producer subsets the font down to bare outlines (no `cmap`,
no `GSUB`) and writes a ToUnicode map only for glyphs that stand for one character, so:

- a conjunct such as ক্ষ or ন্ত has no mapping at all and extracts as `(cid:46)`;
- vowel signs come out in the order they are drawn, not the order they are typed: ি, ে and ৈ are
  drawn before their consonant, so বাংলাদেশ extracts as বাংলােদশ;
- bold is often faked by drawing every glyph twice a fraction of a point apart, so each letter of
  a bold line comes out doubled.

The outlines are still the original font's outlines. Each embedded glyph is matched by shape to a
glyph of the same font installed on this machine; that font's own `cmap` and `GSUB` tables say
which characters the glyph stands for, and the characters are then put back in logical order.
The result is checked by shaping it again with HarfBuzz and comparing against the glyphs the PDF
drew, word by word.

Nothing here runs unless a page uses a Bengali font whose original is installed, and a word is
only replaced when it could be decoded completely.

PDFs typed in a Bijoy font (SutonnyMJ…) are the other case: their text layer is exactly what was
typed, Latin codes such as `evsjv` for বাংলা. Each word set in a Bijoy font is converted to Unicode
with `office.bijoy`, and its font becomes Nikosh, since the Bijoy fonts are not installed here.
"""
import io
import re
import subprocess
import unicodedata
from functools import lru_cache

from office import bijoy

RASTER = 80
"""Pixels per side of the box glyph shapes are compared in, which spans two em: marks such as ৃ
have no width and are drawn left of their origin, and would fall outside a one-em box. Forty
pixels per em tells ক from ফ and still compares a thousand glyphs in about a second."""
SHAPE_TOLERANCE = 0.05
"""Share of a glyph's ink pixels that may differ from the original's and still count as the same
glyph. The subset's outlines are the original's re-encoded, which moves them by a unit or two."""
ADVANCE_TOLERANCE = 0.01
"""Advance widths, as a share of the em, that count as equal. Two glyphs of different width are
never the same glyph."""
LOOKALIKE_WIDTHS = 0.8
"""Share of a subset's advance widths an installed font must also have to be compared by shape."""
LOOKALIKE_CANDIDATES = 3
LOOKALIKE_COVERAGE = 0.9
"""Share of a subset's inked glyphs a font found by shape, not by name, must match to be used."""
DUPLICATE_TOLERANCE = 1.0
"""Points of offset within which a second copy of the same glyph is overprinting for fake bold."""
MERGED = '\x00merged'
"""Text left on a glyph whose word was merged into its first glyph; see `merged_away`."""
CID = re.compile(r'\(cid:(\d+)\)')
SUBSET_PREFIX = re.compile(r'^[A-Z]{6}\+')
BENGALI = re.compile(r'[ঀ-৿]')
PRE_BASE = set('িেৈ')
VIRAMA = '্'
NUKTA = '়'
REPH = 'র্'
CANDRABINDU = 'ঁ'
CONSONANTS = set(chr(c) for c in range(0x0995, 0x09ba)) | set('ৎড়ঢ়য়')
CANDRABINDU_BEFORE_SIGN = re.compile('ঁ([া-ৌৗ])')
BELOW_OR_POST_BASE = {'blwf', 'pstf'}
MARKS = set('ঁংঃ়াীুূৃৄৗ') | {REPH}
"""Signs drawn after their base whose order among themselves differs between shaping engines: Qt's
draws ঁ and the reph before া, HarfBuzz after. Verification compares them as a set."""


def family_of(fontname):
    """`QWBAAA+SolaimanLipiNormal` or `/SolaimanLipiNormal` -> `SolaimanLipiNormal`."""
    return SUBSET_PREFIX.sub('', str(fontname or '').lstrip('/'))


def embedded_fonts(pdf_path):
    """{PDF font name: (font program bytes, {cid: text})} for every embedded CID TrueType font."""
    from pdfminer.cmapdb import CMapParser, FileUnicodeMap
    from pypdf import PdfReader

    fonts = {}
    for page in PdfReader(str(pdf_path)).pages:
        resources = page.get('/Resources')
        font_dict = resources.get_object().get('/Font') if resources else None
        for ref in (font_dict.get_object().values() if font_dict else []):
            font = ref.get_object()
            name = family_of(font.get('/BaseFont'))
            if name in fonts or font.get('/Subtype') != '/Type0':
                continue
            descendant = font['/DescendantFonts'][0].get_object()
            program = descendant['/FontDescriptor'].get_object().get('/FontFile2')
            gid_map = descendant.get('/CIDToGIDMap')
            if program is None or (gid_map is not None and gid_map != '/Identity'):
                continue
            unicode_map = {}
            if '/ToUnicode' in font:
                cmap = FileUnicodeMap()
                CMapParser(cmap, io.BytesIO(font['/ToUnicode'].get_object().get_data())).run()
                unicode_map = dict(cmap.cid2unichr)
            fonts[name] = (program.get_object().get_data(), unicode_map)
    return fonts


def installed_fonts(pattern):
    """Paths of the installed fonts fontconfig matches to `pattern`, e.g. `:family=Nikosh`."""
    try:
        found = subprocess.run(['fc-list', pattern, 'file'], capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    return sorted({line.split(':')[0].strip() for line in found.splitlines() if line.strip()})


def original_for(program, family):
    """(path, {gid: glyph name}) for the installed font that best matches an embedded subset.

    Fonts of one family often come in several versions and cuts — Nikosh, NikoshBAN, NikoshLight —
    so every file carrying the family name is tried and the one matching the most glyphs wins. A
    PDF that renamed its font matches none of them by name; then the installed Bangla fonts whose
    advance widths agree with the subset's are compared by shape, and one is accepted only when
    nearly every glyph matches.
    """
    named = installed_fonts(f':family={family}')
    candidates = named or _lookalikes(program)
    best = (None, {})
    for path in candidates:
        matched, inked = match_glyphs(program, path)
        if len(matched) > len(best[1]) and (named or len(matched) >= LOOKALIKE_COVERAGE * inked):
            best = (path, matched)
    return best


def _lookalikes(program):
    """The installed Bangla fonts sharing most of the subset's advance widths, most alike first."""
    from fontTools.ttLib import TTFont

    embedded = TTFont(io.BytesIO(program))
    upem = embedded['head'].unitsPerEm
    wanted = {round(width / upem, 2) for width, _ in embedded['hmtx'].metrics.values() if width}
    scored = []
    for path in installed_fonts(':lang=bn'):
        try:
            font = TTFont(path, lazy=True)
            widths = {round(width / font['head'].unitsPerEm, 2) for width, _ in font['hmtx'].metrics.values()}
        except Exception:  # noqa: BLE001 - an unreadable font is simply not a candidate
            continue
        share = len(wanted & widths) / max(len(wanted), 1)
        if share >= LOOKALIKE_WIDTHS:
            scored.append((share, path))
    return [path for _, path in sorted(scored, reverse=True)[:LOOKALIKE_CANDIDATES]]


class _Outline:
    """Collects a glyph's contours as polygons, flattening curves into short straight segments."""

    STEPS = (0.25, 0.5, 0.75, 1.0)

    def __init__(self, glyph_set):
        from fontTools.pens.basePen import BasePen

        outline = self

        class Pen(BasePen):
            def _moveTo(self, point):
                outline.current = [point]

            def _lineTo(self, point):
                outline.current.append(point)

            def _qCurveToOne(self, control, point):
                start = outline.current[-1]
                outline.current.extend(
                    tuple((1 - t) ** 2 * s + 2 * (1 - t) * t * c + t * t * p for s, c, p in zip(start, control, point))
                    for t in _Outline.STEPS
                )

            def _curveToOne(self, first, second, point):
                start = outline.current[-1]
                outline.current.extend(
                    tuple(
                        (1 - t) ** 3 * s + 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t * t * b + t ** 3 * p
                        for s, a, b, p in zip(start, first, second, point)
                    )
                    for t in _Outline.STEPS
                )

            def _closePath(self):
                if len(outline.current) > 2:
                    outline.contours.append(outline.current)
                outline.current = []

            _endPath = _closePath

        self.contours, self.current = [], []
        self.pen = Pen(glyph_set)


def _raster(font, name):
    """The glyph drawn in a fixed em box, holes cut by XOR of its contours."""
    import numpy
    from PIL import Image, ImageDraw

    glyph_set = font.getGlyphSet()
    outline = _Outline(glyph_set)
    glyph_set[name].draw(outline.pen)
    upem = font['head'].unitsPerEm
    scale = RASTER / (2 * upem)
    ink = numpy.zeros((RASTER, RASTER), bool)
    for contour in outline.contours:
        image = Image.new('1', (RASTER, RASTER))
        ImageDraw.Draw(image).polygon(
            [((x + 0.5 * upem) * scale, (1.25 * upem - y) * scale) for x, y in contour], fill=1
        )
        ink ^= numpy.array(image, bool)
    return ink


@lru_cache(maxsize=8)
def _shapes(path):
    """(font, glyph names, advances as share of em, rasters) for an installed font."""
    import numpy
    from fontTools.ttLib import TTFont

    font = TTFont(path)
    names = font.getGlyphOrder()
    upem = font['head'].unitsPerEm
    advances = numpy.array([font['hmtx'][name][0] / upem for name in names])
    rasters = numpy.stack([_raster(font, name) for name in names])
    return font, names, advances, rasters


def match_glyphs(program, original_path):
    """({embedded gid: original glyph name} for every inked glyph that matched, glyphs with ink)."""
    import numpy
    from fontTools.ttLib import TTFont

    embedded = TTFont(io.BytesIO(program))
    _, names, advances, rasters = _shapes(original_path)
    upem = embedded['head'].unitsPerEm
    matched, inked = {}, 0
    for gid, name in enumerate(embedded.getGlyphOrder()):
        ink = _raster(embedded, name)
        if not ink.any():
            continue
        inked += 1
        candidates = numpy.flatnonzero(numpy.abs(advances - embedded['hmtx'][name][0] / upem) < ADVANCE_TOLERANCE)
        if not len(candidates):
            continue
        differences = (rasters[candidates] ^ ink).sum(axis=(1, 2)) / ink.sum()
        best = int(numpy.argmin(differences))
        if differences[best] < SHAPE_TOLERANCE:
            matched[gid] = names[candidates[best]]
    return matched, inked


def _subtables(lookup):
    for table in lookup.SubTable:
        yield getattr(table, 'ExtSubTable', table)


@lru_cache(maxsize=8)
def glyph_texts(original_path):
    """{glyph name: the characters it stands for}, from the font's cmap and, run backwards, its GSUB.

    A ligature stands for its components' characters in order; a single or alternate substitution
    (a half form, a positional variant) stands for whatever its source glyph stood for. Lookups
    feed each other, so the table is walked until nothing new is learned.
    """
    font = _shapes(original_path)[0]
    texts = {}
    for code, name in sorted(font.getBestCmap().items()):
        texts.setdefault(name, chr(code))
    if 'GSUB' not in font:
        return texts
    gsub = font['GSUB'].table
    below = _lookups_of(gsub, BELOW_OR_POST_BASE)
    changed = True
    while changed:
        changed = False
        for index, lookup in enumerate(gsub.LookupList.Lookup):
            for table in _subtables(lookup):
                for target, source in _reverse_pairs(table, texts):
                    if target in texts or source is None:
                        continue
                    texts[target] = _subjoined(source) if index in below else source
                    changed = True
    return texts


def _lookups_of(gsub, tags):
    """Indexes of the lookups that the features named in `tags` apply."""
    return {
        index
        for record in gsub.FeatureList.FeatureRecord
        if record.FeatureTag in tags
        for index in record.Feature.LookupListIndex
    }


def _subjoined(text):
    """A below- or post-base form stands for virama + consonant (্ব, ্য, ্র).

    Fonts built for the older `beng` script tag list the pair the other way round, consonant then
    virama, because the shaping engine reorders it before the lookup runs. Read back literally
    that is র্ — a reph — or a half form, both of which mean something else."""
    if len(text) == 2 and text[1] == VIRAMA:
        return VIRAMA + text[0]
    return text


def _reverse_pairs(table, texts):
    """(output glyph, text of its input) for the substitutions a subtable makes."""
    kind = type(table).__name__
    if kind == 'SingleSubst':
        return [(out, texts.get(src)) for src, out in table.mapping.items()]
    if kind == 'AlternateSubst':
        return [(out, texts.get(src)) for src, outs in table.alternates.items() for out in outs]
    if kind == 'LigatureSubst':
        pairs = []
        for first, ligatures in table.ligatures.items():
            for ligature in ligatures:
                parts = [texts.get(glyph) for glyph in [first, *ligature.Component]]
                pairs.append((ligature.LigGlyph, ''.join(parts) if None not in parts else None))
        return pairs
    return []


def logical_order(tokens):
    """Characters in the order they are typed, from glyph texts in the order they are drawn.

    A pre-base vowel sign (ি, ে, ৈ) is drawn before the consonant cluster it follows in typing, so it
    is held until that cluster ends. A reph is drawn after its whole syllable, vowel signs included, and typed before it. NFC then
    joins the two halves of ো and ৌ, which are drawn on either side of the consonant.
    """
    out, pending, cluster_start, syllable_start = [], [], None, None
    for token in tokens:
        if token in PRE_BASE:
            if pending and cluster_start is not None:
                out.extend(pending)
                pending = []
            pending.append(token)
            cluster_start = syllable_start = None
            continue
        if token == REPH and syllable_start is not None:
            out.insert(syllable_start, REPH)
            continue
        continues = token[:1] in (VIRAMA, NUKTA) or (out and out[-1].endswith(VIRAMA))
        if continues and cluster_start is not None:
            out.append(token)
            continue
        if pending and cluster_start is not None:
            out.extend(pending)
            pending = []
        cluster_start = len(out) if token[:1] in CONSONANTS else None
        if cluster_start is not None:
            syllable_start = cluster_start
        elif token[:1] not in MARKS:
            syllable_start = None
        out.append(token)
    out.extend(pending)
    text = CANDRABINDU_BEFORE_SIGN.sub(lambda m: m.group(1) + CANDRABINDU, ''.join(out))
    return unicodedata.normalize('NFC', text)


class Decoder:
    """Turns the glyph texts pdfplumber reports for one PDF font into real characters."""

    def __init__(self, fontname, unicode_map, glyph_names, texts, original_path):
        self.fontname = fontname
        self.original_path = original_path
        self.by_cid = {}
        for cid, name in glyph_names.items():
            if name in texts:
                self.by_cid[cid] = texts[name]
        self.glyph_names = glyph_names
        self.cid_of_text = {}
        for cid, text in unicode_map.items():
            self.cid_of_text.setdefault(text, cid)

    def token(self, text):
        """(real characters, gid) for one reported glyph text, or (None, None) when unknown."""
        match = CID.fullmatch(text)
        if match:
            cid = int(match.group(1))
            return self.by_cid.get(cid), cid
        cid = self.cid_of_text.get(text)
        return self.by_cid.get(cid, text), cid


def decoders(pdf_path):
    """{PDF font name: Decoder} for every embedded Bengali font whose original is installed, plus a
    list of the Bengali fonts that could not be decoded and why."""
    from fontTools.ttLib import TTFont

    found, missing = {}, []
    for name, (program, unicode_map) in embedded_fonts(pdf_path).items():
        if not any(BENGALI.search(text) for text in unicode_map.values()):
            continue
        family = _embedded_family(TTFont(io.BytesIO(program))) or name
        path, glyph_names = original_for(program, family)
        if path is None:
            missing.append(family)
            continue
        found[name] = Decoder(name, unicode_map, glyph_names, glyph_texts(path), path)
    return found, missing


def font_families(pdf_path):
    """{PDF font name: the family Word should be told}, read from each embedded font's name table.

    The PDF calls a font by its PostScript name — `SolaimanLipiNormal`, `NimbusSans-Regular` — which
    matches no installed font, so Word falls back to its default and a Bangla letter reverts to
    whatever face the reader's machine picks. The family name, `SolaimanLipi`, is what it knows.
    """
    from fontTools.ttLib import TTFont

    families = {}
    for name, (program, _) in embedded_fonts(pdf_path).items():
        try:
            family = _embedded_family(TTFont(io.BytesIO(program)))
        except Exception:  # noqa: BLE001 - an unreadable name table leaves the PDF's own name
            family = None
        if family:
            families[name] = family
    return families


def _embedded_family(font):
    records = [record for record in font['name'].names if record.nameID == 1]
    return records[0].toUnicode().strip() if records else None


def merged_away(char):
    return char['text'] == MERGED


def dedupe(chars):
    """Drop the second copy of each glyph overprinted for fake bold. Returns the kept chars and
    the set of positions that were doubled, which mark text as bold."""
    kept, bold, seen = [], set(), {}
    for char in sorted(chars, key=lambda c: (round(float(c['top'])), float(c['x0']))):
        key = (char['text'], char['fontname'], round(float(char['top'])))
        previous = seen.get(key)
        if previous is not None and abs(float(char['x0']) - float(previous['x0'])) <= DUPLICATE_TOLERANCE:
            bold.add(id(previous))
            continue
        seen[key] = char
        kept.append(char)
    return kept, bold


def repair_chars(chars, decoders_by_font):
    """Rewrite the text of each Bengali word in `chars` into logical Unicode, in place.

    A word is a run of glyphs in one decodable font on one line with no space between them. Its
    first glyph takes the word's whole logical text and is widened to the word's box; the rest are
    emptied, and callers drop them with `merged_away`. Text and box then agree for anything that
    reads the page afterwards, where half-empty glyphs would each read as a word of their own.

    Returns counts: `recovered` words rewritten, `undecoded` words left as extracted because a glyph
    matched nothing, and of the recovered, `verified` (shaping the result redraws the PDF's glyphs),
    `mismatched` (it does not) and `unchecked` (HarfBuzz is not installed).
    """
    counts = {'recovered': 0, 'undecoded': 0, 'verified': 0, 'mismatched': 0, 'unchecked': 0}
    for word in _words(chars, lambda family: family in decoders_by_font):
        decoder = decoders_by_font[family_of(word[0]['fontname'])]
        tokens = [decoder.token(char['text']) for char in word]
        if any(text is None for text, _ in tokens):
            counts['undecoded'] += 1
            continue
        text = logical_order([text for text, _ in tokens])
        check = verify(text, decoder.glyph_names, [cid for _, cid in tokens], decoder.original_path)
        counts[{True: 'verified', False: 'mismatched', None: 'unchecked'}[check]] += 1
        _merge(word, text)
        counts['recovered'] += 1
    return counts


def _merge(word, text):
    """Give the word's first glyph its whole text and box; empty the rest for `merged_away`."""
    word[0]['text'] = text
    word[0]['x1'] = word[-1]['x1']
    word[0]['width'] = float(word[0]['x1']) - float(word[0]['x0'])
    for char in word[1:]:
        char['text'] = MERGED


def is_bijoy(fontname, families=None):
    """Whether a PDF font is a Bijoy font: `ABCDEF+SutonnyMJ`, `SutonnyMJ-Bold`, `SutonnyMJ,Bold`."""
    name = family_of(fontname)
    names = {name, (families or {}).get(name, name)}
    return any(bijoy.is_font(candidate) or bijoy.is_font(re.split(r'[-,]', candidate)[0]) for candidate in names)


def convert_bijoy_chars(chars, families=None):
    """Rewrite the text of each word set in a Bijoy font into Unicode, in place, merged into its
    first glyph as `repair_chars` does. Returns {Bijoy font family: words converted}."""
    counts = {}
    for word in _words(chars, lambda family: is_bijoy(family, families)):
        _merge(word, bijoy.to_unicode(''.join(char['text'] for char in word)))
        family = family_of(word[0]['fontname'])
        counts[family] = counts.get(family, 0) + 1
    return counts


def _words(chars, wanted):
    """Runs of glyphs in one font `wanted(family)` accepts, on one line, with no gap between them."""
    word, previous = [], None
    for char in sorted(chars, key=lambda c: (round(float(c['top'])), float(c['x0']))):
        decodable = wanted(family_of(char['fontname'])) and char['text'].strip() != ''
        same_word = (
            previous is not None
            and decodable
            and char['fontname'] == previous['fontname']
            and round(float(char['top'])) == round(float(previous['top']))
            and float(char['x0']) - float(previous['x1']) < 0.25 * float(char['size'])
        )
        if not same_word and word:
            yield word
            word = []
        if decodable:
            word.append(char)
        previous = char if decodable else None
    if word:
        yield word


def readable_text(pdf_path):
    """The PDF's text as a reader sees it: fake-bold copies dropped, Bangla recovered.

    This is the yardstick a conversion is measured against. Measured against the raw text layer
    instead, every `(cid:46)` counts as eight characters and every fake-bold letter twice, so a
    faithful conversion reads as one that lost a third of the document.
    """
    import pdfplumber

    found, _ = decoders(pdf_path)
    texts = []
    with pdfplumber.open(str(pdf_path)) as pdf:
        for page in pdf.pages:
            kept, _ = dedupe(page.chars)
            if found:
                repair_chars(kept, found)
            convert_bijoy_chars(kept)
            keep = {id(char) for char in kept if not merged_away(char)}
            readable = page.filter(lambda obj: obj.get('object_type') != 'char' or id(obj) in keep)
            texts.append(readable.extract_text() or '')
    return ' '.join(texts)


def verify(text, glyph_names, gids, original_path):
    """Whether shaping `text` with the original font draws the same glyphs the PDF drew.

    Returns None when HarfBuzz is not available to check."""
    try:
        import uharfbuzz
    except ImportError:
        return None
    blob = uharfbuzz.Blob.from_file_path(original_path)
    font = uharfbuzz.Font(uharfbuzz.Face(blob))
    buffer = uharfbuzz.Buffer()
    buffer.add_str(text)
    buffer.guess_segment_properties()
    uharfbuzz.shape(font, buffer)
    shaped = [font.glyph_to_string(info.codepoint) for info in buffer.glyph_infos]
    drawn = [glyph_names.get(gid) for gid in gids]
    texts = glyph_texts(original_path)
    return _as_text(shaped, texts) == _as_text(drawn, texts)


def _as_text(glyphs, texts):
    """What a glyph sequence says, glyph by glyph. Positional variants of one sign (a wide ি, a
    lowered ৃ) stand for the same text, so two shaping engines that pick different variants for
    the same word still agree, while a sign attached to the wrong consonant does not."""
    return [texts.get(glyph, glyph) for glyph in _marks_sorted(glyphs, texts)]


def _marks_sorted(glyphs, texts):
    """The glyph sequence with each run of after-base signs in a fixed order."""
    out, run = [], []
    for glyph in glyphs:
        if texts.get(glyph) in MARKS:
            run.append(glyph)
            continue
        out.extend(sorted(run, key=str))
        run = []
        out.append(glyph)
    return out + sorted(run, key=str)
