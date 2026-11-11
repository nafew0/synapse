"""Turn a scanned page or PDF into Word in one call, from read_document's elements.

    python3 scan_to_docx.py <name.elements.json> <source pdf or image> <out.docx>

Renders the source, builds the spec with the page's own margins and table columns, crops the
pictures at their size on the page, then runs letter.py. The last lines are the report. Read
qa/<out>-compare.jpg afterwards. To change anything, edit qa/spec.json and rerun letter.py.
"""

import json
import re
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ElementTree
from difflib import SequenceMatcher
from math import log, sqrt
from statistics import median
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageOps

sys.path.insert(0, str(Path(__file__).resolve().parent))
from elements_spec import PAGE_NUMBER, SHARED_BOX_SHARE, TEXT_TYPES, convert, looks_handwritten, reflowed, with_line_role  # noqa: E402
from straighten import page_tilt, turn_about_center, word_direction  # noqa: E402

RENDER_DPI = 150
PAGE_WIDTH_CM = 21.0
PAGE_HEIGHT_CM = 29.7
MIN_ROTATION_TEXT = 8
DARK = 170
RULE_MIN_SHARE = 0.95
RULE_ROW_STEP = 2
RULE_SEARCH = 16
RULE_SPREAD = 3
MAX_SKEW_DEGREES = 3
SKEW_STEP_DEGREES = 0.25
SKEW_SAMPLE_WIDTH = 500
MIN_COLUMN_CM = 0.4
MIN_RULE_SPAN = 0.85
FAINT_RULE_REACH_CM = 0.4
FAINT_RULE_MIN_INK = 8
BLOB_REACH = 3
LOGO_MAX_ASPECT = 3
INK_GAP_ROWS = 12
MAX_SIGNATURE_GROWTH = 200
HEADING_MATCH = 0.6
SHARED_MIN_LINES = 3
PROSE_LINE_CHARS = 60
SEGMENT_GAP = 2.5
TALL_PIECE_LINES = 1.8
BLOCK_GAP = 0.8
MAX_WRAP = 4
SKIP_COST = 0.8
MISS_COST = 1.5
WRAP_COST = 0.2
MIN_MATCHED_LINES = 0.7
MAX_SKIPPED_PIECES = 0.3
HANDWRITING_PIECES = 2
MAX_WIDTH_ERROR = 0.35
MAX_LINE_ERROR = 1.0
ENLARGE = 3
# Grey levels for clear_paper: at or below OPAQUE_INK a pixel is solid, at or above CLEAR_PAPER it
# is fully see-through, and in between it fades.
OPAQUE_INK = 135
CLEAR_PAPER = 190
# Marks on paper are redrawn larger than photos, and their edges smoothed by this blur in pixels.
MARK_ENLARGE = 4
EDGE_SMOOTHING = 1.2
# A picture at least this much paper is a stamp or seal, not a photo.
PAPER_PICTURE_SHARE = 0.6
# How light a pixel must be to count as paper when telling a stamp from a photo.
PAPER_LIGHT = 235
# A box the structure call drew is rough: look this share of its size beyond it, keep shapes at
# least SNAP_INSIDE inside it.
SNAP_GROW = 0.15
SNAP_PAD = 8
SNAP_INSIDE = 0.5
SNAP_MIN_AREA = 4
MASK_PAD = 1
MAX_PICTURE_EDGE = 1800
# A handwritten line's width says nothing about its letters, so it takes pieces at a flat cost:
# less than missing it, more than a printed line that fits its piece.
HAND_TAKE_COST = 0.9
# A printed line runs on to the next row only when it fills its row: it ends within this share of
# its block's width from the block's right edge.
WRAP_FULL_SHARE = 0.1
TYPICAL_CHAR_SHARE = 0.4
MAX_CHAR_SCALE = 1.8
TYPE_DARK = 160
TYPE_ROW_INK = 0.004
TYPE_BAND_GAP = 0.2
TYPE_ROW_SHARE = 0.15
TYPE_ROW_QUANTILE = 0.75
TYPE_RULE_ROWS = 0.15
TYPE_RULE_INK = 0.3
TYPE_RULE_SHARE = 0.9
TYPE_MIN_BAND = 0.35
TYPE_SIZE_CHANGE = 0.2
TYPE_SHRINK_CHANGE = 0.3
MIN_BOLD_HEIGHT_PX = 16
TYPE_BOLD_RATIO = 1.25
TYPE_BLUR_PX = 1.0
TYPE_BODY_CHARS = 40
MIN_TYPE_SIZE = 7.0
MAX_TYPE_SIZE = 24.0
MIN_UPSIDE_DOWN_LINES = 3
MIN_TILT = 0.5
UPSIDE_DOWN_TREND = 0.5
MIN_BALANCED_COLUMNS = 3
WORD_CHARACTER_CM = 0.15
WORD_CHARACTER_SIZE = 10.5
LONG_TABLE_SIZE = 8.5
CELL_PADDING_CM = 0.25
SERIAL = re.compile(r"^\(?([0-9০-৯]{1,3})[.)।]?$")
SERIAL_OUTSIDE = re.compile(r"^\(?[0-9০-৯]{1,3}[.)।]$")
BANGLA_DIGITS = str.maketrans("0123456789", "০১২৩৪৫৬৭৮৯")
SERIAL_LOOKALIKES = str.maketrans("LlIi|Oo", "1111100")
SERIAL_MARKS = "'\"`‘’"
LEADING_SERIAL = re.compile(r"^\(?[0-9০-৯]{1,3}[.)।](?=\s|$)")
LATIN_DIGITS = str.maketrans("০১২৩৪৫৬৭৮৯", "0123456789")


def repair_pdf(source, qa):
    """A copy with its page index rebuilt by qpdf, or None. A PDF that lost its index or its last
    bytes cannot be opened by pdftoppm, though most of its pages are intact."""
    if not shutil.which("qpdf"):
        return None
    out = qa / "repaired.pdf"
    # qpdf exits 3 when it repaired the file with warnings.
    result = subprocess.run(["qpdf", str(source), str(out)], capture_output=True)
    return out if result.returncode in (0, 3) and out.exists() else None


def render_pages(source, qa):
    """One image per page, in order. An image source is its own single page."""
    if Path(source).suffix.lower() != ".pdf":
        return [Path(source)]
    stem = qa / "page"
    command = ["pdftoppm", "-r", str(RENDER_DPI), "-png"]
    if subprocess.run([*command, str(source), str(stem)], capture_output=True).returncode != 0:
        repaired = repair_pdf(source, qa)
        if repaired is None:
            raise SystemExit(f"{source} is damaged and could not be repaired: pdftoppm cannot open it")
        subprocess.run([*command, str(repaired), str(stem)], check=True)
    return sorted(qa.glob("page-*.png"))


def column_sharpness(region):
    """How strongly ink gathers in single pixel columns: highest when the table's rules stand straight."""
    return sum(ink**2 for ink in darkness_profile(region))


def darkness_profile(region):
    """Mean ink per pixel column, 0 to 255."""
    return [255 - value for value in region.resize((region.width, 1), Image.Resampling.BOX).tobytes()]


def faint_rules(region, count, cm_per_pixel):
    """Rule positions for a scan whose lines are too faint or broken to have ink in every row: the
    `count` columns that stand out most sharply from the ink around them, at least a column apart."""
    profile = darkness_profile(region)
    reach = max(3, int(FAINT_RULE_REACH_CM / cm_per_pixel))
    gap = int(MIN_COLUMN_CM / cm_per_pixel)
    sharpness = []
    for x in range(len(profile)):
        around = profile[max(0, x - reach):x + reach + 1]
        sharpness.append(profile[x] - sum(around) / len(around))
    chosen = []
    for x in sorted(range(len(profile)), key=lambda column: -sharpness[column]):
        if sharpness[x] < FAINT_RULE_MIN_INK:
            break
        if all(abs(x - other) >= gap for other in chosen):
            chosen.append(x)
        if len(chosen) == count:
            break
    return sorted(chosen)


def skew_angle(region):
    """The small rotation, in degrees, that stands a tilted scan's ruled lines upright."""
    sample = region.resize((SKEW_SAMPLE_WIDTH, max(1, region.height * SKEW_SAMPLE_WIDTH // region.width)))
    steps = int(MAX_SKEW_DEGREES / SKEW_STEP_DEGREES)
    angles = [step * SKEW_STEP_DEGREES for step in range(-steps, steps + 1)]
    return max(
        angles,
        key=lambda angle: (column_sharpness(sample.rotate(angle, fillcolor=255, resample=Image.Resampling.BILINEAR)), -abs(angle)),
    )


def table_widths(image, box, columns, cm_per_pixel):
    """Column widths from the table's ruled lines on the scan, or None when they cannot be seen.

    A scan is often slightly skewed, so a rule spreads over a few columns of pixels: each column is
    counted together with its neighbours.
    """
    x0, y0, x1, y1 = box
    region = ImageOps.grayscale(image.crop((max(x0 - RULE_SEARCH, 0), y0, x1 + RULE_SEARCH, y1)))
    angle = skew_angle(region)
    if angle:
        region = region.rotate(angle, fillcolor=255, resample=Image.Resampling.BILINEAR)
    width, height = region.size
    pixels = region.load()
    # A rule has ink in almost every row of its narrow band; a column of text does not.
    rules = []
    columns_dark = [sum(pixels[x, y] < DARK for y in range(height)) for x in range(width)]
    for x in range(width):
        band = range(max(x - RULE_SPREAD, 0), min(x + RULE_SPREAD + 1, width))
        covered = sum(any(pixels[b, y] < DARK for b in band) for y in range(0, height, RULE_ROW_STEP))
        if covered / (height / RULE_ROW_STEP) < RULE_MIN_SHARE:
            continue
        strength = sum(columns_dark[b] for b in band)
        if rules and x - rules[-1][1] <= RULE_SPREAD * 2:
            if strength > rules[-1][0]:
                rules[-1] = (strength, x)
        else:
            rules.append((strength, x))
    positions = [x for _, x in rules]
    if len(positions) != columns + 1:
        positions = faint_rules(region, columns + 1, cm_per_pixel)
    # Rules picked from text strokes bunch together; a table's own rules reach both of its edges.
    if len(positions) != columns + 1 or positions[-1] - positions[0] < MIN_RULE_SPAN * (x1 - x0):
        return None
    widths = [round((b - a) * cm_per_pixel, 2) for a, b in zip(positions, positions[1:])]
    return widths if min(widths) >= MIN_COLUMN_CM else None


def page_scale(cm_per_pixel, page):
    """Centimetres per scan pixel on a page: one scale, or one per page number."""
    if not isinstance(cm_per_pixel, dict):
        return cm_per_pixel
    return cm_per_pixel.get(page) or next(iter(cm_per_pixel.values()))


def table_span_cm(spec, box, page_width_px, scale):
    """How wide the table sat on the scan, no wider than the page's text."""
    margins = spec.get("page", {}).get("margins_cm") or [0, 0, 0, 0]
    text_width = page_width_px * scale - margins[1] - margins[3]
    return min((box[2] - box[0]) * scale, text_width)


def fit_to_span(widths, span):
    """The widths scaled to add up to the table's own width. A box too small to hold its columns
    says nothing about the width, so the widths are left as measured."""
    if span < MIN_COLUMN_CM * len(widths):
        return widths
    total = sum(widths)
    return [round(width * span / total, 2) for width in widths]


def apply_table_widths(spec, pages, cm_per_pixel):
    """Widths from each table's rules, scaled to the width the table had on the page: the rules give
    the columns' proportions, the table's box its size. A table whose rules cannot be read takes the
    proportions found for another table with as many columns, as a long table scanned page by page
    repeats one layout, or else equal columns."""
    found, spans = {}, {}
    for block in spec["blocks"]:
        box = block.pop("box", None)
        page = block.pop("box_page", 1)
        if block["type"] != "table" or not box or page > len(pages):
            continue
        columns = column_count(block)
        scale = page_scale(cm_per_pixel, page)
        with Image.open(pages[page - 1]) as image:
            widths = table_widths(image.convert("RGB"), box, columns, scale)
            spans[id(block)] = table_span_cm(spec, box, image.width, scale)
        if widths:
            block["widths_cm"] = fit_to_span(widths, spans[id(block)])
            found.setdefault(columns, []).append(widths)
    shared = {columns: [median(column) for column in zip(*sets)] for columns, sets in found.items()}
    for block in spec["blocks"]:
        if block["type"] != "table" or block.get("widths_cm") or id(block) not in spans:
            continue
        columns = column_count(block)
        proportions = shared.get(columns) or [1.0] * columns
        widths = fit_to_span(proportions, spans[id(block)])
        if columns in shared or widths is not proportions:
            block["widths_cm"] = [round(width, 2) for width in widths]


def row_ink(gray):
    """Ink per pixel row. A row that is one unbroken stroke across most of the text's width is a rule
    or an underline, not text, and counts as empty: text rows have gaps between words."""
    width, height = gray.size
    pixels = gray.load()
    rows = [[pixels[x, y] < TYPE_DARK for x in range(width)] for y in range(height)]
    columns = [x for x in range(width) if any(row[x] for row in rows)]
    span = columns[-1] - columns[0] + 1 if columns else width
    counts = []
    for row in rows:
        run = longest = 0
        for dark in row:
            run = run + 1 if dark else 0
            longest = max(longest, run)
        counts.append(0 if longest >= TYPE_RULE_SHARE * span else sum(row))
    return counts


def runs_of(rows, start, least):
    """[first, last] row of each run of rows holding at least `least` ink, offset by `start`, with
    the small gap a Bangla vowel sign leaves above or under its letter joined over."""
    bands = []
    for offset, count in enumerate(rows):
        if count < least:
            continue
        y = start + offset
        if bands and y - bands[-1][1] <= 1:
            bands[-1][1] = y
        else:
            bands.append([y, y])
    darkest = max(rows, default=0)
    joined, previous = [], 0
    for band in bands:
        height = band[1] - band[0] + 1
        if joined:
            # Against the pieces themselves, not what has been joined so far, or lines snowball.
            tallest = max(previous, height)
            # A thin strip inked edge to edge under a line is its underline: a vowel sign under a
            # letter is thin too, but sparse.
            ink = sum(rows[band[0] - start:band[1] - start + 1]) / height
            if height <= TYPE_RULE_ROWS * tallest and ink >= TYPE_RULE_INK * darkest:
                continue
            if band[0] - joined[-1][1] - 1 <= TYPE_BAND_GAP * tallest:
                joined[-1][1] = band[1]
                previous = tallest
                continue
        joined.append(band)
        previous = height
    return joined


def split_touching(counts, first, last, least):
    """[first, last] cut where closely set lines touch: at the faintest row between two runs of
    well-inked rows. The threshold only finds the cuts, so each line keeps the vowel signs above
    its headline and the tails below it."""
    rows = counts[first:last + 1]
    inked = sorted(count for count in rows if count)
    cores = runs_of(rows, first, max(least, TYPE_ROW_SHARE * inked[int(len(inked) * TYPE_ROW_QUANTILE)]))
    if len(cores) <= 1:
        return [[first, last]]
    cuts = [min(range(a[1] + 1, b[0]), key=lambda y: counts[y]) for a, b in zip(cores, cores[1:]) if b[0] > a[1] + 1]
    edges = [first - 1, *cuts, last + 1]
    lines = []
    for start, stop in zip(edges, edges[1:]):
        inside = [y for y in range(start + 1, stop) if counts[y] >= least]
        if inside:
            lines.append([inside[0], inside[-1]])
    return lines


def ink_bands(gray):
    """The text lines in a region, split first at blank rows and then where closely set lines
    touch. Specks are dropped."""
    counts = row_ink(gray)
    least = max(1, int(gray.size[0] * TYPE_ROW_INK))
    lines = []
    for first, last in runs_of(counts, 0, least):
        lines.extend(split_touching(counts, first, last, least))
    if not lines:
        return []
    usual = median(b[1] - b[0] + 1 for b in lines)
    return [b for b in lines if b[1] - b[0] + 1 >= TYPE_MIN_BAND * usual]


def stroke_width(gray, band):
    """Median length of the short horizontal ink runs in a line: the thickness of its upright
    strokes. Long runs are the headline (matra) or a rule, not strokes."""
    width, _ = gray.size
    pixels = gray.load()
    longest = (band[1] - band[0] + 1) * 0.6
    runs = []
    for y in range(band[0], band[1] + 1):
        run = 0
        for x in range(width + 1):
            if x < width and pixels[x, y] < TYPE_DARK:
                run += 1
                continue
            if 0 < run <= longest:
                runs.append(run)
            run = 0
    return median(runs) if runs else 0


def measure_type(image, box, line=None):
    """How tall a block's lines of text are and how thick their strokes, both in scan pixels. `line` [index, count] picks one line of a box that holds several. None when the
    box holds no readable line."""
    x0, y0, x1, y1 = (int(value) for value in box)
    gray = ImageOps.grayscale(image.crop((max(x0, 0), max(y0, 0), x1, y1)))
    bands = ink_bands(gray)
    if line:
        # Handwriting or a stamp in the box adds bands; then no band is surely this line.
        if len(bands) != line[1]:
            return None
        bands = [bands[line[0]]]
    if not bands:
        return None
    height = median(b[1] - b[0] + 1 for b in bands)
    strokes = [stroke_width(gray, band) for band in bands]
    return {"height": height, "stroke": median(strokes)}


def type_targets(spec):
    """Every place a measured size and weight can go: (style, box holder, text length, is body)."""
    for block in spec["blocks"]:
        kind = block["type"]
        if kind in ("title", "heading", "paragraph") and "type_box" in block:
            yield block, block, len(block.get("text", "")), kind == "paragraph"
        elif kind == "letterhead":
            for line in block.get("lines", []):
                if "type_box" in line:
                    yield line, line, len(line.get("text", "")), False
        elif kind == "list" and "item_boxes" in block:
            styles = block.setdefault("item_styles", [{} for _ in block["item_boxes"]])
            for style, holder, (_, text) in zip(styles, block["item_boxes"], block["items"]):
                yield style, holder, len(text), True


def without_bold_source(spec):
    """Takes off every `bold_from` mark, returning the styles whose bold the structure call set."""
    seen = []
    for block in spec["blocks"]:
        holders = [block, *block.get("lines", []), *block.get("item_styles", [])]
        seen += [holder for holder in holders if isinstance(holder, dict) and holder.pop("bold_from", None)]
    return seen


def apply_type(spec, pages, cm_per_pixel=1.0):
    """Sets each text block's size and bold from its lines on the scan, compared with the page's
    body text: a block the service called a title is not made larger or bold unless it looks so.
    Blocks with no box, or a document with no body text to compare with, keep what they have."""
    from_vision = {id(style) for style in without_bold_source(spec)}
    measured = []
    for style, holder, length, body in list(type_targets(spec)):
        box, page, line = holder.pop("type_box", None), holder.pop("type_page", 1), holder.pop("type_line", None)
        if not box or page > len(pages):
            continue
        with Image.open(pages[page - 1]) as image:
            found = measure_type(image.convert("RGB"), box, line)
        if found:
            height = found["height"] * page_scale(cm_per_pixel, page)
            measured.append((style, height, found, body and length >= TYPE_BODY_CHARS))
    for block in spec["blocks"]:
        block.pop("item_boxes", None)
    body = [(height, found) for _, height, found, is_body in measured if is_body]
    if not body:
        return
    body_height = median(height for height, _ in body)
    # Stroke grows with type size; the scanner's blur adds about a pixel whatever the size.
    weight = median((found["stroke"] - TYPE_BLUR_PX) / found["height"] for _, found in body)
    base = float(spec.get("font", {}).get("size", 10.5))
    for style, height, found, _ in measured:
        ratio = height / body_height
        # Short lines vary in height with their letters, so a smaller size needs clearer evidence.
        if ratio - 1 >= TYPE_SIZE_CHANGE or 1 - ratio >= TYPE_SHRINK_CHANGE:
            style["size"] = min(max(round(base * ratio * 2) / 2, MIN_TYPE_SIZE), MAX_TYPE_SIZE)
        elif "size" in style or style.get("type") == "title":
            style["size"] = base
        if found["height"] < MIN_BOLD_HEIGHT_PX or id(style) in from_vision:
            # A stroke one or two pixels wide cannot tell bold from regular; and what the structure
            # call saw on the page beats a stroke measured on a small photo.
            continue
        regular = weight * found["height"] + TYPE_BLUR_PX
        style["bold"] = found["stroke"] >= TYPE_BOLD_RATIO * regular


def column_count(block):
    return sum(int(cell.get("colspan", 1)) for cell in block["rows"][0])


def row_text(row):
    return " ".join(cell.get("text", "") for cell in row)


def same_row(a, b):
    """Two reads of one heading row differ by a few misread letters."""
    return SequenceMatcher(None, row_text(a), row_text(b)).ratio() >= HEADING_MATCH


def heading_count(rows):
    count = 0
    while count < len(rows) - 1 and all(cell.get("header") for cell in rows[count]):
        count += 1
    return count


def join_continued_tables(spec):
    """A long table scanned page by page comes back as one table per page, each with its heading
    row. Each would start a new Word page and spill onto the next, leaving pages with a stray row.
    A table on a new page with the same columns as the table just before continues it: its repeated
    heading is dropped and the heading repeats on every Word page instead. A table that long is set in
    smaller type.

    Between two pages of one table a reader may leave other blocks: a page number (Surya reads each
    one) is dropped; a record's serial read outside the table ("13.") goes back into the last row
    when that row has none; other text from the bottom of the page (part of a row the reader took
    for a caption) stays, as a row across the whole table. Records cut at a page edge are joined
    once the whole table is known (continue_rows)."""
    blocks, between = [], []
    for block in spec["blocks"]:
        last = blocks[-1] if blocks else None
        if not between and last is not None and takes_serial(last, block):
            last["rows"][-1][0] = {**last["rows"][-1][0], "text": block["text"].strip()}
            continue
        if last is not None and last["type"] == "table" and (is_page_number(block) or is_loose_text(block)):
            between.append(block)
            continue
        if not (
            block["type"] == "table"
            and (block.get("page_break") or any(held.get("page_break") for held in between))
            and last is not None
            and last["type"] == "table"
            and column_count(last) == column_count(block)
        ):
            blocks += between
            between = []
            blocks.append(block)
            continue
        notes = [held for held in between if not is_page_number(held)]
        between = []
        headings = last.get("header_rows") or heading_count(last["rows"])
        rows = block["rows"]
        repeated = 0
        while repeated < headings and repeated < len(rows) and same_row(last["rows"][repeated], rows[repeated]):
            repeated += 1
        if headings:
            last["header_rows"] = headings
        last["size"] = LONG_TABLE_SIZE
        last["rows"] += [[{"text": reflowed(note["text"]), "colspan": column_count(last)}] for note in notes]
        last.setdefault("page_starts", []).append(len(last["rows"]))
        last["rows"] += rows[repeated:]
        if not last.get("widths_cm") and block.get("widths_cm"):
            last["widths_cm"] = block["widths_cm"]
    for block in blocks:
        if block.get("page_starts"):
            block["rows"] = continue_rows(block["rows"], block.pop("page_starts"), block.get("header_rows", 0))
    spec["blocks"] = blocks + between


def takes_serial(table, block):
    """Whether `block` is a serial number ("13.") the read left outside `table`, whose last row
    is a record without one."""
    if table["type"] != "table" or block["type"] != "paragraph" or len(table["rows"]) < 2:
        return False
    text = block.get("text", "").strip()
    last = table["rows"][-1]
    return bool(SERIAL_OUTSIDE.match(text)) and not first_text(last) and any(cell.get("text") for cell in last)


def is_loose_text(block):
    """Plain text on the same page as the table above it, such as part of a row read as a caption."""
    return block["type"] == "paragraph" and not block.get("page_break") and bool(block.get("text", "").strip())


def is_page_number(block):
    return block["type"] == "paragraph" and bool(PAGE_NUMBER.match(block.get("text", "")))


def first_text(row):
    return row[0].get("text", "").strip() if row else ""


def joined_text(cell, extra):
    parts = (cell.get("text", "").strip(), extra.get("text", "").strip())
    return " ".join(part for part in parts if part)


def same_cells(a, b):
    return [int(cell.get("colspan", 1)) for cell in a] == [int(cell.get("colspan", 1)) for cell in b]


def continue_rows(rows, page_starts, headings):
    """A record cut by the page edge goes on under the next page's heading with its first cell
    empty. Where most rows of the whole table, apart from these, carry a first cell (a serial number), that row is
    the rest of the record above it, so its cells are added to that record's. Only a page's first
    row: an empty first cell further down is a new record whose number the read lost."""
    starts = set(page_starts)
    body = [row for index, row in enumerate(rows) if index >= headings and index not in starts]
    if sum(1 for row in body if first_text(row)) * 2 <= len(body):
        return rows
    rows = list(rows)
    for start in sorted(page_starts, reverse=True):
        if start - 1 < headings or start >= len(rows) or first_text(rows[start]):
            continue
        last, rest = rows[start - 1], rows[start]
        if same_cells(last, rest):
            rows[start - 1:start + 1] = [[{**cell, "text": joined_text(cell, extra)} for cell, extra in zip(last, rest)]]
    return rows


def serial_value(text):
    """The number a serial cell holds. A handwritten 1 or 0 is often read as a letter (L, l, I, O)
    and a stroke before it as a quote, so those are read as digits when nothing else is in the cell."""
    text = text.replace(" ", "")
    match = SERIAL.match(text) or SERIAL.match(text.lstrip(SERIAL_MARKS).translate(SERIAL_LOOKALIKES))
    return int(match.group(1).translate(LATIN_DIGITS)) if match else None


def is_full_width(row):
    return len(row) == 1 and int(row[0].get("colspan", 1)) > 1


def record_places(rows):
    """Each row's place in the count of records, or None for a row that is not a record of its
    own: a full-width row of other text, and the rest of a record that a full-width row cut off."""
    places, place, previous = [], 0, None
    for row in rows:
        if is_full_width(row):
            numbered = LEADING_SERIAL.match(first_text(row))
            place += 1 if numbered else 0
            places.append(place if numbered else None)
        elif not first_text(row) and previous is not None and is_full_width(previous):
            places.append(None)
        else:
            place += 1
            places.append(place)
        previous = row
    return places


def renumber_serials(spec):
    """Serial numbers are often written by hand, and a read turns ৬ into ১ or ৮ into 3. Where a
    table's first column counts its records and most read numbers already sit at their place in
    the count, every record is numbered by its place, in the digits of the table's text. A record
    kept as a full-width row (part of a row read as a caption) keeps its own text and counts; the
    rest of that record, in the row after it, does not."""
    for block in spec["blocks"]:
        if block["type"] != "table":
            continue
        rows = block["rows"][block.get("header_rows") or heading_count(block["rows"]) :]
        start = next((i for i, row in enumerate(rows) if serial_value(first_text(row)) is not None), None)
        if start is None:
            continue
        records = rows[start:]
        places = record_places(records)
        values = [
            serial_value((LEADING_SERIAL.match(first_text(row)) or [""])[0]) if is_full_width(row) else serial_value(first_text(row))
            for row in records
        ]
        read = [value for value, place in zip(values, places) if value is not None and place is not None]
        if sum(1 for place in places if place is not None) < 3:
            continue
        if any(first_text(row) and value is None and not is_full_width(row) for row, value in zip(records, values)):
            continue
        in_place = sum(1 for place, value in zip(places, values) if place is not None and value == place)
        if in_place * 2 <= len(read):
            continue
        text = " ".join(cell.get("text", "") for row in records for cell in row)
        bangla = sum(1 for ch in text if "\u0980" <= ch <= "\u09ff") > sum(1 for ch in text if ch.isascii() and ch.isalpha())
        for place, row in zip(places, records):
            if place is None or is_full_width(row):
                continue
            number = str(place).translate(BANGLA_DIGITS) if bangla else str(place)
            row[0] = {**row[0], "text": f"{number}."}


def column_text(block):
    """Characters under the heading and the longest word anywhere, heading included, in each column."""
    columns = column_count(block)
    characters, longest = [0] * columns, [0] * columns
    headings = block.get("header_rows", 0)
    for index, row in enumerate(block["rows"]):
        column = 0
        for cell in row:
            span = int(cell.get("colspan", 1))
            text = cell.get("text", "")
            for covered in range(column, min(column + span, columns)):
                if index >= headings:
                    characters[covered] += len(text) / span
                if span == 1:
                    longest[covered] = max([longest[covered], *map(len, text.split())])
            column += span
    return characters, longest


def balance_widths(spec):
    """Retypeset text is larger than the scan's, so columns sized for the paper squeeze long text to
    a word a line beside wide empty ones. Half of each width follows the paper and half how much text
    the column holds; no column is narrower than its longest word, up to its width on the paper.
    The total width is kept."""
    for block in spec["blocks"]:
        widths = block.get("widths_cm")
        if block["type"] != "table" or not widths or len(widths) < MIN_BALANCED_COLUMNS:
            continue
        characters, longest = column_text(block)
        size = block.get("size") or spec.get("font", {}).get("size") or WORD_CHARACTER_SIZE
        letter_cm = WORD_CHARACTER_CM * size / WORD_CHARACTER_SIZE
        weights = [sqrt(count) for count in characters]
        if not sum(weights):
            continue
        total = sum(widths)
        wanted = [(width + total * weight / sum(weights)) / 2 for width, weight in zip(widths, weights)]
        floors = [
            min(width, length * letter_cm + CELL_PADDING_CM) if length else 0
            for width, length in zip(widths, longest)
        ]
        if sum(floors) >= total:
            continue
        block["widths_cm"] = [round(width, 2) for width in fit_above_floors(wanted, floors, total)]


def fit_above_floors(wanted, floors, total):
    """Scales the wanted widths to the total; a column pushed under its floor is held there and the
    rest scaled again, until none is."""
    held = [False] * len(wanted)
    while True:
        free = total - sum(floor for floor, fixed in zip(floors, held) if fixed)
        share = free / sum(want for want, fixed in zip(wanted, held) if not fixed)
        widths = [floor if fixed else want * share for want, floor, fixed in zip(wanted, floors, held)]
        under = [not fixed and width < floor for width, floor, fixed in zip(widths, floors, held)]
        if not any(under):
            return widths
        held = [fixed or low for fixed, low in zip(held, under)]


def signature_top(image, box, ceiling=0):
    """The service's box varies by read and can start partway down the handwriting. It grows no
    higher than `ceiling`, the bottom of the line above the signature."""
    x0, top, x1, _ = box
    pixels = image.load()
    highest = top
    for y in range(top - 1, max(top - MAX_SIGNATURE_GROWTH, ceiling, 0) - 1, -1):
        if any(pixels[x, y] < DARK for x in range(x0, x1)):
            highest = y
        elif highest - y >= INK_GAP_ROWS:
            break
    return highest


def grow_signatures(boxes, page):
    signatures = [c for c in boxes if c["name"].startswith("sig")]
    if not signatures:
        return
    with Image.open(page) as source:
        image = ImageOps.grayscale(source)
    for crop in signatures:
        x0, _, x1, bottom = crop["box"]
        crop["box"] = [x0, signature_top(image, crop["box"], crop.get("ceiling") or 0), x1, bottom]


def without_print(page, boxes, qa):
    """The page with the printed lines next to each signature painted white, so its crop holds the
    handwriting alone, not a strip of the name under it. The page itself when there are none."""
    masks = [mask for crop in boxes for mask in crop.get("mask") or []]
    if not masks:
        return page
    with Image.open(page) as source:
        image = source.convert("RGB")
    draw = ImageDraw.Draw(image)
    for x0, y0, x1, y1 in masks:
        draw.rectangle((x0, y0 - MASK_PAD, x1, y1 + MASK_PAD), fill="white")
    masked = qa / f"masked-{Path(page).stem}.png"
    image.save(masked)
    return masked


def snap_to_ink(page, box):
    """A rough box moved onto the ink it covers: the shapes mostly inside it, looked for a little
    beyond it, so the picture neither loses a stroke nor takes in print around it."""
    x0, y0, x1, y1 = box
    grow_x, grow_y = SNAP_GROW * (x1 - x0) + SNAP_PAD, SNAP_GROW * (y1 - y0) + SNAP_PAD
    with Image.open(page) as source:
        width, height = source.size
        left, top = int(max(0, x0 - grow_x)), int(max(0, y0 - grow_y))
        right, bottom = int(min(width, x1 + grow_x)), int(min(height, y1 + grow_y))
        if right <= left or bottom <= top:
            return box
        gray = ImageOps.grayscale(source.crop((left, top, right, bottom))).filter(ImageFilter.MinFilter(3))
    pixels = gray.load()
    ink = {(x, y) for y in range(gray.height) for x in range(gray.width) if pixels[x, y] < DARK}
    kept = []
    for sx0, sy0, sx1, sy1 in ink_shapes(ink, gray.width, gray.height):
        shape = [left + sx0, top + sy0, left + sx1 + 1, top + sy1 + 1]
        inside = max(0, min(shape[2], x1) - max(shape[0], x0)) * max(0, min(shape[3], y1) - max(shape[1], y0))
        area = (shape[2] - shape[0]) * (shape[3] - shape[1])
        if area >= SNAP_MIN_AREA and inside >= SNAP_INSIDE * area:
            kept.append(shape)
    if not kept:
        return box
    return [min(s[0] for s in kept), min(s[1] for s in kept), max(s[2] for s in kept), max(s[3] for s in kept)]


def run_crops(crops, pages, qa):
    """Cuts every picture that has a box. Returns the crop names that came out."""
    script = Path(__file__).resolve().parent / "crop.py"
    made = set()
    for number, page in enumerate(pages, 1):
        boxes = [c for c in crops if c["box"] and c.get("page", 1) == number]
        if not boxes:
            continue
        grow_signatures(boxes, page)
        for crop in boxes:
            if crop.pop("snap", False):
                crop["box"] = snap_to_ink(page, crop["box"])
        args = [f"{c['name']}={','.join(str(v) for v in c['box'])}" for c in boxes]
        result = subprocess.run(
            [sys.executable, str(script), str(without_print(page, boxes, qa)), str(qa), *args],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            print(result.stderr.strip()[-300:])
            continue
        made.update(c["name"] for c in boxes if (qa / f"{c['name']}.png").exists())
    return made


def keep_largest_shape(path):
    """Clears what a loose box caught beside a logo, such as a handwritten note or a piece of text.

    Only for logos, which are one solid shape. A signature is many separate strokes, so this would
    delete parts of it. A line of text is wide and flat, so a compact shape is preferred over it:
    the caption under an emblem can hold more ink than the emblem.
    """
    with Image.open(path) as opened:
        image = opened.convert("RGB")
    gray = ImageOps.grayscale(image)
    small = gray.point(lambda v: 255 if v < 170 else 0).filter(ImageFilter.MaxFilter(BLOB_REACH * 2 + 1))
    width, height = small.size
    ink = small.load()
    seen = set()
    shapes = []
    for sx in range(width):
        for sy in range(height):
            if not ink[sx, sy] or (sx, sy) in seen:
                continue
            stack, xs, ys, count = [(sx, sy)], [], [], 0
            seen.add((sx, sy))
            while stack:
                x, y = stack.pop()
                count += 1
                xs.append(x)
                ys.append(y)
                for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                    if 0 <= nx < width and 0 <= ny < height and ink[nx, ny] and (nx, ny) not in seen:
                        seen.add((nx, ny))
                        stack.append((nx, ny))
            shapes.append((count, min(xs), min(ys), max(xs), max(ys)))
    compact = [s for s in shapes if s[3] - s[1] + 1 <= LOGO_MAX_ASPECT * (s[4] - s[2] + 1)]
    if not shapes:
        return
    _, left, top, right, bottom = max(compact or shapes)
    image.crop((left, top, right + 1, bottom + 1)).save(path)


def enlarge(path):
    """A crop keeps its printed size but gets ENLARGE times the pixels, resampled smoothly, so a
    logo or signature cut from a small photo prints sharp instead of blocky."""
    with Image.open(path) as opened:
        image = opened.convert("RGB")
    factor = min(ENLARGE, MAX_PICTURE_EDGE / max(image.size))
    if factor <= 1:
        return
    image.resize((round(image.width * factor), round(image.height * factor)), Image.Resampling.LANCZOS).save(path)


def clear_paper(path):
    """Redraws a signature, logo or stamp as crisp ink on see-through paper. It is enlarged
    MARK_ENLARGE times, its stair-stepped edges smoothed, and its edge set by a steep but smooth
    fade from ink to clear: strokes print sharp instead of blocky, and no box shows over the page.
    The ink keeps its colour, spread to the stroke edges so they are not washed out by the paper."""
    with Image.open(path) as opened:
        image = opened.convert("RGB")
    factor = min(MARK_ENLARGE, MAX_PICTURE_EDGE / max(image.size))
    if factor > 1:
        image = image.resize((round(image.width * factor), round(image.height * factor)), Image.Resampling.BICUBIC)
    gray = ImageOps.grayscale(image).filter(ImageFilter.GaussianBlur(EDGE_SMOOTHING))
    color = image.filter(ImageFilter.MinFilter(3))
    color.putalpha(gray.point(ink_alpha))
    color.save(path)


def ink_alpha(value):
    """Solid at or below OPAQUE_INK, clear at or above CLEAR_PAPER, a smooth step between."""
    if value <= OPAQUE_INK:
        return 255
    if value >= CLEAR_PAPER:
        return 0
    share = (CLEAR_PAPER - value) / (CLEAR_PAPER - OPAQUE_INK)
    return round(255 * share * share * (3 - 2 * share))


def mostly_paper(path):
    """Whether a picture is marks on paper, like a stamp or a seal, rather than a photo: most of
    it is as light as the paper."""
    with Image.open(path) as opened:
        histogram = ImageOps.grayscale(opened.convert("RGB")).histogram()
    return sum(histogram[PAPER_LIGHT:]) >= PAPER_PICTURE_SHARE * sum(histogram)


def place_pictures(spec, made, qa, cm_per_pixel, crop_pages=None):
    """Sets each picture to its size on the page. One with no crop is left out and reported.
    `crop_pages` gives each crop's page, for a scale that differs by page."""
    kept, missing = [], []
    for block in spec["blocks"]:
        for key, width_key in (("logo", "logo_width_cm"), ("image", "image_width_cm"), ("path", "width_cm")):
            path = block.get(key)
            if not path:
                continue
            name = Path(path).stem
            if name in made:
                if key == "logo":
                    keep_largest_shape(qa / f"{name}.png")
                with Image.open(qa / f"{name}.png") as image:
                    scale = page_scale(cm_per_pixel, (crop_pages or {}).get(name, 1))
                    block[width_key] = round(image.width * scale, 2)
                if key in ("logo", "image") or mostly_paper(qa / f"{name}.png"):
                    # A signature, logo, stamp or seal; a photo keeps its background.
                    clear_paper(qa / f"{name}.png")
                else:
                    enlarge(qa / f"{name}.png")
            else:
                missing.append(name)
                del block[key]
        if block["type"] != "image" or block.get("path"):
            kept.append(block)
    spec["blocks"] = kept
    return missing


def trend(values):
    """From -1 to 1: how consistently the values rise in order, counted over every pair, so one
    stamp or note out of place barely moves it."""
    pairs = [(a, b) for index, a in enumerate(values) for b in values[index + 1:] if a != b]
    if not pairs:
        return 0
    return sum(1 if b > a else -1 for a, b in pairs) / len(pairs)


def rotation_lines(elements):
    """Boxes of the lines long enough to show which way the text runs."""
    lines = []
    for element in elements:
        coordinates = (element.get("metadata") or {}).get("coordinates") or {}
        points = coordinates.get("points")
        if points and len(element.get("text") or "") >= MIN_ROTATION_TEXT:
            xs, ys = [p[0] for p in points], [p[1] for p in points]
            width = coordinates.get("layout_width") or 1
            height = coordinates.get("layout_height") or 1
            lines.append((min(xs), min(ys), max(xs), max(ys), width, height))
    return lines


def text_direction(elements):
    """'clockwise', 'counterclockwise' or 'upside_down' when the page must be turned, else None.

    A table scanned sideways comes back from the service with tall, narrow line boxes. Reading moves
    from the top of the upright page to its bottom, so the way the lines drift in reading order says
    which way to turn, and a stamp or note read first does not decide it alone. A page whose lines are
    wide but run from the bottom of the image upwards was scanned upside down.
    """
    lines = rotation_lines(elements)
    if not lines:
        return None
    upright = [line for line in lines if line[2] - line[0] >= line[3] - line[1]]
    if len(upright) * 2 >= len(lines):
        down = trend([(line[1] + line[3]) / 2 / line[5] for line in lines])
        if len(lines) >= MIN_UPSIDE_DOWN_LINES and down <= -UPSIDE_DOWN_TREND:
            return "upside_down"
        return None
    across = trend([(line[0] + line[2]) / 2 / line[4] for line in lines])
    if across == 0:
        first = lines[0]
        across = first[4] / 2 - (first[0] + first[2]) / 2
    return "clockwise" if across > 0 else "counterclockwise"


TURNS = {"clockwise": -90, "counterclockwise": 90, "upside_down": 180}


def turn_point(point, width, height, direction):
    x, y = point
    if direction == "upside_down":
        return [width - x, height - y]
    return [height - y, x] if direction == "clockwise" else [y, width - x]


def ink_shapes(mask, width, height):
    """Bounding boxes [x0, y0, x1, y1] of the 4-connected shapes in a set of inked (x, y)."""
    seen, shapes = set(), []
    for start in mask:
        if start in seen:
            continue
        seen.add(start)
        stack, xs, ys = [start], [], []
        while stack:
            x, y = stack.pop()
            xs.append(x)
            ys.append(y)
            for near in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                if near in mask and near not in seen:
                    seen.add(near)
                    stack.append(near)
        shapes.append([min(xs), min(ys), max(xs), max(ys)])
    return shapes


def line_pieces(gray):
    """The printed pieces of text in a region: runs of words on one line, split where a gap wider
    than a few letters runs through, as between side-by-side columns. Bangla words hang from their
    headline, so a word is one shape about a line high; closing the gaps between words along each
    row joins them into pieces. Handwriting crossing several lines stays a tall piece of its own,
    where cutting the region at blank rows finds none. [x0, y0, x1, y1] in the region's pixels."""
    width, height = gray.size
    pixels = gray.load()
    ink = {(x, y) for y in range(height) for x in range(width) if pixels[x, y] < TYPE_DARK}
    words = [w for w in ink_shapes(ink, width, height) if w[3] - w[1] >= 2 and w[2] - w[0] >= 2]
    if not words:
        return []
    line = median(w[3] - w[1] + 1 for w in words if w[2] - w[0] >= w[3] - w[1])
    gap = int(SEGMENT_GAP * line)
    joined = set(ink)
    for y in range(height):
        row = [x for x in range(width) if (x, y) in ink]
        for left, right in zip(row, row[1:]):
            if 1 < right - left <= gap:
                joined.update((x, y) for x in range(left + 1, right))
    return [p for p in ink_shapes(joined, width, height) if p[3] - p[1] + 1 >= TYPE_MIN_BAND * line]


def reading_order(pieces):
    """Pieces grouped into blocks of lines that sit one under another, the blocks read from the top
    and, when they start level, from the left: a signature on the right that starts higher than the
    addressee on the left comes first, as the service reads them. Returns (piece, block) pairs."""
    blocks = []
    for piece in sorted(pieces, key=lambda p: (p[1], p[0])):
        height = piece[3] - piece[1] + 1
        home = next(
            (
                block for block in blocks
                if 0 <= piece[1] - block[-1][3] <= BLOCK_GAP * height + 1
                and piece[0] <= block[-1][2] and block[-1][0] <= piece[2]
            ),
            None,
        )
        if home is None:
            blocks.append([piece])
        else:
            home.append(piece)
    level = median(p[3] - p[1] + 1 for p in pieces)
    blocks.sort(key=lambda block: (round(block[0][1] / level), block[0][0]))
    return [(piece, index) for index, block in enumerate(blocks) for piece in block]


def match_lines(lines, ordered, handwritten=None):
    """Each text line's pieces, in order, by how wide its letters would print. A long line may wrap
    over several pieces of one block; a piece no line explains, such as handwriting, is skipped.
    A printed line never takes a piece much taller than a line: that is handwriting, alone or run
    into the print under it. Returns one list of piece indexes per line, empty for a line not
    found, and the mean width error of the lines found."""
    handwritten = handwritten or [False] * len(lines)
    line_height = median(piece[3] - piece[1] + 1 for piece, _ in ordered)
    tall = [piece[3] - piece[1] + 1 > TALL_PIECE_LINES * line_height for piece, _ in ordered]
    widths = [piece[2] - piece[0] + 1 for piece, _ in ordered]
    printed_chars = sum(len(line) for line, hand in zip(lines, handwritten) if not hand)
    per_char = sum(widths) / max(printed_chars, 1)
    spans = {}
    for piece, block in ordered:
        left, right = spans.get(block, (piece[0], piece[2]))
        spans[block] = (min(left, piece[0]), max(right, piece[2]))
    full = [
        piece[2] >= spans[block][1] - WRAP_FULL_SHARE * (spans[block][1] - spans[block][0])
        for piece, block in ordered
    ]
    count, pieces = len(lines), len(ordered)
    cost = [[float("inf")] * (pieces + 1) for _ in range(count + 1)]
    step = [[None] * (pieces + 1) for _ in range(count + 1)]
    cost[0][0] = 0.0
    for i in range(count + 1):
        for j in range(pieces + 1):
            here = cost[i][j]
            if here == float("inf"):
                continue
            moves = []
            if j < pieces:
                moves.append((i, j + 1, here + SKIP_COST, ("skip",)))
            if i < count:
                moves.append((i + 1, j, here + MISS_COST, ("miss",)))
                for k in range(1, MAX_WRAP + 1):
                    if j + k > pieces or ordered[j + k - 1][1] != ordered[j][1]:
                        break
                    if tall[j + k - 1] and not handwritten[i]:
                        break
                    if k > 1 and not handwritten[i] and not full[j + k - 2]:
                        break
                    if handwritten[i]:
                        moves.append((i + 1, j + k, here + HAND_TAKE_COST + WRAP_COST * (k - 1), ("take", k)))
                        continue
                    printed = sum(widths[j:j + k])
                    expected = max(len(lines[i]), 1) * per_char
                    error = abs(log(expected / printed))
                    if error > MAX_LINE_ERROR:
                        continue
                    moves.append((i + 1, j + k, here + error + WRAP_COST * (k - 1), ("take", k)))
            for ni, nj, value, move in moves:
                if value < cost[ni][nj]:
                    cost[ni][nj], step[ni][nj] = value, (i, j, move)
    taken = [[] for _ in lines]
    i, j = count, pieces
    while (i, j) != (0, 0):
        pi, pj, move = step[i][j]
        if move[0] == "take":
            taken[pi] = list(range(pj, pj + move[1]))
        i, j = pi, pj
    errors = [
        abs(log(max(len(line), 1) * per_char / sum(widths[index] for index in indexes)))
        for line, indexes, hand in zip(lines, taken, handwritten)
        if indexes and not hand
    ]
    error = sum(errors) / len(errors) if errors else float("inf")
    # Letter width scaled from these lines alone fits any text on average; a letter is about
    # 0.4 of a line high, so text that is not on the page gives a scale far from that.
    usual = TYPICAL_CHAR_SHARE * median(piece[3] - piece[1] + 1 for piece, _ in ordered)
    if not 1 / MAX_CHAR_SCALE <= per_char / usual <= MAX_CHAR_SCALE:
        error = float("inf")
    return taken, error


def line_element(element, text, box, scale):
    """One line of a shared element, with its own box back in the service's coordinates."""
    x0, y0, x1, y1 = (value / factor for value, factor in zip(box, (*scale, *scale)))
    coordinates = {**element["metadata"]["coordinates"], "points": [[x0, y0], [x0, y1], [x1, y1], [x1, y0]]}
    return {**element, "text": text, "metadata": {**element["metadata"], "coordinates": coordinates}}


def place_lines(element, image):
    """The element as one element per line placed where it printed, or None when its lines cannot
    be matched to the page well enough."""
    coordinates = element["metadata"]["coordinates"]
    scale = (image.width / coordinates["layout_width"], image.height / coordinates["layout_height"])
    points = coordinates["points"]
    x0, y0 = min(p[0] for p in points) * scale[0], min(p[1] for p in points) * scale[1]
    x1, y1 = max(p[0] for p in points) * scale[0], max(p[1] for p in points) * scale[1]
    gray = ImageOps.grayscale(image.crop((int(x0), int(y0), int(x1) + 1, int(y1) + 1)))
    pieces = line_pieces(gray)
    lines = [line.strip() for line in element["text"].split("\n") if line.strip()]
    if not pieces:
        return None
    ordered = reading_order(pieces)
    if len({block for _, block in ordered}) < 2:
        # One block of lines is a paragraph that wraps: its lines must stay one paragraph.
        return None
    # Handwriting read as text has no width to match by, but it sits between the printed lines
    # around it. It takes the pieces there, so a printed line never wraps over them, and its box
    # tells the signature's picture where the handwriting runs.
    handwritten = [looks_handwritten({"text": line}) for line in lines]
    printed = [line for line, hand in zip(lines, handwritten) if not hand]
    taken, error = match_lines(lines, ordered, handwritten)
    used = sum(len(indexes) for indexes in taken)
    found = sum(1 for indexes, hand in zip(taken, handwritten) if indexes and not hand)
    if (
        found < MIN_MATCHED_LINES * len(printed)
        or len(pieces) - used > MAX_SKIPPED_PIECES * len(pieces) + HANDWRITING_PIECES * sum(handwritten)
        or error > MAX_WIDTH_ERROR
    ):
        return None
    placed = []
    for index, (text, indexes) in enumerate(zip(lines, taken)):
        if not indexes:
            unplaced = {**element, "text": text, "metadata": {k: v for k, v in element["metadata"].items() if k != "coordinates"}}
            placed.append(with_line_role(unplaced, index))
            continue
        boxes = [ordered[index][0] for index in indexes]
        box = [
            x0 + min(b[0] for b in boxes), y0 + min(b[1] for b in boxes),
            x0 + max(b[2] for b in boxes) + 1, y0 + max(b[3] for b in boxes) + 1,
        ]
        placed.append(with_line_role(line_element(element, text, box, scale), index))
    return placed


def place_shared_lines(elements, pages):
    """The service can return half a page, signature, addressee and copy list, as one element with
    one box. Its lines are found on the scan and given their own boxes, so they are placed, sized
    and recognised (a signature on the right, a memo row) like any other line."""
    result = []
    for element in elements:
        metadata = element.get("metadata") or {}
        coordinates = metadata.get("coordinates") or {}
        points, width = coordinates.get("points"), coordinates.get("layout_width")
        page = int(metadata.get("page_number") or 1)
        lines = [line for line in (element.get("text") or "").split("\n") if line.strip()]
        wide = bool(points and width) and (max(p[0] for p in points) - min(p[0] for p in points)) / width > SHARED_BOX_SHARE
        # Long lines are a paragraph wrapping across the box; its lines must stay one paragraph.
        prose = bool(lines) and median(len(line) for line in lines) >= PROSE_LINE_CHARS
        if element.get("type") not in TEXT_TYPES or len(lines) < SHARED_MIN_LINES or not wide or prose or page > len(pages):
            result.append(element)
            continue
        with Image.open(pages[page - 1]) as image:
            placed = place_lines(element, image.convert("RGB"))
        result.extend(placed or [element])
    return result


def page_direction(elements, image):
    """How a page must be turned: from the read's line boxes, or, where the page has too few long
    lines for them to tell, from the scan's word shapes when those are clear."""
    direction = text_direction(elements)
    if len(rotation_lines(elements)) >= MIN_UPSIDE_DOWN_LINES:
        return direction
    guess, sure = word_direction(image)
    return guess if sure else direction


def turn_boxes(elements, direction):
    for element in elements:
        coordinates = (element.get("metadata") or {}).get("coordinates") or {}
        width, height = coordinates.get("layout_width"), coordinates.get("layout_height")
        if not coordinates.get("points") or not width or not height:
            continue
        coordinates["points"] = [turn_point(p, width, height, direction) for p in coordinates["points"]]
        if direction != "upside_down":
            coordinates["layout_width"], coordinates["layout_height"] = height, width


def tilt_boxes(elements, angle):
    """Moves each box's center as the page turns by `angle`, keeping its size: the box the reader
    drew round a leaning line already covers the line once it stands straight."""
    for element in elements:
        coordinates = (element.get("metadata") or {}).get("coordinates") or {}
        width, height = coordinates.get("layout_width"), coordinates.get("layout_height")
        points = coordinates.get("points")
        if not points or not width or not height:
            continue
        xs, ys = [p[0] for p in points], [p[1] for p in points]
        cx, cy = turn_about_center(((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2), angle, width, height)
        dx, dy = cx - (min(xs) + max(xs)) / 2, cy - (min(ys) + max(ys)) / 2
        coordinates["points"] = [[x + dx, y + dy] for x, y in points]


def upright(elements, pages):
    """Turns sideways and upside-down pages upright and straightens a crooked scan, moving the
    element boxes with them, in place."""
    by_page = {}
    for element in elements:
        by_page.setdefault(int((element.get("metadata") or {}).get("page_number") or 1), []).append(element)
    for number, page_elements in by_page.items():
        if number > len(pages):
            continue
        with Image.open(pages[number - 1]) as opened:
            image = opened.copy()
        changed = False
        direction = page_direction(page_elements, image)
        if direction is not None:
            image = image.rotate(TURNS[direction], expand=True)
            turn_boxes(page_elements, direction)
            changed = True
        tilt = page_tilt(image)
        if tilt is not None and abs(tilt) >= MIN_TILT:
            image = image.rotate(-tilt, fillcolor="white", resample=Image.Resampling.BICUBIC)
            tilt_boxes(page_elements, -tilt)
            changed = True
        if changed:
            image.save(pages[number - 1])


def tagged(node, name):
    """Descendants named `name`, whatever their XML namespace."""
    return [child for child in node.iter() if child.tag.rsplit("}", 1)[-1] == name]


def bbox_elements(xhtml, page):
    """Elements with positions from `pdftotext -bbox-layout`: one per text block, its lines kept."""
    root = ElementTree.fromstring(xhtml)
    sheet = next(iter(tagged(root, "page")), None)
    if sheet is None:
        return []
    width, height = float(sheet.get("width")), float(sheet.get("height"))
    elements = []
    for block in tagged(sheet, "block"):
        lines = [" ".join(word.text or "" for word in tagged(line, "word")) for line in tagged(block, "line")]
        text = "\n".join(line.strip() for line in lines if line.strip())
        if not text:
            continue
        x0, y0, x1, y1 = (float(block.get(key)) for key in ("xMin", "yMin", "xMax", "yMax"))
        elements.append({
            "type": "NarrativeText",
            "text": text,
            "metadata": {
                "page_number": page,
                "coordinates": {
                    "points": [[x0, y0], [x0, y1], [x1, y1], [x1, y0]],
                    "layout_width": width,
                    "layout_height": height,
                },
            },
        })
    return elements


def digital_page_elements(source, page):
    """A digital page's text blocks with their positions, read from the PDF itself; [] if it fails."""
    command = ["pdftotext", "-bbox-layout", "-f", str(page), "-l", str(page), str(source), "-"]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0 or not result.stdout.strip():
        return []
    try:
        return bbox_elements(result.stdout, page)
    except ElementTree.ParseError:
        return []


def with_digital_pages(elements, source, read=digital_page_elements):
    """Pages that had good text were not sent for reading, so they arrive as one unbroken run of the
    parser's text with no position. Their blocks and positions are read from the PDF instead, so
    they keep their paragraphs, gaps and page breaks."""
    pages = {
        int(element["metadata"]["page_number"])
        for element in elements
        if (element.get("metadata") or {}).get("source") == "parser"
    }
    found = {page: read(source, page) for page in sorted(pages)}
    merged = []
    for element in elements:
        metadata = element.get("metadata") or {}
        page = metadata.get("page_number")
        if metadata.get("source") != "parser" or not found.get(page):
            merged.append(element)
        elif found[page] is not None:
            merged.extend(found[page])
            found[page] = None
    return merged


def main(argv):
    if len(argv) != 3:
        print(__doc__)
        return 1
    elements_path, source, out = argv
    qa = Path(out).resolve().parent / "qa"
    qa.mkdir(parents=True, exist_ok=True)

    pages = render_pages(source, qa)
    elements = json.loads(Path(elements_path).read_text(encoding="utf-8"))
    if Path(source).suffix.lower() == ".pdf":
        elements = with_digital_pages(elements, source)
    upright(elements, pages)
    elements = place_shared_lines(elements, pages)
    scan_sizes = {}
    for number, page in enumerate(pages, 1):
        with Image.open(page) as image:
            scan_sizes[number] = image.size
    cm_per_pixel = {
        number: (PAGE_HEIGHT_CM if width > height else PAGE_WIDTH_CM) / width
        for number, (width, height) in scan_sizes.items()
    }

    spec, crops = convert(elements, scan_sizes, str(qa))
    apply_table_widths(spec, pages, cm_per_pixel)
    join_continued_tables(spec)
    renumber_serials(spec)
    balance_widths(spec)
    apply_type(spec, pages, cm_per_pixel)
    crop_pages = {crop["name"]: crop.get("page", 1) for crop in crops}
    missing = place_pictures(spec, run_crops(crops, pages, qa), qa, cm_per_pixel, crop_pages)

    spec_path = qa / "spec.json"
    spec_path.write_text(json.dumps(spec, ensure_ascii=False, indent=1), encoding="utf-8")
    letter = Path(__file__).resolve().parent / "letter.py"
    result = subprocess.run(
        [sys.executable, str(letter), str(spec_path), str(out), "--source", str(pages[0])],
        capture_output=True,
        text=True,
    )
    print(result.stdout.strip() or result.stderr.strip()[-500:])
    print(f"spec: {spec_path}")
    if missing:
        print("pictures left out, no position found: " + ", ".join(missing))
    return result.returncode


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
