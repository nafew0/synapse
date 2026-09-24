#!/usr/bin/env python3
"""Render a document the way the user will see it and read its Bangla back with OCR.

The other Bangla checks read the file's XML. This one checks the pixels: the file is converted to
PDF with LibreOffice, each page is drawn to an image and read with Tesseract (`ben+eng`), and the
Bangla OCR reads is compared with the Bangla LibreOffice laid out on that page (the PDF's text
layer). Text that is drawn as boxes, as dotted circles, with its vowel signs in the wrong place, in
a font that cannot shape it, or clipped by a cell or a text box reads back as different letters.

The comparison is per page and ignores word order, because OCR reads a letterhead, a table or two
columns in a different order than the text layer lists them. For each page it counts the pairs of
adjacent letters inside the page's Bangla words (with the word's edges, so a one-letter word
counts) and reports the share that OCR did not read: the miss rate. Measured 2026-09-25 with the
sandbox's tessdata_best `ben` model at 300 dpi on the four-page Rokeya Chair circular: clean pages
in SolaimanLipi miss 0.4-1.2 %, the same letter rebuilt in Nikosh 11.5 pt 1.6-5.2 % (Tesseract
reads Nikosh less well); a DOCX made from its broken PDF text layer misses 22-34 % per page, the
PDF itself 30-47 %. At 200 dpi the Nikosh pages reached 8.5 %. The gate fails a page above 12 %.

A page with fewer than 100 Bangla letters is not judged: on so little text one misread word moves
the rate by several points (a 66-letter garbled page measured 12 %, its neighbours 22-34 %). Words the
original file already had garbled (`--original`) are left out of the count, so an edit is not
blamed for text it did not write. Garbled text also makes OCR misread the words around it, so when
the original was garbled and every word OCR missed on a page is one the original already had, the
page is a note, not a failure.

Usage:
    python render.py FILE [--original INPUT] [--pages 10]

FILE is a .docx, .xlsx, .pptx or .pdf. Prints JSON and exits 0 when clean or when the check
cannot run here (`status: skipped`), 2 when a page fails, 1 on bad input.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from office.bangla import BENGALI_RUN, classify, normalize

DPI = 300
MAX_PAGES = 10
MISS_THRESHOLD = 0.12
MIN_LETTERS = 100
LANGUAGES = 'ben+eng'
WORKERS = 4
EXAMPLES = 8
TOOLS = ('soffice', 'pdfinfo', 'pdftotext', 'pdftoppm', 'tesseract')
PAGES = re.compile(r'^Pages:\s+(\d+)', re.MULTILINE)
EDGE = ' '
TIMEOUT = 180


class InputError(Exception):
    pass


def missing_tools():
    """What this machine lacks to run the check: programs, or Tesseract's Bengali model."""
    missing = [tool for tool in TOOLS if shutil.which(tool) is None]
    if 'tesseract' in missing:
        return missing
    listed = subprocess.run(['tesseract', '--list-langs'], capture_output=True, text=True, timeout=30)
    if 'ben' not in (listed.stdout + listed.stderr).split():
        missing.append('tesseract ben model')
    return missing


def to_pdf(path, workdir):
    """The PDF LibreOffice prints `path` as; a PDF is used as it is."""
    if path.suffix.lower() == '.pdf':
        return path
    from office.soffice import run_soffice

    run_soffice(
        ['--headless', '--convert-to', 'pdf', '--outdir', str(workdir), str(path)],
        capture_output=True, timeout=TIMEOUT,
    )
    pdf = workdir / f'{path.stem}.pdf'
    if not pdf.is_file():
        raise InputError(f'LibreOffice could not convert {path.name} to PDF')
    return pdf


def page_count(pdf):
    info = subprocess.run(['pdfinfo', str(pdf)], capture_output=True, text=True, timeout=60).stdout
    found = PAGES.search(info)
    return int(found.group(1)) if found else 0


def text_layer(pdf, page):
    found = subprocess.run(
        ['pdftotext', '-f', str(page), '-l', str(page), '-enc', 'UTF-8', str(pdf), '-'],
        capture_output=True, text=True, timeout=60,
    )
    return found.stdout


def read_page(pdf, page, workdir):
    """What Tesseract reads on one page drawn at DPI."""
    stem = workdir / f'page-{page}'
    subprocess.run(
        ['pdftoppm', '-r', str(DPI), '-gray', '-png', '-singlefile', '-f', str(page), '-l', str(page),
         str(pdf), str(stem)],
        capture_output=True, timeout=TIMEOUT, check=True,
    )
    image = stem.with_suffix('.png')
    environment = {**os.environ, 'OMP_THREAD_LIMIT': '1'}
    found = subprocess.run(
        ['tesseract', str(image), '-', '-l', LANGUAGES],
        capture_output=True, text=True, timeout=TIMEOUT, env=environment,
    )
    image.unlink(missing_ok=True)
    return found.stdout


def words(text):
    return BENGALI_RUN.findall(normalize(text))


def letter_pairs(found):
    """Counter of adjacent letter pairs inside each word, the word's edges included."""
    pairs = Counter()
    for word in found:
        padded = EDGE + word + EDGE
        pairs.update(zip(padded, padded[1:], strict=False))
    return pairs


def compare(expected, seen, inherited=frozenset()):
    """(miss rate, letters judged, words OCR did not read) for one page.

    `inherited` are garbled words the original already had; they are not judged."""
    judged = [word for word in words(expected) if word not in inherited]
    read = words(seen)
    wanted = letter_pairs(judged)
    total = sum(wanted.values())
    if not total:
        return 0.0, 0, []
    missed = sum((wanted - letter_pairs(read)).values())
    read = set(read)
    unread = list(dict.fromkeys(word for word in judged if word not in read))
    return missed / total, sum(len(word) for word in judged), unread


def original_words(original):
    """(garbled, all) normalised Bangla words of the original; both empty without one."""
    if original is None:
        return frozenset(), frozenset()
    from office.runs import open_document

    _, reader = open_document(original)
    found = {word for _, text in reader.paragraphs() for word in words(text)}
    garbled = {word for word in found if classify(word) in ('broken', 'mixed')}
    return frozenset(garbled), frozenset(found)


def check(path, original=None, max_pages=MAX_PAGES):
    path = Path(path)
    missing = missing_tools()
    if missing:
        return {'status': 'skipped', 'reason': f'not installed here: {", ".join(missing)}', 'pages': [], 'findings': []}
    inherited, known = original_words(original)
    with tempfile.TemporaryDirectory(prefix='bangla_render_') as scratch:
        workdir = Path(scratch)
        pdf = to_pdf(path, workdir)
        total = page_count(pdf)
        numbers = list(range(1, min(total, max_pages) + 1))
        layers = {page: text_layer(pdf, page) for page in numbers}
        judged = [page for page in numbers if sum(len(word) for word in words(layers[page])) >= MIN_LETTERS]
        with ThreadPoolExecutor(max_workers=WORKERS) as pool:
            readings = dict(zip(judged, pool.map(lambda page: read_page(pdf, page, workdir), judged), strict=True))
    pages, findings, notes = [], [], []
    for page in judged:
        rate, letters, unread = compare(layers[page], readings[page], inherited)
        pages.append({'page': page, 'letters': letters, 'miss_rate': round(rate, 3)})
        if letters < MIN_LETTERS or rate <= MISS_THRESHOLD:
            continue
        finding = {
            'check': 'render',
            'where': f'page {page}',
            'detail': (
                f'OCR of the rendered page misses {rate:.0%} of its Bangla (limit {MISS_THRESHOLD:.0%}); '
                f'words not read back: {", ".join(unread[:EXAMPLES])}. Render the page and look at it: '
                'boxes, dotted circles, misplaced vowel signs, a font that cannot draw Bangla, or clipped text'
            ),
        }
        (notes if inherited and set(unread) <= known else findings).append(finding)
    result = {
        'status': 'defects_found' if findings else 'clean',
        'pages': pages,
        'findings': findings,
        'notes': notes,
        'pages_total': total,
    }
    if total > max_pages:
        result['note'] = f'only pages 1-{max_pages} of {total} were rendered and read'
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('file', type=Path)
    parser.add_argument('--original', type=Path, help='the file the output was made from')
    parser.add_argument('--pages', type=int, default=MAX_PAGES, help='render at most this many pages')
    args = parser.parse_args()
    try:
        for path in (args.file, args.original):
            if path is not None and not path.is_file():
                raise InputError(f'File not found: {path}')
        result = check(args.file, args.original, args.pages)
    except (InputError, ValueError, subprocess.SubprocessError) as error:
        print(json.dumps({'error': str(error)}))
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 2 if result['status'] == 'defects_found' else 0


if __name__ == '__main__':
    sys.exit(main())
