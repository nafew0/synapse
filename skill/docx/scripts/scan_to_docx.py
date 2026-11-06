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
from math import sqrt
from statistics import median
from pathlib import Path

from PIL import Image, ImageFilter, ImageOps

sys.path.insert(0, str(Path(__file__).resolve().parent))
from elements_spec import convert, reflowed  # noqa: E402

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
FAINT_RULE_REACH_CM = 0.4
FAINT_RULE_MIN_INK = 8
BLOB_REACH = 3
INK_GAP_ROWS = 12
MAX_SIGNATURE_GROWTH = 200
HEADING_MATCH = 0.6
MIN_UPSIDE_DOWN_LINES = 3
UPSIDE_DOWN_TREND = 0.5
MIN_BALANCED_COLUMNS = 3
WORD_CHARACTER_CM = 0.15
WORD_CHARACTER_SIZE = 10.5
LONG_TABLE_SIZE = 8.5
CELL_PADDING_CM = 0.25
SERIAL = re.compile(r"^\(?([0-9০-৯]{1,3})[.)।]?$")
SERIAL_OUTSIDE = re.compile(r"^\(?[0-9০-৯]{1,3}[.)।]$")
PAGE_NUMBER = re.compile(r"^\s*(?:[-–]\s*)?[0-9০-৯]{1,4}(?:\s*[-–])?\s*$")
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
    return sum((255 - value) ** 2 for value in darkness_profile(region))


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
    if len(positions) != columns + 1:
        return None
    widths = [round((b - a) * cm_per_pixel, 2) for a, b in zip(positions, positions[1:])]
    return widths if min(widths) >= MIN_COLUMN_CM else None


def page_scale(cm_per_pixel, page):
    """Centimetres per scan pixel on a page: one scale, or one per page number."""
    if not isinstance(cm_per_pixel, dict):
        return cm_per_pixel
    return cm_per_pixel.get(page) or next(iter(cm_per_pixel.values()))


def apply_table_widths(spec, pages, cm_per_pixel):
    """Widths from each table's rules. A table whose rules cannot be read takes the widths found for
    another table with as many columns: a long table scanned page by page repeats one layout."""
    found = {}
    for block in spec["blocks"]:
        box = block.pop("box", None)
        page = block.pop("box_page", 1)
        if block["type"] != "table" or not box or page > len(pages):
            continue
        columns = sum(int(cell.get("colspan", 1)) for cell in block["rows"][0])
        with Image.open(pages[page - 1]) as image:
            widths = table_widths(image.convert("RGB"), box, columns, page_scale(cm_per_pixel, page))
        if widths:
            block["widths_cm"] = widths
            found.setdefault(columns, []).append(widths)
    shared = {columns: [median(column) for column in zip(*sets)] for columns, sets in found.items()}
    for block in spec["blocks"]:
        if block["type"] != "table" or block.get("widths_cm"):
            continue
        columns = sum(int(cell.get("colspan", 1)) for cell in block["rows"][0])
        if columns in shared:
            block["widths_cm"] = [round(width, 2) for width in shared[columns]]


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


def signature_top(image, box):
    """The service's box varies by read and can start partway down the handwriting."""
    x0, top, x1, _ = box
    pixels = image.load()
    highest = top
    for y in range(top - 1, max(top - MAX_SIGNATURE_GROWTH, 0) - 1, -1):
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
        crop["box"] = [x0, signature_top(image, crop["box"]), x1, bottom]


def run_crops(crops, pages, qa):
    """Cuts every picture that has a box. Returns the crop names that came out."""
    script = Path(__file__).resolve().parent / "crop.py"
    made = set()
    for number, page in enumerate(pages, 1):
        boxes = [c for c in crops if c["box"] and c.get("page", 1) == number]
        if not boxes:
            continue
        grow_signatures(boxes, page)
        args = [f"{c['name']}={','.join(str(v) for v in c['box'])}" for c in boxes]
        result = subprocess.run(
            [sys.executable, str(script), str(page), str(qa), *args], capture_output=True, text=True
        )
        if result.returncode != 0:
            print(result.stderr.strip()[-300:])
            continue
        made.update(c["name"] for c in boxes if (qa / f"{c['name']}.png").exists())
    return made


def keep_largest_shape(path):
    """Clears what a loose box caught beside a logo, such as a handwritten note or a piece of text.

    Only for logos, which are one solid shape. A signature is many separate strokes, so this would
    delete parts of it.
    """
    with Image.open(path) as opened:
        image = opened.convert("RGB")
    gray = ImageOps.grayscale(image)
    small = gray.point(lambda v: 255 if v < 170 else 0).filter(ImageFilter.MaxFilter(BLOB_REACH * 2 + 1))
    width, height = small.size
    ink = small.load()
    seen = set()
    best = None
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
            if best is None or count > best[0]:
                best = (count, min(xs), min(ys), max(xs), max(ys))
    if best is None:
        return
    _, left, top, right, bottom = best
    image.crop((left, top, right + 1, bottom + 1)).save(path)


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


def text_direction(elements):
    """'clockwise', 'counterclockwise' or 'upside_down' when the page must be turned, else None.

    A table scanned sideways comes back from the service with tall, narrow line boxes. Reading moves
    from the top of the upright page to its bottom, so the way the lines drift in reading order says
    which way to turn, and a stamp or note read first does not decide it alone. A page whose lines are
    wide but run from the bottom of the image upwards was scanned upside down.
    """
    lines = []
    for element in elements:
        coordinates = (element.get("metadata") or {}).get("coordinates") or {}
        points = coordinates.get("points")
        if points and len(element.get("text") or "") >= MIN_ROTATION_TEXT:
            xs, ys = [p[0] for p in points], [p[1] for p in points]
            width = coordinates.get("layout_width") or 1
            height = coordinates.get("layout_height") or 1
            lines.append((min(xs), min(ys), max(xs), max(ys), width, height))
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


def upright(elements, pages):
    """Turns sideways and upside-down pages and their element boxes upright, in place."""
    by_page = {}
    for element in elements:
        by_page.setdefault(int((element.get("metadata") or {}).get("page_number") or 1), []).append(element)
    for number, page_elements in by_page.items():
        direction = text_direction(page_elements)
        if direction is None or number > len(pages):
            continue
        with Image.open(pages[number - 1]) as image:
            image.rotate(TURNS[direction], expand=True).save(pages[number - 1])
        for element in page_elements:
            coordinates = (element.get("metadata") or {}).get("coordinates") or {}
            width, height = coordinates.get("layout_width"), coordinates.get("layout_height")
            if not coordinates.get("points") or not width or not height:
                continue
            coordinates["points"] = [turn_point(p, width, height, direction) for p in coordinates["points"]]
            if direction != "upside_down":
                coordinates["layout_width"], coordinates["layout_height"] = height, width


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
