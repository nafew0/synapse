#!/usr/bin/env python3
"""Rebuild a PDF as a Word document that edits like one.

`layout-editable` reproduces the page by putting every visual line in its own positioned text
box. It looks right and cannot be edited: typing into one box reflows nothing, so the line grows
past its frame while its neighbours stay put. This module takes the other trade — real
paragraphs, headings, lists and tables in reading order, so the text behaves like text, with the
logos, seals, signatures and QR codes kept as pictures anchored where they were.

Structure is inferred from what `pdfplumber` reports per character: position, size and font.
Nothing here is exact; each rule below states what it assumes and what it costs when wrong.
"""
import copy
import io
import re
from itertools import groupby
from pathlib import Path

import bangla
from office.bangla import DEFAULT_FONT, is_bangla_font, size_for

LINE_TOLERANCE = 2.5
"""Points of baseline drift still counted as one line. Kerning and superscripts move a
character a little; a new line moves it by the leading, which is far larger."""
PARAGRAPH_GAP = 1.6
"""A vertical gap this many times the line height starts a new paragraph rather than a new line."""
HEADING_RATIO = 1.15
"""Text this much larger than the body is a heading. Smaller differences are emphasis."""
INDENT_TOLERANCE = 3.0
CENTRE_TOLERANCE = 12.0
EDGE_TOLERANCE = 6.0
"""Points from the right margin at which a field counts as set against it."""
FILLED_LINE = 0.85
"""Share of a block's width a line must reach to read as wrapped rather than as a line of its own."""
"""Points the text's centre may sit from the column centre and still count as centred."""
WORD_GAP = 0.15
"""Share of the type size a horizontal gap must reach to be a word space rather than kerning."""
TAB_GAP = 36.0
"""Horizontal white space inside a line that means a tab rather than a wide word space. Justified
body text stretches its spaces, so this sits well above anything justification produces."""
JUSTIFIED_SHARE = 0.6
"""Share of a block's lines that must reach the same right edge for it to have been justified."""
MAX_BLOCK_SPACING = 24.0
"""Most vertical space, in points, carried over between blocks. The gaps in the PDF are what make
an order look like an order; reproducing an unbounded one would push content onto another page."""
MIN_BLOCK_SPACING = 2.0
SPACING_BUDGET = 0.08
"""Share of the page height all of one page's carried-over gaps may add up to."""
MIN_IMAGE_POINTS = 8.0
"""Anything smaller is a rule, a bullet glyph or a artefact of the page, not a picture."""
IMAGE_DPI = 200
"""Resolution of the page render pictures are cut from when the embedded stream cannot be used."""
EMBEDDED_DIFFERENCE = 24.0
"""Mean per-channel difference, out of 255, above which an extracted stream no longer looks like
what the page shows — a lost soft mask, an inverted stencil, a colour space pypdf read the other
way round. Past it the render is the honest picture, blur and all."""
COMPARISON_SIZE = 32
BULLET = re.compile(r'^([•▪◦‣·–—-]|\*)\s+')
BANGLA_ITEM = re.compile(r'^\(?([০-৯]{1,3}|[ক-হ])[।.)]\s*')
"""A Bangla list item — "১।", "(১)", "১০।", "ক)" — which starts a paragraph of its own, as typed.
Without it the lines of a distribution list that reach the margin run together into prose."""
NUMBERED = re.compile(r'^(\(?[0-9]{1,2}[.)]|[a-z][.)]|[ivxl]+[.)])\s+', re.IGNORECASE)
"""ASCII digits only. Word's automatic numbering writes 1. 2. 3., so turning "(১)" or "১।" into
a numbered list would replace the document's own Bangla numerals and brackets with Latin ones."""
SUBSET_PREFIX = re.compile(r'^[A-Z]{6}\+')
BENGALI = re.compile(r'[ঀ-৿]')


RUN_PROPERTY_TAIL = (
    'w:szCs', 'w:highlight', 'w:u', 'w:effect', 'w:bdr', 'w:shd', 'w:fitText', 'w:vertAlign',
    'w:rtl', 'w:cs', 'w:em', 'w:lang', 'w:eastAsianLayout', 'w:specVanish', 'w:oMath',
)
"""The end of the order `w:rPr` children must appear in. Word rejects a document whose run
properties are out of order, so an element is inserted before whichever of these follow it."""
CONTROL_CHARACTERS = re.compile(r'[\x00-\x08\x0b-\x1f\x7f-\x9f]')


def _sane(text):
    """Text Word will accept.

    PDF text layers carry control bytes — soft hyphens from justification, stray form feeds from
    the producer — and python-docx refuses the whole document for one of them, losing a
    conversion that was otherwise complete.
    """
    return CONTROL_CHARACTERS.sub('', text or '').strip()


class SemanticError(Exception):
    pass


def build(pdf_path, docx_path):
    """Write `docx_path` from `pdf_path`. Returns a summary of what was recovered."""
    import pdfplumber
    from docx import Document
    from docx.shared import Pt

    pdf_path, docx_path = Path(pdf_path), Path(docx_path)
    document = Document()
    _compact_defaults(document, Pt)
    summary = {
        'paragraphs': 0,
        'headings': 0,
        'list_items': 0,
        'tables': 0,
        'pictures': 0,
        'running_header': False,
        'running_footer': False,
        'bangla': None,
        'warnings': [],
    }

    rasters = _embedded_rasters(pdf_path)
    decoders = _bangla_decoders(pdf_path, summary)
    families = _families(pdf_path)
    with pdfplumber.open(str(pdf_path)) as pdf:
        pages = [_prepared(page, decoders, families, summary) for page in pdf.pages]
        _apply_page_setup(document, pages, Pt)
        section = document.sections[0]
        frame = {
            'left': section.left_margin.pt,
            'right': section.page_width.pt - section.right_margin.pt,
        }
        running = _running_bands(pages)
        _apply_running_bands(document, running, pages, rasters, frame, summary)
        for index, page in enumerate(pages):
            if index:
                _add_page_break(document)
            _build_page(document, page, summary, frame, rasters.get(index + 1, ()), running)
        if not summary['paragraphs'] and not summary['tables'] and not summary['pictures']:
            raise SemanticError(
                f'{pdf_path.name} yielded no text, tables or pictures — it is probably a scan. '
                'Run OCR first, or use --mode layout-editable.'
            )
    document.save(str(docx_path))
    return summary


def _bangla_decoders(pdf_path, summary):
    """Decoders for the PDF's Bangla fonts, noting in the summary any that cannot be decoded.

    A Bangla font whose original is not installed still converts, but every conjunct in it comes
    out as `(cid:N)` and every ি, ে and ৈ in front of its consonant, so the result is unreadable. That
    is never passed over silently.
    """
    try:
        decoders, missing = bangla.decoders(pdf_path)
    except Exception as error:  # noqa: BLE001 - recovery is an improvement, never a requirement
        summary['warnings'].append(f'Bangla text recovery failed: {error}')
        return {}
    if decoders or missing:
        summary['bangla'] = {'fonts': sorted(decoders), 'fonts_missing': missing, 'recovered': 0,
                             'undecoded': 0, 'verified': 0, 'mismatched': 0, 'unchecked': 0}
    if missing:
        summary['warnings'].append(
            f'Bangla font(s) not installed: {", ".join(missing)}. Their conjuncts and vowel signs '
            'cannot be recovered, so that text will read wrong in Word.'
        )
    return decoders


def _families(pdf_path):
    try:
        return bangla.font_families(pdf_path)
    except Exception:  # noqa: BLE001 - without it runs keep the PDF's own font names
        return {}


def _prepared(page, decoders, families, summary):
    """The page as the rest of this module should read it.

    Glyphs overprinted to fake bold are dropped and their survivors marked bold; Bangla words are
    rewritten into real Unicode, Bijoy words included; every font is called by its family, with
    `-Bold` where the glyph was bold, since that is what the line and run builders read. A Bijoy
    font is called Nikosh: its text is Unicode now, and the Bijoy font is not installed here.
    Other Bangla fonts become Nikosh later, in `_apply_font`, once each run's size is known.
    """
    kept, doubled = bangla.dedupe(page.chars)
    if decoders:
        counts = bangla.repair_chars(kept, decoders)
        for key, value in counts.items():
            summary['bangla'][key] += value
    for font, words in bangla.convert_bijoy_chars(kept, families).items():
        converted = summary.setdefault('bijoy', {'words': 0, 'fonts': []})
        converted['words'] += words
        family = families.get(font, font)
        if family not in converted['fonts']:
            converted['fonts'].append(family)
    for char in kept:
        name = bangla.family_of(char['fontname'])
        bold = id(char) in doubled or 'bold' in name.lower()
        family = DEFAULT_FONT if bangla.is_bijoy(name, families) else families.get(name, name)
        char['fontname'] = family + ('-Bold' if bold else '')
    keep = {id(char) for char in kept if not bangla.merged_away(char)}
    return page.filter(lambda obj: obj.get('object_type') != 'char' or id(obj) in keep)


BAND = 0.09
"""Share of the page height at the top and at the bottom a running header or footer lives in."""
BAND_LIMIT = 1.4
"""How far past that depth the band may be stretched to hold an element it started."""
DIGITS = re.compile(r'\d+')
PAGINATION = re.compile(r'page|পৃষ্ঠা|পাতা', re.IGNORECASE)
JOINED = '-/.:_#'
"""Characters that tie a number to a reference rather than leaving it standing alone."""
MIN_RUNNING_PAGES = 2
RUNNING_SHARE = 0.6
"""Share of the pages a band must repeat on before it counts as running rather than as content."""


def _running_bands(pages):
    """The header and footer that repeat on the pages, as {'top': lines, 'bottom': lines}.

    A page number makes every footer different, so pages are compared with their numbers masked:
    "Page 1 of 9" and "Page 2 of 9" are the same footer. The band is read from a crop rather than
    from the page, so this costs a strip of each page and not a second full parse.
    """
    if len(pages) < MIN_RUNNING_PAGES:
        return {}
    counts = {'top': {}, 'bottom': {}}
    for index, page in enumerate(pages):
        for side, lines in _band_lines(page).items():
            key = DIGITS.sub('#', '\n'.join(lines))
            if not key.strip():
                continue
            seen = counts[side].setdefault(key, {'pages': 0, 'lines': lines, 'page': index})
            seen['pages'] += 1
    running = {}
    needed = max(MIN_RUNNING_PAGES, RUNNING_SHARE * len(pages))
    for side, candidates in counts.items():
        for key, seen in candidates.items():
            if seen['pages'] >= needed:
                running[side] = {'key': key, 'lines': seen['lines'], 'page': seen['page']}
                break
    return running


def _band_lines(page):
    """The text lines in the top and bottom bands of one page."""
    height = float(page.height)
    depth = BAND * height
    bands = {'top': (0, 0, float(page.width), depth), 'bottom': (0, height - depth, float(page.width), height)}
    lines = {}
    for side, box in bands.items():
        try:
            text = page.crop(box).extract_text() or ''
        except Exception:  # noqa: BLE001 - a band that cannot be read simply has no running text
            text = ''
        lines[side] = [_sane(line) for line in text.splitlines() if _sane(line)]
    return lines


def _apply_running_bands(document, running, pages, rasters, frame, summary):
    """Write the repeated bands into Word's own header and footer.

    Left in the body they are ordinary paragraphs: they stop repeating the moment the text reflows
    onto another page, and a page number goes stale as soon as anything is edited. In the header
    and footer Word repeats them itself, and the page numbers become `PAGE`/`NUMPAGES` fields that
    keep counting.

    The band is rebuilt by the same pass that builds a page, so a letterhead keeps its crest beside
    its lines rather than becoming a stack of leftovers.
    """
    section = document.sections[0]
    for side, part, flag in (
        ('top', section.header, 'running_header'),
        ('bottom', section.footer, 'running_footer'),
    ):
        if side not in running:
            continue
        # Built from a page whose band is the repeating one. The first page often differs — a
        # letter's last line of page one can sit low enough to share the footer's strip — and a
        # footer rebuilt from it prints that line on every page.
        index = running[side]['page']
        page = pages[index]
        part.is_linked_to_previous = False
        for paragraph in list(part.paragraphs):
            paragraph._element.getparent().remove(paragraph._element)
        band = _band_box(page, side)
        _build_page(part, page.crop(band), summary, frame, rasters.get(index + 1, ()))
        _fieldify(part, index + 1, len(pages))
        summary[flag] = True


def _band_box(page, side):
    """The band's box, grown to hold whatever it started: a crest that crosses the nominal edge
    would otherwise be cut in half, and half a crest is neither a header nor a picture."""
    height = float(page.height)
    left, right = float(page.bbox[0]), float(page.bbox[2])
    cut = _band_cut(page, side)
    if side == 'top':
        return (left, 0.0, right, cut if cut is not None else BAND * height)
    return (left, cut if cut is not None else height - BAND * height, right, height)


def _band_cut(page, side):
    """Where the band ends: past everything it holds, and never far past its nominal depth."""
    height = float(page.height)
    depth = BAND * height
    limit = BAND_LIMIT * depth
    edges = []
    for obj in list(page.chars) + list(page.images or []):
        top, bottom = float(obj['top']), float(obj['bottom'])
        # Only a picture may stretch the band: a crest drawn across its edge belongs to it, while a
        # line of text reaching into it is the body's last line, not part of the footer.
        reach = limit if obj.get('object_type') == 'image' else depth
        if side == 'top' and top < depth and bottom <= reach:
            edges.append(bottom)
        elif side == 'bottom' and bottom > height - depth and top >= height - reach:
            edges.append(top)
    if not edges:
        return None
    return max(edges) + 0.5 if side == 'top' else min(edges) - 0.5


def _fieldify(part, page_number, total_pages):
    """Turn the page numbers in a running band into fields that count themselves.

    Only where the line says it is counting pages. A memo number, an establishment code and a year
    are all digits in the same band, and turning one of those into a field rewrites the document's
    own reference number every time Word repaginates.
    """
    for paragraph in part.paragraphs:
        if not PAGINATION.search(paragraph.text or ''):
            continue
        for run in list(paragraph.runs):
            _split_into_fields(paragraph, run, page_number, total_pages)


def _split_into_fields(paragraph, run, page_number, total_pages):
    from docx.oxml.ns import qn

    text = run.text
    element = run._element
    properties = element.find(qn('w:rPr'))
    pieces = []
    position = 0
    for match in DIGITS.finditer(text):
        if not _is_page_number(text, match):
            continue
        number = int(match.group())
        field = 'NUMPAGES' if number == total_pages and total_pages > 1 else (
            'PAGE' if number == page_number else None
        )
        if field is None:
            continue
        pieces.append(('text', text[position:match.start()]))
        pieces.append(('field', field))
        position = match.end()
    if not pieces:
        return
    pieces.append(('text', text[position:]))
    for kind, value in pieces:
        if kind == 'text':
            if not value:
                continue
            new_run = paragraph.add_run(value)
        else:
            new_run = paragraph.add_run()
            _add_field_chars(new_run, value)
        if properties is not None:
            new_run._element.insert(0, copy.deepcopy(properties))
        element.addprevious(new_run._element)
    element.getparent().remove(element)


def _is_page_number(text, match):
    """Whether this run of digits is a page count rather than part of a reference.

    A leading zero or a character joined to the digits — `Establishment-01`, `KU/ADMIN/2026/117` —
    means the number belongs to a code the document owns, not to Word's pagination.
    """
    if match.group().startswith('0') and len(match.group()) > 1:
        return False
    before = text[match.start() - 1] if match.start() else ' '
    after = text[match.end()] if match.end() < len(text) else ' '
    return not (before in JOINED or before.isalnum() or after in JOINED or after.isalnum())


def _add_field_chars(run, instruction):
    from docx.oxml.ns import qn

    begin = run._element.makeelement(qn('w:fldChar'), {qn('w:fldCharType'): 'begin'})
    text = run._element.makeelement(qn('w:instrText'), {qn('xml:space'): 'preserve'})
    text.text = f' {instruction} '
    end = run._element.makeelement(qn('w:fldChar'), {qn('w:fldCharType'): 'end'})
    for child in (begin, text, end):
        run._element.append(child)


def _compact_defaults(document, Pt):
    """Remove Word's default paragraph spacing.

    The template adds 8pt after every paragraph and 1.08 line spacing. The source PDF already
    says where the whitespace goes, and inheriting Word's on top of it pushes a one-page order
    onto a second page.
    """
    style = document.styles['Normal']
    style.paragraph_format.space_before = Pt(0)
    style.paragraph_format.space_after = Pt(0)
    style.paragraph_format.line_spacing = 1.0


def _apply_page_setup(document, pages, Pt):
    """Page size from the PDF, margins from where its content actually sits.

    Copying the sheet but not the margins would reflow every paragraph at a different width than
    the source, which changes where lines break on an official document.
    """
    page = pages[0]
    section = document.sections[0]
    section.page_width, section.page_height = Pt(float(page.width)), Pt(float(page.height))
    words = page.extract_words() or []
    if not words:
        return
    left = min(float(word['x0']) for word in words)
    right = max(float(word['x1']) for word in words)
    top = min(float(word['top']) for word in words)
    bottom = max(float(word['bottom']) for word in words)
    section.left_margin = Pt(max(0.0, left))
    section.right_margin = Pt(max(0.0, float(page.width) - right))
    section.top_margin = Pt(max(0.0, top))
    section.bottom_margin = Pt(max(0.0, float(page.height) - bottom))


def _add_page_break(document):
    from docx.enum.text import WD_BREAK

    document.add_paragraph().add_run().add_break(WD_BREAK.PAGE)


def _build_page(document, page, summary, frame, embedded=(), running=None):
    if running:
        page = _body_crop(page, running)
    tables = _table_regions(page)
    images = _picture_regions(page, embedded)
    words = [
        word
        for word in (page.extract_words(extra_attrs=['size', 'fontname']) or [])
        if not _inside_any(word, [region['bbox'] for region in tables])
    ]
    lines = _group_lines(words)
    body_size = _body_size(lines)
    blocks = _group_paragraphs(lines, body_size)
    rows = _picture_rows(images)
    floating = {id(row): _block_beside(row, blocks) for row in rows}

    ordered = (
        [{'kind': 'text', 'top': block['top'], 'block': block} for block in blocks]
        + [{'kind': 'table', 'top': region['bbox'][1], 'region': region} for region in tables]
        + [{'kind': 'image', 'top': row[0]['top'], 'region': row} for row in rows if floating[id(row)] is None]
    )
    ordered.sort(key=lambda entry: entry['top'])

    frame = {**frame, 'centre': (float(page.bbox[0]) + float(page.bbox[2])) / 2}
    # One render serves every picture on the page; rendering per picture repeats the slowest step
    # in the module, and a page of signatures pays for it several times over.
    rendered = _render(page, summary) if images else None
    spacing = _spacing(ordered, float(page.height))
    paragraphs = {}
    for entry, space in zip(ordered, spacing):
        if entry['kind'] == 'text':
            paragraphs[id(entry['block'])] = _add_text_block(document, entry['block'], body_size, frame, summary, space)
        elif entry['kind'] == 'table':
            _add_table(document, entry['region'], frame, summary)
        else:
            _add_picture(document, page, entry['region'], rendered, frame, summary, space)
    for row in rows:
        block = floating[id(row)]
        if block is not None and paragraphs.get(id(block)) is not None:
            _float_pictures(paragraphs[id(block)], page, row, rendered, summary)


def _block_beside(row, blocks):
    """The first text block standing beside a row of pictures, or None when the row stands alone.

    A letterhead sets its crest and a portrait either side of the office's name. Given a line of
    their own the pictures split the letterhead in two, name above, address below. Beside means
    level with the pictures and clear of them left to right.
    """
    top = min(region['bbox'][1] for region in row)
    bottom = max(region['bbox'][3] for region in row)
    for block in blocks:
        if block['top'] >= bottom or block['bottom'] <= top:
            continue
        if all(block['x1'] <= region['bbox'][0] or block['x0'] >= region['bbox'][2] for region in row):
            return block
    return None


def _body_crop(page, running):
    """The page without the running band(s), cut exactly where the band's own content ends."""
    height = float(page.height)
    top = _band_box(page, 'top')[3] if 'top' in running else 0.0
    bottom = _band_box(page, 'bottom')[1] if 'bottom' in running else height
    if top <= 0.0 and bottom >= height:
        return page
    return page.crop((float(page.bbox[0]), top, float(page.bbox[2]), bottom))


def _spacing(ordered, page_height):
    """Vertical space to put before each element, in points.

    The white space between blocks is part of how an official document reads — the drop to the
    subject line, the room above a signature — and Word's own paragraph spacing knows nothing about
    it. Reproducing it in full is what costs a page: the same words set in a different face take
    more room than the PDF gave them, so the gaps are capped individually and then scaled together
    to fit a budget, keeping their proportions to each other.
    """
    if not ordered:
        return []
    bottoms = [_entry_bottom(entry) for entry in ordered]
    gaps = [0.0] + [
        min(max(0.0, ordered[index]['top'] - bottoms[index - 1]), MAX_BLOCK_SPACING)
        for index in range(1, len(ordered))
    ]
    budget = SPACING_BUDGET * page_height
    total = sum(gaps)
    scale = 1.0 if total <= budget else budget / total
    return [gap * scale for gap in gaps]


def _entry_bottom(entry):
    if entry['kind'] == 'text':
        return entry['block']['bottom']
    if entry['kind'] == 'table':
        return entry['region']['bbox'][3]
    return max(region['bbox'][3] for region in entry['region'])


def _table_regions(page):
    """Tables as (bbox, rows). A failed detection costs the table's cells their structure, so the
    words are left in place for the text pass rather than dropped."""
    try:
        found = page.filter(lambda obj: not _invisible(obj)).find_tables()
    except Exception:  # noqa: BLE001 - detection is best effort by design
        return []
    regions = []
    for table in found:
        try:
            rows = table.extract()
        except Exception:  # noqa: BLE001
            continue
        if not rows or not any(any((cell or '').strip() for cell in row) for row in rows):
            continue
        bbox = tuple(float(value) for value in table.bbox)
        regions.append(
            {
                'bbox': bbox,
                'rows': rows,
                'columns': _column_edges(table),
                'font': _dominant_family(page.within_bbox(bbox).chars),
            }
        )
    return regions


def _invisible(obj):
    """A shape nobody sees: filled white and never stroked.

    HTML-to-PDF converters paint each paragraph's white background as its own rectangle, and a
    stack of them has exactly the edges of a one-column table. Read as ruling, they turn a
    letter's body into a table of its paragraphs.
    """
    if obj.get('object_type') not in ('rect', 'curve') or obj.get('stroke'):
        return False
    color = obj.get('non_stroking_color')
    values = tuple(color) if isinstance(color, (tuple, list)) else (color,)
    if not values or not all(isinstance(value, (int, float)) for value in values):
        return False
    if len(values) == 4:
        return all(value <= 0.01 for value in values)
    return all(value >= 0.99 for value in values)


def _dominant_family(chars):
    counts = {}
    for char in chars:
        family = _family(char.get('fontname'))
        counts[family] = counts.get(family, 0) + len(char.get('text') or '')
    return max(counts, key=counts.get) if counts else None


def _column_edges(table):
    """The x of every vertical rule in the table, left to right.

    Without them Word sizes the columns by their contents, and a narrow "Sl" column ends up as wide
    as the name beside it while "Drawing and Painting" wraps onto two lines in a column the page
    had made wide enough.
    """
    edges = set()
    for cell in table.cells:
        if not cell:
            continue
        edges.add(round(float(cell[0]), 1))
        edges.add(round(float(cell[2]), 1))
    return sorted(edges)


def _picture_regions(page, embedded=()):
    """Every embedded image large enough to be meaningful, with its rectangle on the page.

    `embedded` holds the page's extracted streams, paired to a rectangle by pixel size: that is
    what tells a 260x239 crest from the 210x110 signature below it. Two images of identical pixel
    size on one page are consumed in the order they are drawn, which is the order both lists are
    built in.
    """
    available = list(embedded)
    regions = []
    for image in page.images or []:
        x0, x1 = float(image['x0']), float(image['x1'])
        top, bottom = float(image['top']), float(image['bottom'])
        if (x1 - x0) < MIN_IMAGE_POINTS or (bottom - top) < MIN_IMAGE_POINTS:
            continue
        regions.append(
            {
                'bbox': (x0, top, x1, bottom),
                'top': top,
                'embedded': _take_stream(available, image.get('srcsize')),
            }
        )
    return regions


def _take_stream(available, srcsize):
    if not srcsize:
        return None
    size = (int(srcsize[0]), int(srcsize[1]))
    for index, candidate in enumerate(available):
        if candidate['size'] == size:
            return available.pop(index)['image']
    return None


def _embedded_rasters(pdf_path):
    """Every raster the PDF carries, by page number, as {'size': (w, h), 'image': PIL}.

    Extraction fails on plenty of real documents — an unusual filter, a mask pypdf will not apply —
    so this is best effort throughout: a page with nothing extractable simply falls back to the
    render.
    """
    try:
        from pypdf import PdfReader
    except ImportError:
        return {}

    rasters = {}
    try:
        pages = PdfReader(str(pdf_path)).pages
    except Exception:  # noqa: BLE001 - a PDF pypdf cannot open is still convertible from the render
        return {}
    for number, page in enumerate(pages, start=1):
        try:
            images = list(page.images)
        except Exception:  # noqa: BLE001
            continue
        for image in images:
            try:
                pil = image.image
            except Exception:  # noqa: BLE001
                continue
            if pil is None:
                continue
            rasters.setdefault(number, []).append({'size': (pil.width, pil.height), 'image': pil})
    return rasters


def _picture_rows(images):
    """Pictures whose vertical ranges overlap, grouped so they stay on one line.

    A seal on the left and a signature on the right belong beside each other, as they were on the
    page; one paragraph each would stack them and cost a page.
    """
    rows = []
    for region in sorted(images, key=lambda item: item['top']):
        _, top, _, bottom = region['bbox']
        for row in rows:
            if top < row['bottom'] and bottom > row['top']:
                row['items'].append(region)
                row['top'] = min(row['top'], top)
                row['bottom'] = max(row['bottom'], bottom)
                break
        else:
            rows.append({'top': top, 'bottom': bottom, 'items': [region]})
    return [sorted(row['items'], key=lambda item: item['bbox'][0]) for row in rows]


def _inside_any(word, boxes):
    centre_x = (float(word['x0']) + float(word['x1'])) / 2
    centre_y = (float(word['top']) + float(word['bottom'])) / 2
    return any(x0 <= centre_x <= x1 and top <= centre_y <= bottom for x0, top, x1, bottom in boxes)


def _group_lines(words):
    lines = []
    for word in sorted(words, key=lambda w: (round(float(w['top']), 1), float(w['x0']))):
        top = float(word['top'])
        if lines and abs(top - lines[-1]['top']) <= LINE_TOLERANCE:
            lines[-1]['words'].append(word)
            lines[-1]['bottom'] = max(lines[-1]['bottom'], float(word['bottom']))
        else:
            lines.append({'top': top, 'bottom': float(word['bottom']), 'words': [word]})
    for line in lines:
        line['words'].sort(key=lambda w: float(w['x0']))
        line['text'] = _sane(' '.join(word['text'] for word in line['words']))
        line['size'] = max(float(word.get('size') or 0) for word in line['words'])
        line['x0'] = min(float(word['x0']) for word in line['words'])
        line['x1'] = max(float(word['x1']) for word in line['words'])
        line['bold'] = any('bold' in str(word.get('fontname', '')).lower() for word in line['words'])
        line['font'] = _family(line['words'][0].get('fontname'))
    return [line for line in lines if line['text']]


def _family(fontname):
    """`ABCDEF+NotoSansBengali-Bold` names the family `NotoSansBengali`: PDFs embed subsets under a
    six-letter tag, and Word needs the family to pick a font that can draw the script."""
    name = SUBSET_PREFIX.sub('', str(fontname or ''))
    return name.split('-')[0] or None


def _body_size(lines):
    """The most common text size on the page — the body it was set in."""
    if not lines:
        return 0.0
    counts = {}
    for line in lines:
        size = round(line['size'], 1)
        counts[size] = counts.get(size, 0) + len(line['text'])
    return max(counts.items(), key=lambda item: item[1])[0]


def _group_paragraphs(lines, body_size):
    """Consecutive lines belong together until the gap widens, the indentation shifts, or the
    text size changes — the three signals a reader uses for the same decision."""
    blocks = []
    for line in lines:
        height = max(line['bottom'] - line['top'], 1.0)
        previous = blocks[-1] if blocks else None
        if previous is not None:
            gap = line['top'] - previous['bottom']
            same_size = abs(line['size'] - previous['size']) < 0.6
            aligned = abs(line['x0'] - previous['x0']) <= INDENT_TOLERANCE
            starts_item = bool(
                BULLET.match(line['text']) or NUMBERED.match(line['text']) or BANGLA_ITEM.match(line['text'])
            )
            if gap <= PARAGRAPH_GAP * height and same_size and aligned and not starts_item:
                previous['lines'].append(line)
                previous['bottom'] = line['bottom']
                previous['x1'] = max(previous['x1'], line['x1'])
                continue
        blocks.append(
            {
                'lines': [line],
                'top': line['top'],
                'bottom': line['bottom'],
                'x0': line['x0'],
                'x1': line['x1'],
                'size': line['size'],
                'bold': line['bold'],
                'font': line['font'],
            }
        )
    return blocks


def _add_text_block(document, block, body_size, frame, summary, space_before=0.0):
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.shared import Pt

    text = _sane(' '.join(line['text'] for line in block['lines']))
    if not text:
        return None

    bullet = BULLET.match(text)
    numbered = NUMBERED.match(text)
    is_heading = block['size'] >= HEADING_RATIO * body_size and len(text) < 120

    style = None
    if bullet:
        style, text = 'List Bullet', text[bullet.end():]
    elif numbered and len(text) < 400:
        style, text = 'List Number', text[numbered.end():]
    elif is_heading:
        style = 'Heading 1' if block['size'] >= 1.4 * body_size else 'Heading 2'

    paragraph = document.add_paragraph(style=style) if style else document.add_paragraph()
    if space_before >= MIN_BLOCK_SPACING:
        paragraph.paragraph_format.space_before = Pt(min(space_before, MAX_BLOCK_SPACING))
    segments = _segments(block) if style is None else None
    if segments:
        _add_tabbed_line(paragraph, block, segments, frame, Pt)
        summary['paragraphs'] += 1
        return paragraph
    if style is None and _is_stacked(block, frame):
        _add_stacked_lines(paragraph, block, Pt)
    elif style is None:
        _add_runs(paragraph, [word for line in block['lines'] for word in line['words']], block['size'])
    else:
        run = paragraph.add_run(text)
        _apply_font(run, block['font'], text, block['size'])

    column_centre = frame['centre']
    centre = (block['x0'] + block['x1']) / 2
    if style is None and abs(centre - column_centre) <= CENTRE_TOLERANCE and block['x0'] > column_centre - 200:
        paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
    elif style is None and _is_justified(block):
        paragraph.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    elif style is None:
        # A block that starts well right of the margin is placed, not indented prose: the signature
        # block under a seal, a date over an address. Flushing it left detaches it from the picture
        # it belongs to, which is what makes a converted signature look like it floated away.
        indent = block['x0'] - frame['left']
        narrow = block['x1'] - block['x0'] < FILLED_LINE * (frame['right'] - frame['left'])
        if narrow and frame['right'] - block['x1'] <= EDGE_TOLERANCE and indent > INDENT_TOLERANCE:
            # Set against the right margin, as a date or a page count is: indenting it from the
            # left instead leaves it exactly the room it had, and a face a little wider than the
            # PDF's pushes its last word onto a line of its own.
            paragraph.alignment = WD_ALIGN_PARAGRAPH.RIGHT
        elif indent > INDENT_TOLERANCE:
            paragraph.paragraph_format.left_indent = Pt(indent)

    summary['paragraphs'] += 1
    if style == 'Heading 1' or style == 'Heading 2':
        summary['headings'] += 1
    elif style:
        summary['list_items'] += 1
    return paragraph


def _is_justified(block):
    """Whether the block was set justified: most of its lines end on the same right edge.

    Official correspondence is usually justified, and a justified paragraph re-laid out flush left
    is the difference a reader notices first between the order and its conversion. "Most" rather
    than "all but the last", because a paragraph that ends in a short line of its own — a closing
    sentence, a line broken deliberately — still reads as justified and is one.
    """
    lines = block['lines']
    if len(lines) < 3:
        return False
    edge = max(line['x1'] for line in lines)
    flush = sum(1 for line in lines if edge - line['x1'] <= INDENT_TOLERANCE)
    return flush >= max(3, JUSTIFIED_SHARE * len(lines))


def _segments(block):
    """A single line split where the page left a tab-sized gap, or None when it is ordinary prose.

    "Record Number: ... Date: 27/07/2026" is one line holding two fields pushed apart, and joining
    them with a space reads as one run-on sentence. Only single-line blocks qualify: a wide gap
    inside a wrapped paragraph is justification, not a tab.
    """
    if len(block['lines']) != 1:
        return None
    parts = []
    for word in block['lines'][0]['words']:
        x0, x1 = float(word['x0']), float(word['x1'])
        if parts and x0 - parts[-1]['x1'] <= TAB_GAP:
            parts[-1]['x1'] = x1
            parts[-1]['words'].append(word)
            continue
        parts.append({'x0': x0, 'x1': x1, 'words': [word]})
    return parts if len(parts) > 1 else None


def _add_tabbed_line(paragraph, block, segments, frame, Pt):
    for index, segment in enumerate(segments):
        if not _sane(' '.join(word['text'] for word in segment['words'])):
            continue
        if index:
            _add_tab_stop(paragraph, segment, frame, Pt)
            paragraph.add_run('\t')
        _add_runs(paragraph, segment['words'], block['size'])


def _add_tab_stop(paragraph, segment, frame, Pt):
    """A stop that puts the segment back where the page had it.

    A field that ends at the right margin — a page number, a date opposite a memo number — is set
    right-aligned there. Left-aligning it at its own start instead pushes the last word past the
    margin and wraps it onto a line of its own.
    """
    from docx.enum.text import WD_TAB_ALIGNMENT

    stops = paragraph.paragraph_format.tab_stops
    if frame['right'] - segment['x1'] <= EDGE_TOLERANCE:
        stops.add_tab_stop(Pt(frame['right'] - frame['left']), WD_TAB_ALIGNMENT.RIGHT)
        return
    # Tab stops are measured from the margin, not from the edge of the sheet.
    stops.add_tab_stop(Pt(max(segment['x0'] - frame['left'], 0)), WD_TAB_ALIGNMENT.LEFT)


def _is_stacked(block, frame):
    """Whether the block is a stack of separate lines rather than one wrapped paragraph.

    Prose wraps because it reached the right edge of the column; a letterhead, an address or a
    signer's designation is several short lines that merely sit close together. No line in such a
    block is anywhere near as wide as the column, so that is the test. Joining such a block into a
    paragraph runs its lines together, which is what turned a letterhead into one sentence.
    """
    if len(block['lines']) < 2:
        return False
    column = frame['right'] - frame['left']
    # Widths, not the right edge: a signer's name and designation set against the right margin
    # reach the edge without ever filling a line.
    return column > 0 and max(line['x1'] - line['x0'] for line in block['lines']) < FILLED_LINE * column


def _add_stacked_lines(paragraph, block, Pt):
    for index, line in enumerate(block['lines']):
        if index:
            # The break goes in a run of its own: setting `text` on a run replaces everything in
            # it, and a break added first is what gets replaced.
            paragraph.add_run().add_break()
        _add_runs(paragraph, line['words'], line['size'])


def _face(word):
    fontname = str(word.get('fontname') or '')
    return _family(fontname), 'bold' in fontname.lower()


def _spaced(before, after):
    """Whether the page left a space between two words: always across a line break, and on one
    line only when there is a visible gap. A quote mark or a bracket set in another face touches
    the word it belongs to, and a space there reads as ‘ রোকেয়া ’."""
    if abs(float(after['top']) - float(before['top'])) > LINE_TOLERANCE:
        return True
    return float(after['x0']) - float(before['x1']) > WORD_GAP * float(after.get('size') or before.get('size') or 10)


def _add_runs(paragraph, words, size):
    """One run per stretch of words sharing a face and weight.

    Official letters set a label in bold inside an ordinary sentence — "স্মারক নম্বর:", an addressee
    in the middle of a paragraph. Styling the line or the paragraph as a whole either bolds the
    sentence around the label or loses the label's bold.
    """
    previous = None
    for face, group in groupby(words, key=_face):
        group = list(group)
        text = _sane(' '.join(word['text'] for word in group))
        if not text:
            continue
        separator = ' ' if previous is not None and _spaced(previous, group[0]) else ''
        previous = group[-1]
        run = paragraph.add_run(separator + text)
        if face[1]:
            run.bold = True
        _apply_font(run, face[0], text, size)


def _word_font(family, size):
    """(family, size) Word gets for text the PDF set in `family` at `size` points.

    A Bangla font (SolaimanLipi, Kalpurush…) becomes Nikosh, the one Bangla font the output uses
    and embeds, so the document looks the same on a PC without the PDF's font. Nikosh draws Bangla
    about 11 % smaller at the same size, so the size is converted with `size_for` from the PDF's
    own size (SolaimanLipi 10.2 pt becomes Nikosh 11.5 pt), before Word rounds it to half points.
    Latin fonts and Nikosh keep their size, rounded to a tenth."""
    if family and family != DEFAULT_FONT and is_bangla_font(family):
        return DEFAULT_FONT, size_for(family, size) if size else None
    return family, round(size, 1) if size else None


def _apply_font(run, family, text, size=None):
    """Name the font on the run, including the complex-script slot.

    Word picks the font for Bengali from `w:cs`/`w:eastAsia`, not from `w:ascii`. Setting only the
    Latin slot leaves a Bangla paragraph to whatever the reader defaults to, which is how mixed
    Bangla/English documents end up with boxes in one language and text in the other.
    `size` is the PDF's size in points; see `_word_font`.
    """
    from docx.oxml.ns import qn
    from docx.shared import Pt

    family, points = _word_font(family, size)
    if points:
        run.font.size = Pt(points)
    bengali = bool(BENGALI.search(text or ''))
    if family:
        run.font.name = family
        element = run._element.rPr.rFonts
        element.set(qn('w:cs'), family)
        if bengali:
            element.set(qn('w:eastAsia'), family)
    if bengali:
        _complex_script(run)


def _complex_script(run):
    """Give Bangla the size, weight and language Word reads for it.

    Word sets Bengali as a complex script: it takes the size from `w:szCs` and the weight from
    `w:bCs`, not from `w:sz` and `w:b`. Without them a 12pt bold Bangla heading prints at the
    document default in regular weight, and the page count changes with it.
    """
    from docx.oxml.ns import qn

    properties = run._element.get_or_add_rPr()
    if run.bold:
        properties.get_or_add_bCs()
    for tag, attributes in (
        ('w:szCs', {qn('w:val'): str(round(run.font.size.pt * 2))} if run.font.size else None),
        ('w:lang', {qn('w:bidi'): 'bn-BD'}),
    ):
        if attributes is None or properties.find(qn(tag)) is not None:
            continue
        successors = RUN_PROPERTY_TAIL[RUN_PROPERTY_TAIL.index(tag) + 1:]
        properties.insert_element_before(properties.makeelement(qn(tag), attributes), *successors)


def _add_table(document, region, frame, summary):
    rows = [[_sane(cell) for cell in row] for row in region['rows']]
    width = max(len(row) for row in rows)
    table = document.add_table(rows=len(rows), cols=width)
    table.style = 'Table Grid'
    for row_index, row in enumerate(rows):
        for column_index in range(width):
            value = row[column_index] if column_index < len(row) else ''
            cell = table.cell(row_index, column_index)
            cell.text = value
            for run in cell.paragraphs[0].runs:
                _apply_font(run, region.get('font'), value)
    _apply_column_widths(table, region.get('columns'), width, frame)
    summary['tables'] += 1


def _apply_column_widths(table, edges, count, frame):
    """Give each column the width the page gave it, clipped to the text column."""
    from docx.shared import Pt

    if not edges or len(edges) != count + 1:
        return
    available = frame['right'] - frame['left']
    span = edges[-1] - edges[0]
    scale = available / span if span > available and span > 0 else 1.0
    table.autofit = False
    for index in range(count):
        width = Pt((edges[index + 1] - edges[index]) * scale)
        table.columns[index].width = width
        for cell in table.columns[index].cells:
            cell.width = width


INLINE = '{http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing}inline'
EMU_PER_POINT = 12700


def _float_pictures(paragraph, page, row, rendered, summary):
    """Anchor a row of pictures to `paragraph`, each at the spot on the page it had in the PDF.

    Square wrapping keeps text off them if the paragraph around them reflows, on the larger side
    only: offered both, a centred letterhead line puts its first word in the sliver of margin
    beside the crest.
    """
    from docx.shared import Pt

    for region in row:
        x0, top, x1, bottom = region['bbox']
        picture = _raster(region, rendered, page, summary)
        if picture is None:
            continue
        buffer = io.BytesIO()
        picture.save(buffer, format='PNG')
        buffer.seek(0)
        run = paragraph.add_run()
        run.add_picture(buffer, width=Pt(x1 - x0), height=Pt(bottom - top))
        _anchor(run, x0, top, summary['pictures'])
        summary['pictures'] += 1


def _anchor(run, x, y, order):
    """Turn the run's inline picture into one anchored to the page at (x, y) points."""
    from docx.oxml.ns import qn

    inline = next(run._element.iter(INLINE), None)
    if inline is None:
        return
    make = inline.makeelement
    anchor = make(qn('wp:anchor'), {
        'distT': '0', 'distB': '0', 'distL': '0', 'distR': '0', 'simplePos': '0',
        'relativeHeight': str(251658240 + order), 'behindDoc': '0', 'locked': '0',
        'layoutInCell': '1', 'allowOverlap': '1',
    })
    anchor.append(make(qn('wp:simplePos'), {'x': '0', 'y': '0'}))
    for axis, offset in (('wp:positionH', x), ('wp:positionV', y)):
        position = make(qn(axis), {'relativeFrom': 'page'})
        position_offset = make(qn('wp:posOffset'), {})
        position_offset.text = str(round(offset * EMU_PER_POINT))
        position.append(position_offset)
        anchor.append(position)
    anchor.append(copy.deepcopy(inline.find(qn('wp:extent'))))
    anchor.append(make(qn('wp:effectExtent'), {'l': '0', 't': '0', 'r': '0', 'b': '0'}))
    anchor.append(make(qn('wp:wrapSquare'), {'wrapText': 'largest'}))
    for tag in ('wp:docPr', 'wp:cNvGraphicFramePr', 'a:graphic'):
        child = inline.find(qn(tag))
        if child is not None:
            anchor.append(copy.deepcopy(child))
    inline.getparent().replace(inline, anchor)


def _hug_the_margin(run):
    """Say out loud that an inline picture keeps no space around it.

    With the `dist*` attributes absent, LibreOffice falls back to its own default and insets every
    picture 9pt from the margin — enough to leave a seal visibly out of line with the text above
    it, and enough to move everything a tab stop was measured against.
    """
    for inline in run._element.iter(INLINE):
        for side in ('distT', 'distB', 'distL', 'distR'):
            inline.set(side, '0')


def _render(page, summary):
    """The page as an image, or None when it cannot be rendered."""
    try:
        return page.to_image(resolution=IMAGE_DPI).original
    except Exception as error:  # noqa: BLE001 - a missing render costs pictures, never the document
        summary['warnings'].append(f'a page could not be rendered: {error}')
        return None


def _raster(region, rendered, page, summary):
    """The pixels to place for one picture: its own stream when that still matches the page."""
    crop = _crop(region['bbox'], rendered, page)
    embedded = region.get('embedded')
    if embedded is None:
        if crop is None:
            summary['warnings'].append('a picture could not be read from the page and was skipped')
        return crop
    if crop is None or _resembles(embedded, crop):
        return embedded
    summary['warnings'].append(
        'a picture was taken from the page render because its embedded copy did not match it'
    )
    return crop


def _crop(bbox, rendered, page):
    if rendered is None:
        return None
    x0, top, x1, bottom = bbox
    scale = rendered.width / float(page.width)
    box = (
        max(0, int(x0 * scale)),
        max(0, int(top * scale)),
        min(rendered.width, int(round(x1 * scale))),
        min(rendered.height, int(round(bottom * scale))),
    )
    if box[2] <= box[0] or box[3] <= box[1]:
        return None
    return rendered.crop(box)


def _resembles(embedded, crop):
    """Whether an extracted stream shows what the page shows.

    Both are reduced to the same small thumbnail and compared channel by channel, so this measures
    content rather than resolution: a crest that extracted correctly matches its own render, and a
    logo whose transparency was lost comes back as a black or white block that does not.
    """
    from PIL import ImageChops, ImageStat

    try:
        size = (COMPARISON_SIZE, COMPARISON_SIZE)
        left = embedded.convert('RGB').resize(size)
        right = crop.convert('RGB').resize(size)
        difference = ImageStat.Stat(ImageChops.difference(left, right)).mean
    except Exception:  # noqa: BLE001 - an image that cannot be compared is not trusted
        return False
    return sum(difference) / len(difference) <= EMBEDDED_DIFFERENCE


def _add_picture(document, page, row, rendered, frame, summary, space_before=0.0):
    """Place a row of pictures where it sat on the page.

    Each picture comes from the PDF's own embedded stream when that stream still looks like what
    the page shows. Those pixels are the ones the producer put there: a QR code cut out of a page
    render stops scanning, because the render resamples its modules and eats the quiet zone around
    them, and a crest loses its edges the same way.

    Extraction is not always faithful — a soft mask, a stencil or a colour space read the other way
    round turns a logo into a black box — so every candidate is compared against the render before
    it is used, and the render is kept whenever the two disagree.
    """
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.shared import Pt

    paragraph = document.add_paragraph()
    if space_before >= MIN_BLOCK_SPACING:
        paragraph.paragraph_format.space_before = Pt(min(space_before, MAX_BLOCK_SPACING))
    placed = []
    for region in row:
        x0, top, x1, bottom = region['bbox']
        picture = _raster(region, rendered, page, summary)
        if picture is None:
            continue
        buffer = io.BytesIO()
        picture.save(buffer, format='PNG')
        buffer.seek(0)
        if placed:
            # Hold the gap the page had between them, so a seal and a signature keep their spread.
            gap = x0 - placed[-1]['bbox'][2]
            _add_tab_stop(paragraph, {'x0': x0, 'x1': x1}, frame, Pt)
            paragraph.add_run('\t' if gap > 0 else ' ')
        run = paragraph.add_run()
        run.add_picture(buffer, width=Pt(x1 - x0), height=Pt(bottom - top))
        _hug_the_margin(run)
        placed.append(region)
        summary['pictures'] += 1

    if not placed:
        return
    left = placed[0]['bbox'][0]
    right = placed[-1]['bbox'][2]
    centre = (left + right) / 2
    column_centre = frame['centre']
    if len(placed) == 1:
        if abs(centre - column_centre) <= CENTRE_TOLERANCE * 2:
            paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
        elif centre > column_centre:
            paragraph.alignment = WD_ALIGN_PARAGRAPH.RIGHT
