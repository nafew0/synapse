#!/usr/bin/env python3
"""Check that the Bangla in a DOCX, XLSX or PPTX survived, reads correctly and has a font.

Run it on every deliverable whose input or edits contain Bangla, after the format's own gates,
and deliver only on success:

1. lost: every paragraph, cell or text box of the original that contains Bangla is still in the
   output, unless it is one you were asked to change (`--allow`, a piece of its text).
2. garbled: no Bangla the output adds or changes is broken: no word starting with a vowel sign,
   no two vowel signs in a row, no dotted circles, private-use glyphs, `(cid:N)` or mojibake.
   No run is still in a Bijoy font (SutonnyMJ…), even one the original had: Bijoy text is Latin
   codes that read as Bangla only in that font, so it is always converted before delivery.
3. font: every Bangla run the output adds or changes names a font that draws Bangla, in the
   complex-script slot Word and PowerPoint actually use for it. In a DOCX it has a complex-script
   size whenever it has a Latin one, and a DOCX that sets Bangla in Nikosh embeds Nikosh.
4. text: no text box of the original became a picture.
5. render: the file is printed with LibreOffice and its pages read back with OCR; every page's
   Bangla must read back as the text LibreOffice laid out (see render.py). Needs LibreOffice,
   Poppler and Tesseract with its Bengali model; without them the step is skipped and noted.

Paragraphs of the original typed in a Bijoy font are compared as the Unicode they stand for.
Text in another font that only looks like Bijoy is a note: without the font it is a guess.

A fault the user's file already had does not block the edit; it is listed under `notes`. Garbled
text counts as already there when the original had the same text in the same part, even if its
formatting changed; a font fault when the original had the same text in the same font and size.

Usage:
    python verify_bangla.py OUTPUT [--original INPUT] [--allow 'text of an edited paragraph']
                                   [--no-render] [--pages 10]

Prints JSON and exits 0 when clean, 2 when defects are found, 1 on bad input.
"""
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from office.bangla import DEFAULT_FONT, can_draw, classify, has_bangla, normalize, to_unicode
from office.render import MAX_PAGES, InputError
from office.render import check as render_check
from office.runs import open_document

SPACE = re.compile(r'\s+')
QUOTE = 80


def flat(text):
    return SPACE.sub(' ', normalize(text)).strip()


def short(text):
    text = SPACE.sub(' ', text).strip()
    return text if len(text) <= QUOTE else text[:QUOTE] + '…'


def lost(original, output, allowed):
    """Bangla paragraphs of the original that the output no longer contains."""
    haystack = ' '.join(flat(text) for _, text in output.paragraphs())
    findings = []
    for where, text in original.paragraphs():
        if not has_bangla(text) or any(piece in text for piece in allowed):
            continue
        if flat(text) not in haystack:
            findings.append({'check': 'lost', 'where': where, 'detail': f'missing from the output: {short(text)!r}'})
    return findings


def where_of(kind, run):
    return run.part if kind != 'xlsx' else f'{run.part}!{run.element.coordinate}'


def bijoy_findings(kind, run):
    """A finding for a run still in a Bijoy font, a note for text that only looks like Bijoy."""
    if run.bijoy_font:
        detail = (
            f'{short(run.text)!r} is Bijoy text in {run.bijoy_font} ({short(to_unicode(run.text))!r}); '
            'run fix_bangla.py to convert it to Unicode'
        )
        return [{'check': 'garbled', 'where': where_of(kind, run), 'detail': detail}], []
    if not run.bangla and classify(run.text) == 'bijoy':
        detail = f'{short(run.text)!r} in {run.font or "no font"} looks like Bijoy text; check it with the user'
        return [], [{'check': 'garbled', 'where': where_of(kind, run), 'detail': detail}]
    return [], []


def run_findings(kind, run):
    """What is wrong with one Bangla run of the output, as findings."""
    found = []
    where = where_of(kind, run)
    shape = classify(run.text)
    if shape in ('broken', 'mixed'):
        found.append({'check': 'garbled', 'where': where, 'detail': f'Bangla is {shape}: {short(run.text)!r}'})
    if not run.font:
        detail = f'no Bangla font is set for {short(run.text)!r}; run fix_bangla.py'
        found.append({'check': 'font', 'where': where, 'detail': detail})
    elif not can_draw(run.font):
        found.append({
            'check': 'font',
            'where': where,
            'detail': f'{run.font!r} cannot draw Bangla ({short(run.text)!r}); use {DEFAULT_FONT}',
        })
    if kind == 'docx' and run.size_cs_behind:
        found.append({
            'check': 'font',
            'where': where,
            'detail': (
                f'the size is set to {run.size:g}pt but its w:szCs is not, so Word draws the Bangla at '
                f'{run.size_cs:g}pt: {short(run.text)!r}; run fix_bangla.py'
            ),
        })
    return found


def verify(output_path, original_path=None, allowed=(), render=False, max_pages=MAX_PAGES):
    kind, output = open_document(output_path)
    original = open_document(original_path)[1] if original_path else None
    texts, formatted = set(), set()
    for run in original.runs() if original is not None else ():
        if run.bangla:
            texts.add((run.part, run.text))
            formatted.add((run.part, run.text, run.font, run.size_cs))

    findings = lost(original, output, allowed) if original is not None else []
    notes = []
    uses_default = False
    for run in output.runs():
        bijoy, looks_bijoy = bijoy_findings(kind, run)
        findings.extend(bijoy)
        notes.extend(looks_bijoy)
        if not run.bangla:
            continue
        uses_default = uses_default or run.font == DEFAULT_FONT
        inherited = {
            'garbled': (run.part, run.text) in texts,
            'font': (run.part, run.text, run.font, run.size_cs) in formatted,
        }
        for finding in run_findings(kind, run):
            (notes if inherited[finding['check']] else findings).append(finding)

    if kind == 'docx' and uses_default and DEFAULT_FONT not in output.embedded_fonts():
        findings.append({
            'check': 'font',
            'where': 'word/fontTable.xml',
            'detail': f'Bangla is set in {DEFAULT_FONT} but the font is not embedded; run fix_bangla.py',
        })
    if original is not None and output.text_boxes() < original.text_boxes() and output.pictures() > original.pictures():
        findings.append({
            'check': 'text',
            'where': 'document',
            'detail': (
                f'{original.text_boxes() - output.text_boxes()} text box(es) are gone and '
                f'{output.pictures() - original.pictures()} picture(s) appeared: keep text as text'
            ),
        })
    result = {'status': 'defects_found' if findings else 'clean', 'findings': findings, 'notes': notes}
    if render:
        try:
            rendered = render_check(output_path, original_path, max_pages)
        except (InputError, subprocess.SubprocessError) as error:
            failure = {'check': 'render', 'where': 'document', 'detail': str(error)}
            rendered = {'status': 'defects_found', 'findings': [failure]}
        result['render'] = {key: value for key, value in rendered.items() if key not in ('findings', 'notes')}
        findings.extend(rendered['findings'])
        notes.extend(rendered.get('notes', []))
        if rendered['status'] == 'skipped':
            detail = f'render check skipped: {rendered["reason"]}'
            notes.append({'check': 'render', 'where': 'document', 'detail': detail})
        if rendered.get('note'):
            notes.append({'check': 'render', 'where': 'document', 'detail': rendered['note']})
        result['status'] = 'defects_found' if findings else 'clean'
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('output', type=Path)
    parser.add_argument('--original', type=Path, help='the file the output was made from')
    parser.add_argument('--allow', action='append', default=[], help='text of a paragraph you were asked to change')
    parser.add_argument('--no-render', action='store_true', help='skip the LibreOffice + OCR render check')
    parser.add_argument('--pages', type=int, default=MAX_PAGES, help='render and read at most this many pages')
    args = parser.parse_args()
    try:
        for path in (args.output, args.original):
            if path is not None and not path.is_file():
                raise ValueError(f'File not found: {path}')
        result = verify(args.output, args.original, args.allow, not args.no_render, args.pages)
    except (ValueError, KeyError) as error:
        print(json.dumps({'error': str(error)}))
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result['status'] == 'clean' else 2


if __name__ == '__main__':
    sys.exit(main())
