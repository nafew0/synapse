#!/usr/bin/env python3
"""Find the layout defects a reader sees first: text that outgrows its box, text boxes that
sit on top of each other, and anything hanging off the slide.

Rendering and looking at slides catches these too, but only when the renderer works and the
model looks carefully; this is the same check made deterministic, and it runs in a second.
It measures with the real font metrics when fontconfig can resolve the typeface, so a title
that fits in Calibri is not reported because the previewer substituted something wider. Bangla
is measured in the run's complex-script font (`a:cs`), the one PowerPoint draws it with, and
shaped with HarfBuzz so a conjunct counts as the one glyph it is.

Usage:
    python check_layout.py deck.pptx [--slides 2,5] [--json]

Prints one line per finding and exits 0 when clean, 2 when defects are found, 1 on bad input.
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

from pptx import Presentation
from pptx.oxml.ns import qn
from pptx.util import Emu

sys.path.insert(0, str(Path(__file__).resolve().parent))

from office.bangla import can_draw, has_bangla, measure  # noqa: E402

EMU_PER_INCH = 914400
EMU_PER_POINT = 12700
DEFAULT_INSET = Emu(91440)
LINE_SPACING = 1.2
"""How far text may outgrow its box before it is worth reporting. Authors routinely declare a
box shorter than its glyphs and the slide still reads correctly, because empty space sits below.
Overflow is only a defect when it is large, or when the overflowing text reaches another text
box — so a modest overshoot into whitespace stays quiet while a quote running into the caption
beneath it is reported."""
OVERFLOW_TOLERANCE = 0.5
COLLIDING_OVERFLOW_TOLERANCE = 0.25
"""Fraction of the smaller shape's area that two text boxes may share. Boxes are routinely
padded past their glyphs and cards abut by design, so only a substantial covering is a defect."""
OVERLAP_TOLERANCE = 0.15
"""How far a shape may reach past the slide before it is reported. Template furniture — slide
numbers, footer rules — is routinely parked a fraction outside the canvas on purpose, while a
genuinely misplaced shape misses by much more than this."""
EDGE_TOLERANCE = Emu(274320)
"""Slides are 16:9. A 4:3 deck projects with black bars down both sides, and the ratio is the
one property a viewer notices before reading a word. The tolerance absorbs the rounding in
13.333" — nothing wider."""
TARGET_ASPECT = 16 / 9
ASPECT_TOLERANCE = 0.02
FALLBACK_BANGLA_FONT = 'Nirmala UI'
"""What a run with no usable complex-script font is measured in: the Windows Bangla font, whose
stand-in here is Noto Sans Bengali."""

_font_cache: dict[tuple[str, bool, bool], object] = {}
_unmeasured: set[str] = set()


def _report_unmeasured(name):
    """Warn once per typeface that could not be measured, so a clean run is never mistaken
    for a verified one when fontconfig is missing the font."""
    if name in _unmeasured:
        return
    _unmeasured.add(name)
    print(f'warning: no font file for {name!r}; overflow results are approximate', file=sys.stderr)


class InputError(Exception):
    pass


def resolve_font(name, bold, italic):
    """A PIL font for `name`, via fontconfig so the metrics match what LibreOffice renders."""
    from PIL import ImageFont

    key = (name or 'Calibri', bool(bold), bool(italic))
    if key in _font_cache:
        return _font_cache[key]
    # fontconfig style tokens, not `bold=true`: the boolean form matches nothing and
       # fc-match then prints an empty line, which silently degrades every measurement to
    # PIL's bitmap default and under-reports overflow by an order of magnitude.
    style = ' '.join(part for part, on in (('Bold', bold), ('Italic', italic)) if on)
    query = f'{key[0]}:style={style}' if style else key[0]
    path = None
    try:
        found = subprocess.run(
            ['fc-match', '-f', '%{file}', query], capture_output=True, text=True, timeout=10
        )
        path = found.stdout.strip() or None
    except (OSError, subprocess.SubprocessError):
        path = None
    font = None
    if path:
        try:
            font = ImageFont.truetype(path, 100)
        except OSError:
            font = None
    if font is None:
        _report_unmeasured(key[0])
        font = ImageFont.load_default()
    _font_cache[key] = font
    return font


def text_width_emu(text, font, size_pt):
    """Width of `text` at `size_pt`, measured at 100pt and scaled."""
    if not text:
        return 0
    try:
        width = font.getlength(text)
    except AttributeError:
        width = font.getsize(text)[0]
    return int(width / 100 * size_pt * EMU_PER_POINT)


def bangla_font(run):
    """The typeface PowerPoint draws the run's Bangla with, or the fallback."""
    rpr = run._r.find(qn('a:rPr'))
    cs = rpr.find(qn('a:cs')) if rpr is not None else None
    typeface = cs.get('typeface', '') if cs is not None else ''
    if typeface and not typeface.startswith('+') and can_draw(typeface):
        return typeface
    return FALLBACK_BANGLA_FONT


def word_width_emu(word, run, font, size):
    """Width of one word: shaped in the Bangla font when it has Bangla, else as before."""
    if has_bangla(word):
        points = measure(word, bangla_font(run), size, run.font.bold, run.font.italic)
        if points is not None:
            return int(points * EMU_PER_POINT)
        font = resolve_font(bangla_font(run), run.font.bold, run.font.italic)
    return text_width_emu(word, font, size)


def run_size(run, paragraph, shape):
    """Point size for a run, following python-pptx's inheritance chain to a sane default."""
    for source in (run.font.size, paragraph.font.size):
        if source is not None:
            return source.pt
    try:
        placeholder = shape.text_frame.paragraphs[0].runs[0].font.size
        if placeholder is not None:
            return placeholder.pt
    except (IndexError, AttributeError):
        pass
    return 18.0


def paragraph_lines(paragraph, shape, width_emu):
    """How many rendered lines a paragraph needs inside `width_emu`."""
    if width_emu <= 0:
        return 1
    lines = 0
    height = 0.0
    current = 0
    max_size = 0.0
    for run in paragraph.runs:
        size = run_size(run, paragraph, shape)
        max_size = max(max_size, size)
        font = resolve_font(run.font.name, run.font.bold, run.font.italic)
        for word in run.text.split(' '):
            word_width = word_width_emu(word + ' ', run, font, size)
            if current and current + word_width > width_emu:
                lines += 1
                height += size * LINE_SPACING
                current = word_width
            else:
                current += word_width
    if current or not lines:
        lines += 1
        height += (max_size or 18.0) * LINE_SPACING
    return max(lines, 1), height


def shape_rect(shape):
    try:
        if None in (shape.left, shape.top, shape.width, shape.height):
            return None
    except (AttributeError, ValueError):
        return None
    return (shape.left, shape.top, shape.left + shape.width, shape.top + shape.height)


def overflow_finding(shape, name):
    """A finding when the shape's text needs more height than the shape has."""
    frame = shape.text_frame
    if not frame.text.strip():
        return None
    left_inset = frame.margin_left if frame.margin_left is not None else DEFAULT_INSET
    right_inset = frame.margin_right if frame.margin_right is not None else DEFAULT_INSET
    top_inset = frame.margin_top if frame.margin_top is not None else DEFAULT_INSET
    bottom_inset = frame.margin_bottom if frame.margin_bottom is not None else DEFAULT_INSET
    width = shape.width - left_inset - right_inset
    height = shape.height - top_inset - bottom_inset
    if width <= 0 or height <= 0:
        return None

    needed_pt = 0.0
    for paragraph in frame.paragraphs:
        _, paragraph_height = paragraph_lines(paragraph, shape, width)
        needed_pt += paragraph_height
    needed = int(needed_pt * EMU_PER_POINT)
    if needed <= height:
        return None
    return {
        'shape': name,
        'needed': needed,
        'ratio': needed / height - 1,
        'detail': (
            f'text needs ~{needed / EMU_PER_INCH:.2f}" but the box is '
            f'{height / EMU_PER_INCH:.2f}" tall: {frame.text.strip()[:60]!r}'
        ),
    }


def overlap_area(a, b):
    width = min(a[2], b[2]) - max(a[0], b[0])
    height = min(a[3], b[3]) - max(a[1], b[1])
    return width * height if width > 0 and height > 0 else 0


def check_slide(index, slide, width, height):
    """Findings for one slide: text that outgrows its box, text a later shape covers, and
    anything reaching past the slide edge."""
    findings = []
    shapes = []
    for position, shape in enumerate(slide.shapes):
        rect = shape_rect(shape)
        if rect is None:
            continue
        has_text = bool(shape.has_text_frame and shape.text_frame.text.strip())
        shapes.append({
            'name': shape.name or f'shape {position}',
            'rect': rect,
            'text': shape.text_frame.text.strip() if has_text else '',
        })

        if (
            rect[0] < -EDGE_TOLERANCE
            or rect[1] < -EDGE_TOLERANCE
            or rect[2] > width + EDGE_TOLERANCE
            or rect[3] > height + EDGE_TOLERANCE
        ):
            findings.append({
                'kind': 'off_slide',
                'shape': shapes[-1]['name'],
                'detail': (
                    f'extends to {rect[2] / EMU_PER_INCH:.2f}" x {rect[3] / EMU_PER_INCH:.2f}" '
                    f'on a {width / EMU_PER_INCH:.2f}" x {height / EMU_PER_INCH:.2f}" slide'
                ),
            })

        if has_text:
            overflow = overflow_finding(shape, shapes[-1]['name'])
            if overflow:
                shapes[-1]['overflow'] = overflow

    # Shapes are drawn in document order, so only a shape that comes *after* a text box can
    # cover it. Text placed on a card arrives in that same order — card first, text after —
    # so that correct, common case is ignored by construction.
    for position, entry in enumerate(shapes):
        overflow = entry.get('overflow')
        if overflow:
            grown = (entry['rect'][0], entry['rect'][1], entry['rect'][2], entry['rect'][1] + overflow['needed'])
            collides = any(
                other is not entry
                and other['text']
                and overlap_area(grown, other['rect']) > 0
                and overlap_area(entry['rect'], other['rect']) == 0
                for other in shapes
            )
            if overflow['ratio'] > OVERFLOW_TOLERANCE or (
                collides and overflow['ratio'] > COLLIDING_OVERFLOW_TOLERANCE
            ):
                detail = overflow['detail'] + (' and runs into the text below' if collides else '')
                findings.append({'kind': 'overflow', 'shape': overflow['shape'], 'detail': detail})

        if not entry['text']:
            continue
        area = (entry['rect'][2] - entry['rect'][0]) * (entry['rect'][3] - entry['rect'][1])
        if area <= 0:
            continue
        for above in shapes[position + 1:]:
            shared = overlap_area(entry['rect'], above['rect'])
            if shared <= 0 or shared / area <= OVERLAP_TOLERANCE:
                continue
            covering = above['name'] + (f": {above['text'][:30]!r}" if above['text'] else '')
            findings.append({
                'kind': 'covered',
                'shape': f"{entry['name']} under {above['name']}",
                'detail': f"{shared / area:.0%} of {entry['text'][:30]!r} is covered by {covering}",
            })
            break

    return [dict(finding, slide=index) for finding in findings]


def aspect_findings(width, height, original):
    """The deck's own shape, and whether it still matches the deck it was built from."""
    findings = []
    if height and abs(width / height - TARGET_ASPECT) > ASPECT_TOLERANCE:
        findings.append({
            'kind': 'aspect',
            'slide': 0,
            'shape': 'presentation',
            'detail': (
                f'slides are {width / EMU_PER_INCH:.2f}" x {height / EMU_PER_INCH:.2f}" '
                f'({width / height:.2f}:1), not 16:9 — use 13.333" x 7.5"'
            ),
        })
    if original is None:
        return findings
    source = Presentation(original)
    if (source.slide_width, source.slide_height) != (width, height):
        findings.append({
            'kind': 'aspect',
            'slide': 0,
            'shape': 'presentation',
            'detail': (
                f'canvas changed from {source.slide_width / EMU_PER_INCH:.2f}" x '
                f'{source.slide_height / EMU_PER_INCH:.2f}" to {width / EMU_PER_INCH:.2f}" x '
                f'{height / EMU_PER_INCH:.2f}" — every carried-over position shifts'
            ),
        })
    return findings


def check(path, slides=None, original=None):
    presentation = Presentation(path)
    width = presentation.slide_width
    height = presentation.slide_height
    findings = aspect_findings(width, height, original)
    for index, slide in enumerate(presentation.slides, start=1):
        if slides and index not in slides:
            continue
        findings.extend(check_slide(index, slide, width, height))
    return {
        'status': 'defects_found' if findings else 'clean',
        'slides_checked': len(slides) if slides else len(presentation.slides._sldIdLst),
        'findings': findings,
    }


def parse_slides(value):
    if not value:
        return None
    try:
        return {int(part) for part in value.split(',') if part.strip()}
    except ValueError as error:
        raise InputError(f'--slides takes numbers like 2,5: {value}') from error


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('deck', type=Path)
    parser.add_argument('--slides', help='only these slide numbers, e.g. 2,5')
    parser.add_argument(
        '--original', type=Path, help='the deck this one was built from; checks the canvas still matches'
    )
    parser.add_argument('--json', action='store_true', help='machine-readable output')
    args = parser.parse_args()

    try:
        if not args.deck.is_file():
            raise InputError(f'File not found: {args.deck}')
        if args.original is not None and not args.original.is_file():
            raise InputError(f'File not found: {args.original}')
        result = check(args.deck, parse_slides(args.slides), args.original)
    except InputError as error:
        print(json.dumps({'error': str(error)}) if args.json else f'error: {error}')
        return 1

    if args.json:
        print(json.dumps(result, indent=2))
    elif result['status'] == 'clean':
        print(f"clean: no layout defects in {result['slides_checked']} slide(s)")
    else:
        for finding in result['findings']:
            where = 'deck' if finding['slide'] == 0 else f"slide {finding['slide']}"
            print(f"{where} | {finding['kind']} | {finding['shape']} | {finding['detail']}")
        print(f"{len(result['findings'])} defect(s)")
    return 0 if result['status'] == 'clean' else 2


if __name__ == '__main__':
    sys.exit(main())
