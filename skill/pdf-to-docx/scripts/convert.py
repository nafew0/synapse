#!/usr/bin/env python3
"""Convert a PDF into a Word document, in the fidelity mode the user actually asked for.

    python convert.py INPUT.pdf OUTPUT.docx --mode layout-editable

Modes:
    layout-editable   (default) LibreOffice's Writer PDF import: editable text in positioned
                      boxes, images anchored where the PDF put them, page size preserved. Page
                      backgrounds and any image the import drops are restored afterwards.
    semantic-editable Reflowable Word paragraphs, headings, lists and tables in reading order,
                      with logos, seals, signatures and QR codes kept as pictures. Coordinates are
                      not preserved and the text repaginates. For a document to be edited.
    visual-fidelity   Each page as a full-page picture. A picture of the document, not a document:
                      the text cannot be edited, searched or copied. Only when the user asked for
                      exactly that.

`soffice --convert-to docx` on a PDF fails with "no export filter" — LibreOffice imports a PDF
into Draw, and Draw cannot write Word. The `writer_pdf_import` filter below routes the import
through Writer instead, which is the whole reason this script exists: never assemble the command
by hand.

Prints a one-line JSON summary and exits 0. On failure it exits 1 with an `error` key and no
output file — it never quietly downgrades to a mode the caller did not ask for.
"""
import argparse
import json
import shutil
import sys
import tempfile
from pathlib import Path

import probe
import restore
import semantic
from office.soffice import run_soffice

LAYOUT_EDITABLE = 'layout-editable'
SEMANTIC_EDITABLE = 'semantic-editable'
VISUAL_FIDELITY = 'visual-fidelity'
MODES = (LAYOUT_EDITABLE, SEMANTIC_EDITABLE, VISUAL_FIDELITY)

WRITER_PDF_IMPORT = 'writer_pdf_import'
DOCX_FILTER = 'docx:MS Word 2007 XML'
SOFFICE_TIMEOUT_SECONDS = 600
PAGE_IMAGE_DPI = 150


class ConversionError(Exception):
    pass


def convert(pdf_path, docx_path, mode=LAYOUT_EDITABLE, repair=True):
    pdf_path, docx_path = Path(pdf_path), Path(docx_path)
    if mode not in MODES:
        raise ConversionError(f'unknown mode {mode!r}; choose one of {", ".join(MODES)}')
    if not pdf_path.is_file():
        raise ConversionError(f'File not found: {pdf_path}')
    if pdf_path.suffix.lower() != '.pdf':
        raise ConversionError(f'{pdf_path}: the input must be a .pdf')
    if docx_path.suffix.lower() != '.docx':
        raise ConversionError(f'{docx_path}: the output must be a .docx')
    docx_path.parent.mkdir(parents=True, exist_ok=True)

    builder = {
        LAYOUT_EDITABLE: _layout_editable,
        SEMANTIC_EDITABLE: _semantic_editable,
        VISUAL_FIDELITY: _visual_fidelity,
    }[mode]
    summary = builder(pdf_path, docx_path, repair)
    return {'status': 'converted', 'mode': mode, 'output': str(docx_path), **summary}


def _layout_editable(pdf_path, docx_path, repair):
    with tempfile.TemporaryDirectory(prefix='pdf2docx_') as workspace:
        produced = _run_writer_import(pdf_path, Path(workspace))
        shutil.move(str(produced), str(docx_path))

    summary = {
        'backgrounds_sent_to_back': 0,
        'backgrounds_added': 0,
        'images_restored': 0,
        'warnings': [],
    }
    if repair:
        summary = restore.restore(pdf_path, docx_path)
    return {**_measure(pdf_path, docx_path), **summary}


def _run_writer_import(pdf_path, workspace):
    result = run_soffice(
        [
            '--headless',
            f'--infilter={WRITER_PDF_IMPORT}',
            '--convert-to',
            DOCX_FILTER,
            '--outdir',
            str(workspace),
            str(pdf_path),
        ],
        capture_output=True,
        text=True,
        timeout=SOFFICE_TIMEOUT_SECONDS,
    )
    produced = workspace / f'{pdf_path.stem}.docx'
    if result.returncode != 0 or not produced.is_file():
        detail = (result.stderr or result.stdout or '').strip().splitlines()
        raise ConversionError(
            f'LibreOffice did not produce a .docx (exit {result.returncode})'
            + (f': {detail[-1]}' if detail else '')
        )
    return produced


def _semantic_editable(pdf_path, docx_path, repair):
    """Reflowable paragraphs, headings, lists and tables, with the pictures kept.

    The point of this mode is that the result edits like a Word document: typing into a paragraph
    reflows it. `layout-editable` cannot do that, because every line there is its own positioned
    box.
    """
    summary = semantic.build(pdf_path, docx_path)
    return {**_measure(pdf_path, docx_path), **summary}


def _visual_fidelity(pdf_path, docx_path, repair):
    from docx import Document
    from docx.enum.text import WD_BREAK
    from docx.shared import Pt
    from pdf2image import convert_from_path

    width_pt, height_pt = probe.pdf_page_size(pdf_path)
    document = Document()
    section = document.sections[0]
    section.page_width, section.page_height = Pt(width_pt), Pt(height_pt)
    section.left_margin = section.right_margin = Pt(0)
    section.top_margin = section.bottom_margin = Pt(0)

    with tempfile.TemporaryDirectory(prefix='pdf2docx_pages_') as workspace:
        for number, page in enumerate(convert_from_path(str(pdf_path), dpi=PAGE_IMAGE_DPI), start=1):
            image_path = Path(workspace) / f'page{number}.png'
            page.save(image_path)
            paragraph = document.add_paragraph()
            paragraph.paragraph_format.space_before = Pt(0)
            paragraph.paragraph_format.space_after = Pt(0)
            run = paragraph.add_run()
            if number > 1:
                run.add_break(WD_BREAK.PAGE)
            run.add_picture(str(image_path), width=Pt(width_pt), height=Pt(height_pt))
    document.save(str(docx_path))
    return _measure(pdf_path, docx_path)


def _measure(pdf_path, docx_path):
    source = probe.normalize(probe.pdf_text(pdf_path))
    delivered = probe.normalize(probe.docx_text(docx_path))
    return {
        'pages': probe.docx_pages(docx_path),
        'source_pages': probe.pdf_pages(pdf_path),
        'characters': len(delivered),
        'source_characters': len(source),
        'images': len(probe.docx_media(docx_path)),
        'source_images': len(probe.pdf_media(pdf_path)),
    }


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument('pdf', type=Path, help='the PDF to convert')
    parser.add_argument('docx', type=Path, help='the .docx to write')
    parser.add_argument('--mode', choices=MODES, default=LAYOUT_EDITABLE, help='fidelity mode')
    parser.add_argument(
        '--no-restore',
        dest='restore',
        action='store_false',
        help='skip the page-background and dropped-image repair (layout-editable only)',
    )
    args = parser.parse_args()

    try:
        result = convert(args.pdf, args.docx, args.mode, args.restore)
    except (ConversionError, probe.InputError) as error:
        print(json.dumps({'status': 'failed', 'mode': args.mode, 'error': str(error)}))
        return 1
    except Exception as error:  # noqa: BLE001 - the JSON contract holds for every failure
        print(json.dumps({'status': 'failed', 'mode': args.mode, 'error': f'{type(error).__name__}: {error}'}))
        return 1

    print(json.dumps(result))
    return 0


if __name__ == '__main__':
    sys.exit(main())
