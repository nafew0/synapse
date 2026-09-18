#!/usr/bin/env python3
"""Prove a PDF-to-Word conversion kept what the user was promised.

    python verify_conversion.py SOURCE.pdf OUTPUT.docx --mode layout-editable

Checks, in the order they matter:

    pages        the Word document has as many pages as the PDF
    text         the recovered text is at least --min-text of the PDF's, and not a token amount
    picture_book no page-sized image stands in for a page, and a document with pictures has text
    images       every raster in the PDF appears in word/media, matched by pixel size, not by name
    qr           every QR that decodes in the PDF still decodes from the output's media
    page_size    the Word page matches the PDF page within a point

Prints a human summary, or JSON with --json. Exits 0 when clean, 2 when the conversion has
defects, 1 on bad input. A defect is not something to explain away in the final message: fix it,
or tell the user which check failed.
"""
import argparse
import io
import json
import re
import sys
import zipfile
from pathlib import Path

import probe

LAYOUT_EDITABLE = 'layout-editable'
SEMANTIC_EDITABLE = 'semantic-editable'
VISUAL_FIDELITY = 'visual-fidelity'
MODES = (LAYOUT_EDITABLE, SEMANTIC_EDITABLE, VISUAL_FIDELITY)

PAGE_DRIFT = 0.25
"""Pages a reflowed document may gain or lose before it looks like content went missing."""
DEFAULT_MIN_TEXT_RATIO = 0.70
# Under this, "some text came through" is indistinguishable from a caption on a page image.
MIN_CHARACTERS = 200
# A picture this close to the page in both directions has replaced the page rather than sat on it.
PAGE_IMAGE_COVERAGE = 0.9
PAGE_SIZE_TOLERANCE_POINTS = 1.0
COLUMN_GUTTER = 36.0
"""White space inside a line wide enough to be a gutter between columns rather than a tab."""
COLUMN_DRIFT = 90.0
"""How far from the centre of the page that gutter may sit."""
COLUMN_SHARE = 0.5
COLUMN_MIN_LINES = 6
COLUMN_BUCKET = 12.0
"""Points of drift allowed between one line's gutter and another's before they are two gaps."""
# Conversions rewrite a raster, so match by shape and scale rather than by exact pixel count.
SIZE_TOLERANCE = 0.02


class InputError(probe.InputError):
    pass


def check(pdf_path, docx_path, mode=LAYOUT_EDITABLE, min_text_ratio=DEFAULT_MIN_TEXT_RATIO):
    pdf_path, docx_path = Path(pdf_path), Path(docx_path)
    if mode not in MODES:
        raise InputError(f'unknown mode {mode!r}; choose one of {", ".join(MODES)}')

    findings = []
    source_text = probe.normalize(probe.pdf_text(pdf_path))
    output_text = probe.normalize(probe.docx_text(docx_path))
    source_pages = probe.pdf_pages(pdf_path)
    # A reflowed document is counted as a reader sees it, not as its breaks claim: text re-set in
    # another face spills onto a page the XML knows nothing about.
    output_pages = (
        probe.rendered_pages(docx_path) if mode == SEMANTIC_EDITABLE else None
    ) or probe.docx_pages(docx_path)
    source_media = probe.pdf_media(pdf_path)
    source_count = probe.pdf_image_count(pdf_path)
    output_media = probe.docx_media(docx_path)

    # A running header is stored once and printed on every page. The PDF carries it once per
    # page, so it is counted that way here too, or a letterhead moved into a real Word header
    # reads as text that went missing.
    running = probe.normalize(probe.docx_running_text(docx_path))
    if running and output_pages > 1:
        output_text += running * (output_pages - 1)

    _check_opens(findings, docx_path)
    _check_pages(findings, source_pages, output_pages, mode)
    if mode == SEMANTIC_EDITABLE:
        _check_reflows(findings, docx_path)
        _check_columns(findings, pdf_path)
    if mode != VISUAL_FIDELITY:
        _check_text(findings, source_text, output_text, min_text_ratio)
        _check_picture_book(findings, docx_path, output_text, output_media, mode)
        # Losing a logo, a seal or a signature is a defect in any mode that claims to be a
        # conversion. Scoping this to layout-editable let a rebuilt, image-free document pass.
        if mode == SEMANTIC_EDITABLE:
            _check_placements(findings, pdf_path, docx_path, output_media)
        else:
            _check_images(findings, source_count, source_media, output_media)
    _check_qr(findings, source_media, output_media)
    _check_page_size(findings, pdf_path, docx_path)

    ratio = len(output_text) / len(source_text) if source_text else None
    return {
        'status': 'clean' if not findings else 'defects',
        'mode': mode,
        'pages': output_pages,
        'source_pages': source_pages,
        'characters': len(output_text),
        'source_characters': len(source_text),
        'text_ratio': round(ratio, 4) if ratio is not None else None,
        'images': len(output_media),
        'source_images': source_count,
        'source_images_read': len(source_media),
        'findings': findings,
    }


IGNORABLE_PATTERN = re.compile(r'mc:Ignorable="([^"]*)"')
DECLARED_PATTERN = re.compile(r'xmlns:([A-Za-z0-9_.-]+)=')


def _check_opens(findings, docx_path):
    """Word and LibreOffice refuse a document whose `mc:Ignorable` names a prefix the root does
    not declare — "source file could not be loaded", with every part otherwise present and well
    formed. A conversion that survives every other check and cannot be opened is the worst
    outcome this gate can wave through, so it is checked before anything about content.
    """
    try:
        with zipfile.ZipFile(docx_path) as archive:
            names = archive.namelist()
            if '[Content_Types].xml' not in names:
                _finding(findings, 'opens', 'the package has no [Content_Types].xml')
                return
            if 'word/document.xml' not in names:
                _finding(findings, 'opens', 'the package has no word/document.xml')
                return
            document = archive.read('word/document.xml').decode('utf-8', 'replace')
    except (OSError, zipfile.BadZipFile) as error:
        _finding(findings, 'opens', f'the file is not a readable .docx: {error}')
        return

    root_tag = document[: document.find('>', document.find('<w:document'))]
    declared = set(DECLARED_PATTERN.findall(root_tag))
    ignorable = IGNORABLE_PATTERN.search(root_tag)
    undeclared = [
        prefix for prefix in (ignorable.group(1).split() if ignorable else []) if prefix not in declared
    ]
    if undeclared:
        _finding(
            findings,
            'opens',
            f'mc:Ignorable names undeclared namespace(s) {", ".join(undeclared)}; '
            'Word and LibreOffice will refuse the file',
        )


def _finding(findings, check_name, detail):
    findings.append({'check': check_name, 'detail': detail})


def _check_pages(findings, source_pages, output_pages, mode=LAYOUT_EDITABLE):
    if source_pages == output_pages:
        return
    if mode == SEMANTIC_EDITABLE:
        # Reflowed text repaginates by design: a paragraph set at a different leading may run onto
        # another page. Losing or inventing a lot of pages still means content went missing.
        if abs(source_pages - output_pages) <= max(1, round(source_pages * PAGE_DRIFT)):
            return
    _finding(
        findings,
        'pages',
        f'the PDF has {source_pages} page(s), the Word document has {output_pages}',
    )


def _check_reflows(findings, docx_path):
    """The whole point of semantic-editable: the text must be in paragraphs, not positioned boxes.

    A document whose lines each sit in their own text box looks right and cannot be edited —
    typing reflows nothing, so the line grows past its frame while its neighbours stay put. That
    is exactly what this mode exists to avoid, and it is invisible to every other check here.
    """
    try:
        with zipfile.ZipFile(docx_path) as archive:
            document = archive.read('word/document.xml').decode('utf-8', 'replace')
    except (OSError, KeyError, zipfile.BadZipFile):
        return
    boxes = document.count('<w:txbxContent>')
    if boxes:
        _finding(
            findings,
            'reflows',
            f'{boxes} text box(es) hold the text, so editing it will not reflow; '
            'semantic-editable must produce paragraphs',
        )


def _check_columns(findings, pdf_path):
    """Refuse a page set in columns: semantic-editable reads straight across it.

    Lines are recovered by their vertical position, so two columns come back interleaved — the
    first line of the left column, then the first line of the right — which reads as nonsense and
    is invisible to every other check here. A columned document needs layout-editable.
    """
    import pdfplumber

    with pdfplumber.open(str(pdf_path)) as pdf:
        for number, page in enumerate(pdf.pages, start=1):
            if _is_columned(page):
                _finding(
                    findings,
                    'columns',
                    f'page {number} is set in columns, which semantic-editable reads straight '
                    'across; convert it with --mode layout-editable',
                )
                return


def _is_columned(page):
    """Whether the page is set in columns: one gutter, in the same place, on most of its lines.

    A table's cells also leave wide gaps, and a memo number opposite a date leaves one too, so the
    gaps have to line up with each other before they mean a column. Table rows are left out
    entirely — a table is read cell by cell, not across.
    """
    tables = _table_boxes(page)
    lines = [
        line
        for line in (page.extract_text_lines() or [])
        if not _inside(line, tables)
    ]
    if len(lines) < COLUMN_MIN_LINES:
        return False
    middle = (float(page.bbox[0]) + float(page.bbox[2])) / 2
    buckets = {}
    for line in lines:
        gutter = _gutter(sorted(line.get('chars', []), key=lambda char: float(char['x0'])), middle)
        if gutter is None:
            continue
        key = round(gutter / COLUMN_BUCKET)
        buckets[key] = buckets.get(key, 0) + 1
    return bool(buckets) and max(buckets.values()) >= COLUMN_SHARE * len(lines)


def _table_boxes(page):
    try:
        return [tuple(float(value) for value in table.bbox) for table in page.find_tables()]
    except Exception:  # noqa: BLE001 - no tables found is the same as no tables here
        return []


def _inside(line, boxes):
    centre = (float(line['top']) + float(line['bottom'])) / 2
    return any(top <= centre <= bottom for _, top, _, bottom in boxes)


def _gutter(chars, middle):
    """The middle of the widest central gap in a line, or None when it has none."""
    for previous, current in zip(chars, chars[1:]):
        gap = float(current['x0']) - float(previous['x1'])
        if gap < COLUMN_GUTTER:
            continue
        centre = (float(previous['x1']) + float(current['x0'])) / 2
        if abs(centre - middle) <= COLUMN_DRIFT:
            return centre
    return None


def _check_text(findings, source_text, output_text, min_text_ratio):
    if not source_text:
        if output_text:
            return
        _finding(findings, 'text', 'the PDF carries no extractable text; it needs OCR, not conversion')
        return
    ratio = len(output_text) / len(source_text)
    if ratio < min_text_ratio:
        _finding(
            findings,
            'text',
            f'{len(output_text)} of the PDF\'s {len(source_text)} characters came through '
            f'({ratio:.0%}, below the {min_text_ratio:.0%} floor)',
        )
    if len(source_text) >= MIN_CHARACTERS and len(output_text) < MIN_CHARACTERS:
        _finding(
            findings,
            'text',
            f'only {len(output_text)} character(s) of text survived; the document is not editable',
        )


def _check_picture_book(findings, docx_path, output_text, output_media, mode):
    width, height = probe.docx_page_size(docx_path)
    for index, (cx, cy) in enumerate(probe.docx_extents(docx_path), start=1):
        if cx >= PAGE_IMAGE_COVERAGE * width and cy >= PAGE_IMAGE_COVERAGE * height:
            _finding(
                findings,
                'picture_book',
                f'picture {index} covers {cx:.0f}x{cy:.0f}pt of a {width:.0f}x{height:.0f}pt page — '
                f'a page image is not {mode}',
            )
    if output_media and not output_text:
        _finding(
            findings,
            'picture_book',
            f'the document holds {len(output_media)} image(s) and no text at all',
        )


def _check_images(findings, source_count, source_media, output_media):
    if source_count and not output_media:
        _finding(
            findings,
            'images',
            f'the PDF places {source_count} image(s) and the Word document has none — every logo, '
            'seal and signature was lost',
        )
        return
    if source_count > len(source_media):
        _finding(
            findings,
            'images',
            f"{source_count - len(source_media)} of the PDF's {source_count} image(s) could not be "
            'read, so image preservation could not be verified',
        )
    available = [(entry['width'], entry['height']) for entry in output_media]
    for entry in source_media:
        if _take_match(available, entry['width'], entry['height']) is None:
            _finding(
                findings,
                'images',
                f"the {entry['width']}x{entry['height']}px image on page {entry['page']} is not in "
                'the Word document',
            )


def _check_placements(findings, pdf_path, docx_path, output_media):
    """Every picture the PDF draws is drawn again, at the size the reader showed it.

    Pixel counts cannot carry this check in semantic-editable. A picture may be re-rendered rather
    than lifted from the PDF, and Word stores one copy of a raster placed twice — a signature on
    both pages is one file in `word/media`, which looks like a loss and is not. What survives both
    is the rectangle: a lost logo leaves its rectangle with nothing in it.
    """
    placements = probe.pdf_placements(pdf_path)
    if placements and not output_media:
        _finding(
            findings,
            'images',
            f'the PDF draws {len(placements)} picture(s) and the Word document has none — every '
            'logo, seal and signature was lost',
        )
        return
    available = list(probe.docx_pictures(docx_path))
    for placement in placements:
        if _take_picture(available, placement['width'], placement['height']) is None:
            _finding(
                findings,
                'images',
                f"the {placement['width']:.0f}x{placement['height']:.0f}pt picture on page "
                f"{placement['page']} is not in the Word document",
            )


def _take_picture(available, width, height):
    """Match a source placement to a picture in the output, spending it unless it repeats.

    A picture in a running header is drawn by Word on every page from one copy, so it answers for
    the crest on page 1 and the crest on page 2 alike.
    """
    for index, picture in enumerate(available):
        if not (_similar(width, picture['width']) and _similar(height, picture['height'])):
            continue
        if not picture['repeats']:
            available.pop(index)
        return picture
    return None


def _take_match(available, width, height):
    for index, (other_width, other_height) in enumerate(available):
        if _similar(width, other_width) and _similar(height, other_height):
            return available.pop(index)
    return None


def _similar(first, second):
    if not first or not second:
        return first == second
    return abs(first - second) <= SIZE_TOLERANCE * max(first, second)


def _check_qr(findings, source_media, output_media):
    from PIL import Image

    expected = set()
    for entry in source_media:
        expected |= probe.decode_qr(entry['image'])
    if not expected:
        return

    delivered = set()
    for entry in output_media:
        with Image.open(io.BytesIO(entry['bytes'])) as image:
            delivered |= probe.decode_qr(image)
    for payload in sorted(expected - delivered):
        _finding(findings, 'qr', f'the QR code encoding {payload!r} no longer decodes in the output')


def _check_page_size(findings, pdf_path, docx_path):
    source = probe.pdf_page_size(pdf_path)
    output = probe.docx_page_size(docx_path)
    if any(abs(a - b) > PAGE_SIZE_TOLERANCE_POINTS for a, b in zip(source, output)):
        _finding(
            findings,
            'page_size',
            f'the PDF page is {source[0]:.1f}x{source[1]:.1f}pt, the Word page is '
            f'{output[0]:.1f}x{output[1]:.1f}pt',
        )


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument('pdf', type=Path, help='the PDF the conversion started from')
    parser.add_argument('docx', type=Path, help='the Word document about to be delivered')
    parser.add_argument('--mode', choices=MODES, default=LAYOUT_EDITABLE, help='the mode delivered')
    parser.add_argument(
        '--min-text',
        type=float,
        default=DEFAULT_MIN_TEXT_RATIO,
        metavar='RATIO',
        help=f'text recovery floor, 0-1 (default {DEFAULT_MIN_TEXT_RATIO})',
    )
    parser.add_argument('--json', action='store_true', help='machine-readable output')
    args = parser.parse_args()

    try:
        for path in (args.pdf, args.docx):
            if not path.is_file():
                raise InputError(f'File not found: {path}')
        if not 0 < args.min_text <= 1:
            raise InputError(f'--min-text takes a ratio between 0 and 1: {args.min_text}')
        result = check(args.pdf, args.docx, args.mode, args.min_text)
    except probe.InputError as error:
        print(json.dumps({'error': str(error)}) if args.json else f'error: {error}')
        return 1

    if args.json:
        print(json.dumps(result, indent=2))
    elif result['status'] == 'clean':
        share = '' if result['text_ratio'] is None else f" ({result['text_ratio']:.0%} of the PDF)"
        print(
            f"clean: {result['mode']}, {result['pages']} page(s), {result['characters']} "
            f"characters{share}, {result['images']} image(s)"
        )
    else:
        for finding in result['findings']:
            print(f"{finding['check']} | {finding['detail']}")
        print(f"{len(result['findings'])} defect(s)")
    return 0 if result['status'] == 'clean' else 2


if __name__ == '__main__':
    sys.exit(main())
