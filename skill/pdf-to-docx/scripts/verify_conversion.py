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
import sys
from pathlib import Path

import probe

LAYOUT_EDITABLE = 'layout-editable'
SEMANTIC_EDITABLE = 'semantic-editable'
VISUAL_FIDELITY = 'visual-fidelity'
MODES = (LAYOUT_EDITABLE, SEMANTIC_EDITABLE, VISUAL_FIDELITY)

DEFAULT_MIN_TEXT_RATIO = 0.70
# Under this, "some text came through" is indistinguishable from a caption on a page image.
MIN_CHARACTERS = 200
# A picture this close to the page in both directions has replaced the page rather than sat on it.
PAGE_IMAGE_COVERAGE = 0.9
PAGE_SIZE_TOLERANCE_POINTS = 1.0
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
    output_pages = probe.docx_pages(docx_path)
    source_media = probe.pdf_media(pdf_path)
    output_media = probe.docx_media(docx_path)

    _check_pages(findings, source_pages, output_pages)
    if mode != VISUAL_FIDELITY:
        _check_text(findings, source_text, output_text, min_text_ratio)
        _check_picture_book(findings, docx_path, output_text, output_media, mode)
    if mode == LAYOUT_EDITABLE:
        _check_images(findings, source_media, output_media)
        _check_qr(findings, source_media, output_media)
    if mode != SEMANTIC_EDITABLE:
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
        'source_images': len(source_media),
        'findings': findings,
    }


def _finding(findings, check_name, detail):
    findings.append({'check': check_name, 'detail': detail})


def _check_pages(findings, source_pages, output_pages):
    if source_pages != output_pages:
        _finding(
            findings,
            'pages',
            f'the PDF has {source_pages} page(s), the Word document has {output_pages}',
        )


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


def _check_images(findings, source_media, output_media):
    available = [(entry['width'], entry['height']) for entry in output_media]
    for entry in source_media:
        match = _take_match(available, entry['width'], entry['height'])
        if match is None:
            _finding(
                findings,
                'images',
                f"the {entry['width']}x{entry['height']}px image on page {entry['page']} is not in "
                'the Word document',
            )


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
