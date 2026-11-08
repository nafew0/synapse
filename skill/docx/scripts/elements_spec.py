"""Turn read_document's elements into the spec letter.py builds from.

    python3 elements_spec.py <name.elements.json> <spec.json> [--scan <page image>] [--crops <dir>]

The text comes from the elements as they are, so no word is retyped. What the elements cannot say
is printed as the report, for you to settle before building:

  crop: logo x0,y0,x1,y1      a picture on the page, its box in the scan's pixels (needs --scan)
  crop: sig1 (box needed)     a picture with no position: take its box from the page image

A signature's box is worked out from the printed lines under it, so check it on the page image.

Each picture's block already points at <crops>/<name>.png, so run crop.py with those names. A
letterhead, memo row or signature that came out wrong is fixed in the spec, not by retyping it all.
"""

import argparse
import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

DEFAULT_CROPS = "/mnt/data/qa"
MEMO = re.compile(r"^\s*(?:স্মারক|সূত্র|Memo\b|Ref(?:erence)?\b)", re.IGNORECASE)
DATE_LABEL = re.compile(r"^\s*(?:তারিখ|Date\b)", re.IGNORECASE)
DATE_INSIDE = re.compile(r"(?:তারিখ|Date\b)", re.IGNORECASE)
DATE_ONLY = re.compile(r"^[০-৯\d]{1,2}\s+\S+\s+[০-৯\d]{4}(?:\s*\S*)?$")
LIST_NUMBER = re.compile(r"^\s*([০-৯\d]+(?:\s*[-–]\s*[০-৯\d]+)?\s*[।)]|[০-৯\d]+\.(?=\s)|[ক-হ]\s*[।)]|[•·])\s*(.*)$", re.DOTALL)
ITEM_START = re.compile(r"^(?:[০-৯\d]{1,2}\s*[.।)]|[a-kA-K]\s*\)|[ক-চ]\s*[।)]|[•·])")
"""A list item: 1. ২) a) ক) •. Letters stop at k and চ, so a word cut as Dropou|t) or দুর্গ|ম) is
not taken for one."""
COMBINING = set("\u0981\u0982\u0983\u09bc\u09be\u09bf\u09c0\u09c1\u09c2\u09c3\u09c4\u09c7\u09c8\u09cb\u09cc\u09cd\u09d7")
BANGLA_PART = re.compile(r"[\u0980-\u09e5\u09f0-\u09ff]")
LATIN_PART = re.compile(r"[A-Za-z]")
MAX_WORD_END = 2
NEVER_FIRST = ("\u09a1\u09bc", "\u09a2\u09bc", "\u09af\u09bc", "\u09dc", "\u09dd", "\u09df", "\u09ce")
"""ড়, ঢ়, য় (either encoding) and ৎ never begin a Bangla word."""
LONE_CONSONANT = re.compile(r"(?<=[\u0980-\u09e5\u09f0-\u09ff])\s+([\u0995-\u09b9\u09ce\u09dc\u09dd\u09df](?:\u09bc)?)(?=[\s,;:।)]|$)")
"""A consonant standing alone after a word: the end of that word, cut off where the paper wrapped it."""
LONE_LATIN = re.compile(r"(?<=[a-z])\s+([b-hj-z])(?=[\s,;:.)]|$)")
"""A lowercase letter standing alone after an English word (not a or i): the word's cut-off end."""
JOINED_PREFIXES = {("উপ", "জেলা")}
SHORT_WORDS = {
    "ও", "এ", "কি", "না", "বা", "যে", "সে", "তা", "এর", "এই", "সব", "আর", "পর", "সহ", "মত", "নয়", "হয়", "হবে", "করা",
    "করে", "জন", "জনে", "দিন", "মাস", "হতে", "যা", "ও।", "a", "an", "of", "to", "in", "on", "or", "and", "the", "for",
}
WORD_EDGE = ",;:।.)(\"'‘’"
CELL_NUMBER = re.compile(r"\s+(?=[০-৯\d]{1,2}[.।]\s)")
# Visarga is a mark that needs a letter under it. Typed as a colon after a space or bracket, as old
# Bijoy-era notices do ("তারিখ ঃ"), Word draws it on a dotted circle. Joined to the word before it,
# it draws as itself; with no Bangla letter to join, a colon looks the same on paper.
BANGLA_BASE = "\u0981\u0982\u0985-\u09b9\u09bc-\u09cc\u09ce\u09d7\u09dc-\u09df\u09e0-\u09e3"
SPACED_VISARGA = re.compile(rf"(?<=[{BANGLA_BASE}])[ \u00a0]+\u0983")
LOOSE_VISARGA = re.compile(rf"(?<![{BANGLA_BASE}])\u0983")
BANGLA_LETTER = re.compile(r"[\u0985-\u09b9\u09dc-\u09df]")
LATIN_LETTER = re.compile(r"[A-Za-z]")
CONTACT = re.compile(r"@|www\.|https?:|\.(?:com|org|gov|edu|bd)\b", re.IGNORECASE)
MAX_HANDWRITTEN_CHARS = 25
SIGNATURE_LINES_ABOVE = 3
MAX_SIGNATURE_LINES_ABOVE = 6
HANDWRITTEN_DATE = re.compile(r"[০-৯\d]{1,2}[/.-][০-৯\d]{1,2}[/.-][০-৯\d]{2,4}$")
SHORT_LINE = 70
MAX_SIGNATURE_LINES = 5
PICTURE_TYPES = {"Image", "Figure", "Picture"}
PAGE_NUMBER = re.compile(r"^\s*(?:[-–]\s*)?[0-9০-৯]{1,4}(?:\s*[-–])?\s*$")
DROPPED_TYPES = {"PageBreak", "PageNumber"}
TYPE_MEASURED = {"title", "heading", "paragraph"}
TEXT_TYPES = {"NarrativeText", "UncategorizedText", "ListItem", "Form"}
MIN_PICTURE_SHARE = 0.002
RIGHT_SIDE_SHARE = 0.55
CENTER_TOLERANCE = 0.05
HEAD_SEARCH = 14
DEFAULT_LINE_HEIGHT_SHARE = 0.014
SIGNATURE_WIDTH_CM = 3.4
LOGO_WIDTH_CM = 1.8
# Office pages are dense: start tight, because letter.py stops shrinking at 10 pt.
PAGE = {"margins_cm": [1.2, 2.2, 1.0, 2.2]}
A4_WIDTH_CM = 21.0
MIN_SIDE_MARGIN_CM = 1.2
MAX_SIDE_MARGIN_CM = 3.5
POINTS_PER_CM = 28.35
MAX_GAP_PT = 60
MIN_INDENT_CM = 0.25
CENTERED_MAX_WIDTH = 0.8
SHARED_BOX_SHARE = 0.5
LARGE_TYPE_RATIO = 1.2
MAX_TITLE_SIZE = 18
MIN_SIGNATURE_BLOCK_CM = 5.0
MIN_DATE_CM = 3.0
A4_HEIGHT_CM = 29.7
MIN_TOP_MARGIN_CM = 1.0
MAX_TOP_MARGIN_CM = 2.5
MIN_BOTTOM_MARGIN_CM = 0.8
MAX_BOTTOM_MARGIN_CM = 2.0
FONT = {"latin": "Times New Roman", "bangla": "Nikosh", "size": 10.5}


class TableParser(HTMLParser):
    """Rows of cells from a reader's table HTML, keeping spans and header cells. A cell ends at its
    closing tag or, in compact HTML that leaves closing tags out (Surya), at the next cell or row."""

    def __init__(self):
        super().__init__()
        self.rows = []
        self.cell = None

    def finish_cell(self):
        if self.cell is not None:
            self.cell["text"] = with_colons(re.sub(r"[ \t]+", " ", self.cell["text"]).strip())
        self.cell = None

    def handle_starttag(self, tag, attrs):
        if tag in ("tr", "td", "th"):
            self.finish_cell()
        if tag == "tr":
            self.rows.append([])
        elif tag in ("td", "th"):
            if not self.rows:
                self.rows.append([])
            values = dict(attrs)
            self.cell = {
                "text": "",
                "rowspan": int(values.get("rowspan") or 1),
                "colspan": int(values.get("colspan") or 1),
                "header": tag == "th",
            }
            self.rows[-1].append(self.cell)
        elif tag == "br" and self.cell is not None:
            self.cell["text"] += "\n"

    def handle_endtag(self, tag):
        if tag in ("td", "th", "tr", "table"):
            self.finish_cell()

    def handle_data(self, data):
        if self.cell is not None:
            self.cell["text"] += data


def parsed_rows(html):
    parser = TableParser()
    parser.feed(html)
    parser.finish_cell()
    return [row for row in parser.rows if row]


def table_rows(html, inner=None):
    """Rows of cells from table HTML. `inner` is the words seen inside a printed line anywhere in the
    document (inner_words); by default, this table's own."""
    rows = even_rows(parsed_rows(html))
    inner = inner_words([html]) if inner is None else inner
    for row in rows:
        for cell in row:
            cell["text"] = reflowed(cell["text"], inner)
            if LIST_NUMBER.match(cell["text"]):
                cell["text"] = CELL_NUMBER.sub("\n", cell["text"])
    return rows


def with_colons(text):
    return LOOSE_VISARGA.sub(":", SPACED_VISARGA.sub("\u0983", text))


def is_bangla_page(elements):
    """Whether most of the letters on the page are Bangla."""
    text = " ".join(text_of(e) for e in elements)
    return len(BANGLA_LETTER.findall(text)) > len(LATIN_LETTER.findall(text))


def looks_handwritten(element):
    """On a Bangla page, a line beside a signature that is only a date, or a few Latin letters with
    no email or website, is the signer's hand the service read as text: a name, a date, a note."""
    text = text_of(element)
    if not text or element.get("type") in PICTURE_TYPES:
        return False
    if re.fullmatch(r"[০-৯\d]{1,2}[/.-][০-৯\d]{1,2}[/.-][০-৯\d]{2,4}", text):
        return True
    return (
        len(text) <= MAX_HANDWRITTEN_CHARS
        and not BANGLA_LETTER.search(text)
        and bool(LATIN_LETTER.search(text))
        and not CONTACT.search(text)
    )


def reflowed(text, inner=frozenset()):
    """A cell's text without the scan's line wrapping: a reader such as Surya writes a <br> at the
    end of every printed line, which in a Word column of another width breaks lines a word or two
    long. Lines are joined; a new line starts only at a list item (a), ১., ২)...). Where the paper
    wrapped a word without a hyphen, its two pieces join without a space (continues_word)."""
    lines = [line.strip() for line in text.split("\n") if line.strip()]
    joined = []
    for line in lines:
        if joined and not ITEM_START.match(line):
            joined[-1] += ("" if continues_word(joined[-1], line, inner) else " ") + line
        else:
            joined.append(line)
    return "\n".join(LONE_LATIN.sub(r"\1", LONE_CONSONANT.sub(r"\1", line)) for line in joined)


def word_pieces(token):
    return [piece.strip(WORD_EDGE) for piece in re.split(r"[/]", token) if piece.strip(WORD_EDGE)]


def inner_words(htmls):
    """Words seen inside a printed line (neither first nor last on it), in every table given: those
    are whole words, never the piece of a word the paper wrapped."""
    words = set()
    for html in htmls:
        for row in parsed_rows(html):
            for cell in row:
                for line in cell["text"].split("\n"):
                    for token in line.split()[1:-1]:
                        words.update(word_pieces(token))
    return words


def continues_word(before, after, inner):
    """Whether the line `after` goes on with the word that ends `before`: it starts with a vowel
    sign, virama, ড়/ঢ়/য়/ৎ or closing punctuation, which cannot start a word; the line breaks
    after a hyphen or slash (শিক্ষক-শিক্ষিকা, বাস/নৌকা); a known prefix (উপ|জেলা);
    the two pieces together are a word seen inside a line elsewhere; or the line starts with a
    short piece (up to MAX_WORD_END letters, not a short word such as ও or কি) in the same script,
    and neither piece is seen as a whole word inside a line (বাধ্যতামূল|ক, Interactiv|e)."""
    tail, head = before.split()[-1], after.split()[0]
    if after[0] in COMBINING or after.startswith(NEVER_FIRST) or after[0] in ")]};,:।":
        return True
    if (tail.endswith("-") or tail.endswith("/")) and len(tail) > 1:
        return True
    end, start = (word_pieces(tail) or [""])[-1], (word_pieces(head) or [""])[0]
    if not end or not start or end != tail.split("/")[-1].lstrip(WORD_EDGE) or start != head.split("/")[0].rstrip(WORD_EDGE):
        return False
    same_script = (BANGLA_PART.match(end[-1]) and BANGLA_PART.match(start[0])) or (
        LATIN_PART.match(end[-1]) and LATIN_PART.match(start[0]) and start[0].islower()
    )
    if not same_script:
        return False
    if end + start in inner or any(end == first and start.startswith(rest) for first, rest in JOINED_PREFIXES):
        return True
    return len(start) <= MAX_WORD_END and start not in SHORT_WORDS and end not in inner and start not in inner


def row_width(row):
    return sum(cell["colspan"] for cell in row)


def even_rows(rows):
    """A reader sometimes leaves out a row's empty last cell or adds one. In a table without row
    spans every row has its first row's width: a short row gets empty cells at its end, a long
    row loses empty cells from its end."""
    if not rows or any(cell["rowspan"] > 1 for row in rows for cell in row):
        return rows
    width = row_width(rows[0])
    evened = []
    for row in rows:
        row = list(row)
        while row_width(row) > width and row[-1]["colspan"] == 1 and not row[-1]["text"]:
            row.pop()
        row += [{"text": "", "rowspan": 1, "colspan": 1, "header": False} for _ in range(width - row_width(row))]
        evened.append(row)
    return evened


def text_of(element):
    return with_colons(element.get("text") or "").strip()


def is_memo(element):
    return bool(MEMO.search(text_of(element))) and len(text_of(element)) <= SHORT_LINE * 2


def is_date_label(element):
    return bool(DATE_LABEL.search(text_of(element))) and len(text_of(element)) <= SHORT_LINE


def is_short(element):
    return element.get("type") not in PICTURE_TYPES and 0 < len(text_of(element)) <= SHORT_LINE


def layout_box(element):
    """The element's box and page size as the service measured them, or None."""
    coordinates = (element.get("metadata") or {}).get("coordinates") or {}
    points = coordinates.get("points")
    if not points or not coordinates.get("layout_width"):
        return None
    xs, ys = [p[0] for p in points], [p[1] for p in points]
    return min(xs), min(ys), max(xs), max(ys), coordinates["layout_width"], coordinates.get("layout_height") or 1


def boxes_overlap(a, b):
    box_a, box_b = layout_box(a), layout_box(b)
    if not box_a or not box_b:
        return False
    return box_a[0] < box_b[2] and box_b[0] < box_a[2] and box_a[1] < box_b[3] and box_b[1] < box_a[3]


def squeeze(text):
    return re.sub(r"\s+", "", text)


def without_echoes(elements):
    """Drops a line the service returned twice: alone, and again inside a neighbour it overlaps.

    The same words elsewhere on the page are a real repeat, such as a date on two memo rows.
    """
    kept = []
    elements = list(elements)
    for index, element in enumerate(elements):
        text = squeeze(text_of(element))
        following = elements[index + 1] if index + 1 < len(elements) else None
        # Returned again as the first line of the next element: keep this one, cut that line.
        if following is not None and text and "\n" in text_of(following):
            first, rest = text_of(following).split("\n", 1)
            if squeeze(first) == text:
                elements[index + 1] = {**following, "text": rest}
                kept.append(element)
                continue
        neighbours = elements[max(index - 1, 0) : index] + elements[index + 1 : index + 2]
        echoed = "\n" not in text_of(element) and any(
            "\n" in text_of(other)
            and boxes_overlap(element, other)
            and text in (squeeze(line) for line in text_of(other).split("\n"))
            for other in neighbours
        )
        if not (text and echoed):
            kept.append(element)
    return kept


def split_element(element):
    """One element per block. The service often returns a list, or a whole signature, as one."""
    text = text_of(element)
    if element.get("type") not in TEXT_TYPES or "\n" not in text:
        if element.get("type") in TEXT_TYPES and LIST_NUMBER.match(text):
            return [{**element, "type": "ListItem"}]
        return [element]

    lines = [line.strip() for line in text.split("\n") if line.strip()]
    # Mostly short lines are separate lines, such as a letterhead; long ones are one wrapped paragraph.
    all_short = sum(len(line) <= SHORT_LINE for line in lines) * 2 > len(lines)
    blocks, paragraph, item = [], [], None

    def emit(kind, content):
        blocks.append({**element, "type": kind, "text": content})

    def flush():
        nonlocal paragraph, item
        if item is not None:
            emit("ListItem", " ".join(item))
        elif paragraph:
            emit("NarrativeText", " ".join(paragraph))
        paragraph, item = [], None

    for line in lines:
        if LIST_NUMBER.match(line):
            flush()
            item = [line]
        elif (MEMO.match(line) or DATE_LABEL.match(line)) and not paragraph:
            flush()
            emit("NarrativeText", line)
        elif item is not None:
            item.append(line)
        elif all_short:
            flush()
            emit("NarrativeText", line)
        else:
            paragraph.append(line)
    flush()
    box = layout_box(element)
    if len(blocks) > 1 and box and (box[2] - box[0]) / box[4] > SHARED_BOX_SHARE:
        # One wide box for several blocks says where none of them sits on its own; a narrow one,
        # such as a signature with its date, still puts all of them on its side of the page.
        blocks = [{**block, "_shared": True} for block in blocks]
    if all_short and len(blocks) == len(lines) > 1:
        # Remember which line each is, so its own type can be measured.
        blocks = [{**block, "_line": [index, len(lines)]} for index, block in enumerate(blocks)]
    return blocks


def line_elements(elements):
    """One element per printed line. A line returned with others in one box keeps its place in the
    box, so its own size can be measured there."""
    lines = []
    for element in elements:
        parts = [part.strip() for part in text_of(element).split("\n") if part.strip()]
        for index, part in enumerate(parts):
            place = element.get("_line") or ([index, len(parts)] if len(parts) > 1 else None)
            lines.append({**element, "text": part, "_line": place})
    return lines


def prepare(elements):
    elements = [e for e in elements if e.get("type") not in DROPPED_TYPES and not is_speck(e)]
    return [block for element in without_echoes(elements) for block in split_element(element)]


def is_page_number_line(element):
    """A line that is only a page number: at the page edge it is short and on the right, like the
    lines under a signature, but it never belongs to one."""
    return bool(PAGE_NUMBER.match(text_of(element)))


def is_speck(element):
    """A dot on the scan, returned as a picture."""
    box = layout_box(element)
    if element.get("type") not in PICTURE_TYPES or not box:
        return False
    x0, y0, x1, y1, width, height = box
    return (x1 - x0) * (y1 - y0) / (width * height) < MIN_PICTURE_SHARE


def is_centered(element):
    if element.get("_shared"):
        return False
    box = layout_box(element)
    return bool(box) and abs((box[0] + box[2]) / 2 / box[4] - 0.5) <= CENTER_TOLERANCE


def is_right_side(element):
    if element.get("_shared"):
        return False
    box = layout_box(element)
    return bool(box) and box[0] / box[4] >= RIGHT_SIDE_SHARE


def same_side(first, other):
    """Whether two lines sit on the same side of the page: the lines under a signature on the right
    do not run on into an addressee printed on the left. Lines with no position count as alike."""
    if not layout_box(first) or not layout_box(other):
        return True
    return is_right_side(first) == is_right_side(other)


def box_of(element, scan_size):
    """The element's box in the scan's pixels, or None when it has no position or no scan was given."""
    coordinates = (element.get("metadata") or {}).get("coordinates") or {}
    points = coordinates.get("points")
    if not points or not scan_size:
        return None
    x_scale = scan_size[0] / (coordinates.get("layout_width") or scan_size[0])
    y_scale = scan_size[1] / (coordinates.get("layout_height") or scan_size[1])
    xs, ys = [p[0] * x_scale for p in points], [p[1] * y_scale for p in points]
    return [round(min(xs)), round(min(ys)), round(max(xs)), round(max(ys))]


def is_landscape(box):
    return box[4] > box[5]


def page_size_cm(elements):
    """A4 as the scan has it: landscape when the page the service measured is wider than tall."""
    box = next((box for box in map(layout_box, elements) if box), None)
    if box and is_landscape(box):
        return A4_HEIGHT_CM, A4_WIDTH_CM
    return A4_WIDTH_CM, A4_HEIGHT_CM


def page_margins(elements):
    """The page's own margins, so lines wrap and blocks sit where the scan has them."""
    boxes = [box for box in map(layout_box, elements) if box]
    text = [box for box, e in zip(map(layout_box, elements), elements) if box and is_body(e)]
    if not boxes or not text:
        return dict(PAGE)
    width, height = page_size_cm(elements)
    left = min(b[0] / b[4] for b in text) * width
    right = min(1 - b[2] / b[4] for b in text) * width
    top = min(b[1] / b[5] for b in boxes) * height
    bottom = min(1 - b[3] / b[5] for b in boxes) * height
    clamp = lambda value, low, high: round(min(max(value, low), high), 2)  # noqa: E731
    return {"margins_cm": [
        clamp(top, MIN_TOP_MARGIN_CM, MAX_TOP_MARGIN_CM),
        clamp(right, MIN_SIDE_MARGIN_CM, MAX_SIDE_MARGIN_CM),
        clamp(bottom, MIN_BOTTOM_MARGIN_CM, MAX_BOTTOM_MARGIN_CM),
        clamp(left, MIN_SIDE_MARGIN_CM, MAX_SIDE_MARGIN_CM),
    ]}


def is_body(element):
    """Elements whose edges set the margins. A path in a footer or a picture does not."""
    return element.get("type") not in PICTURE_TYPES and element.get("type") != "Footer"


def line_height(elements):
    """The height of a single printed line on this page, from the elements that hold one."""
    heights, page = [], None
    for element in elements:
        box = layout_box(element)
        if box:
            page = box[5]
            if element.get("type") not in PICTURE_TYPES and text_of(element) and "\n" not in text_of(element):
                heights.append(box[3] - box[1])
    if heights:
        return sorted(heights)[len(heights) // 2]
    return page * DEFAULT_LINE_HEIGHT_SHARE if page else None


SIGNATURE_OVERLAP = 0.35


def above_printed(hand, printed, height, above=None):
    """The handwriting's box when each line has its own: from the top of the handwriting on the
    printed lines' side, or a few lines up when there is none, down to the first printed line. It
    never reaches above the line before the signature, or more than a few lines up: a handwritten
    line the service misplaced would otherwise pull in the text above."""
    boxes = [layout_box(p) for p in printed if layout_box(p)]
    x0, x1 = min(b[0] for b in boxes), max(b[2] for b in boxes)
    width, page_height = boxes[0][4], boxes[0][5]
    # Printed lines above the first placed one, such as a name run into the handwriting, sit a line
    # each above it.
    unplaced = next(index for index, p in enumerate(printed) if layout_box(p))
    top_of_print = boxes[0][1] - unplaced * (height or 0)
    reach = (x1 - x0) * 0.5
    beside = [
        b for b in map(layout_box, hand)
        if b and b[3] <= top_of_print + height and b[2] >= x0 - reach and b[0] <= x1 + reach
    ]
    top = min((b[1] for b in beside), default=top_of_print - SIGNATURE_LINES_ABOVE * (height or 0))
    top = max(top, top_of_print - MAX_SIGNATURE_LINES_ABOVE * (height or 0))
    ceiling = layout_box(above) if above else None
    page = (printed[0].get("metadata") or {}).get("page_number")
    limit = None
    if ceiling and ceiling[3] < top_of_print and (above.get("metadata") or {}).get("page_number") == page:
        top = max(top, ceiling[3])
        limit = ceiling[3]
    left, right = min([x0, *(b[0] for b in beside)]), max([x1, *(b[2] for b in beside)])
    return {
        "ceiling": limit,
        "page_number": page,
        "coordinates": {
            "points": [[left, top], [left, top_of_print], [right, top_of_print], [right, top]],
            "layout_width": width,
            "layout_height": page_height,
        },
    }


def signature_box(element, printed_lines, height):
    """The handwriting's box. The service's box for a signature block starts at the handwriting."""
    box = layout_box(element)
    if not box or not height:
        return None
    x0, y0, x1, y1, width, page_height = box
    # Handwriting runs down into the printed name, so stop part way into that line.
    bottom = y1 - printed_lines * height + SIGNATURE_OVERLAP * height
    if bottom <= y0:
        return None
    return {
        "page_number": (element.get("metadata") or {}).get("page_number"),
        "coordinates": {
            "points": [[x0, y0], [x0, bottom], [x1, bottom], [x1, y0]],
            "layout_width": width,
            "layout_height": page_height,
        },
    }


def start_page(block, box, previous_page, page, landscape):
    """A block on a new scan page starts a new Word page, or a new section when the page turns
    between portrait and landscape. Returns the orientation from here on."""
    turned = bool(box) and is_landscape(box)
    if previous_page is None or page is None or page == previous_page:
        return turned if box and landscape is None else landscape
    if box and landscape is not None and turned != landscape:
        block["section"] = {"landscape": turned}
    else:
        block["page_break"] = True
    return turned if box else landscape


def place_blocks(blocks, margins, body_line_height):
    """Sets each block's spacing, indent, alignment and size from where it sat on the page.

    Blocks stay ordinary paragraphs and tables, so the text still reflows when typed into. Elements
    returned as one box share its position, so only the first block of a box gets a gap. A block
    with no position still starts its page.
    """
    _, right_margin, _, left_margin = margins
    previous_box = None
    previous_page = None
    landscape = None
    for block in blocks:
        box = block.pop("_box", None)
        page = block.pop("_page", None)
        date_x = block.pop("_date_x", None)
        shared = block.pop("_shared", False)
        landscape = start_page(block, box, previous_page, page, landscape)
        if page is not None:
            previous_page = page
        if not box:
            previous_box = None
            continue
        x0, y0, x1, y1, width, _ = box
        page_width = A4_HEIGHT_CM if is_landscape(box) else A4_WIDTH_CM
        cm = page_width / width
        pt = cm * POINTS_PER_CM
        kind = block["type"]
        block["space_after"] = 0
        if previous_box and previous_box[6] == page and box != previous_box[:6]:
            block["space_before"] = round(min(max(y0 - previous_box[3], 0) * pt, MAX_GAP_PT), 1)
        elif previous_box and box == previous_box[:6]:
            block["space_before"] = 0

        share = (x1 - x0) / width
        centered = not shared and abs((x0 + x1) / 2 / width - 0.5) <= CENTER_TOLERANCE and share < CENTERED_MAX_WIDTH
        if kind in ("title", "heading") or (kind == "paragraph" and "align" not in block):
            short = len(block.get("text", "")) <= SHORT_LINE
            if centered and (kind != "paragraph" or short):
                block["align"] = "center"
            elif kind == "title" or short:
                block["align"] = "left"
        if kind in ("title", "heading") and body_line_height:
            ratio = (y1 - y0) / body_line_height
            if ratio >= LARGE_TYPE_RATIO:
                block["size"] = round(min(FONT["size"] * ratio, MAX_TITLE_SIZE), 1)
        left = x0 * cm - left_margin
        right = page_width - right_margin - x1 * cm
        if not shared and block.get("align") != "center" and kind in ("paragraph", "heading", "title", "list"):
            if left >= MIN_INDENT_CM:
                block["left_indent_cm"] = round(left, 2)
            if kind == "paragraph" and right >= MIN_INDENT_CM * 2 and len(block.get("text", "")) > SHORT_LINE:
                block["right_indent_cm"] = round(right, 2)
        if kind == "signature":
            block["left_cm"] = round(max(left, 0), 2)
            block["width_cm"] = round(max((x1 - x0) * cm, MIN_SIGNATURE_BLOCK_CM), 2)
        if kind == "memo" and date_x is not None:
            block["right_width_cm"] = round(max(page_width - right_margin - date_x * page_width, MIN_DATE_CM), 2)
        previous_box = (*box, page)


class SpecBuilder:
    def __init__(self, elements, scan_size, crops_dir):
        self.source = elements
        self.elements = prepare(elements)
        self.line_height = line_height(elements)
        self.scan_size = scan_size
        self.crops_dir = crops_dir
        self.blocks = []
        self.crops = []
        self.signatures = 0
        self.index = 0
        self.bangla = is_bangla_page(self.elements)
        self.inner = inner_words(
            [(e.get("metadata") or {}).get("text_as_html") for e in elements if (e.get("metadata") or {}).get("text_as_html")]
        )

    def add(self, block, *elements):
        """Adds a block, remembering where its elements sat so place_blocks can measure from them."""
        if block["type"] in TYPE_MEASURED and elements:
            self.type_mark(block, *elements)
        if any(element.get("_shared") for element in elements):
            block["_shared"] = True
        boxes = [box for box in map(layout_box, elements) if box]
        if elements:
            block["_page"] = int((elements[0].get("metadata") or {}).get("page_number") or 1)
        if boxes:
            block["_box"] = (
                min(b[0] for b in boxes),
                min(b[1] for b in boxes),
                max(b[2] for b in boxes),
                max(b[3] for b in boxes),
                boxes[0][4],
                boxes[0][5],
            )
        self.blocks.append(block)

    def scan_size_of(self, element):
        """The scan's size for the element's page: one size, or a size per page number."""
        if not isinstance(self.scan_size, dict):
            return self.scan_size
        return self.scan_size.get(int((element.get("metadata") or {}).get("page_number") or 1))

    def type_mark(self, target, *elements):
        """Notes where the text sat on the scan, so its size and weight can be measured there. A line
        sharing a wide box with others, and with no place in it, has nothing of its own to measure."""
        if any(e.get("_shared") and not e.get("_line") for e in elements):
            return target
        boxes = [box for box in (box_of(e, self.scan_size_of(e)) for e in elements) if box]
        if boxes:
            target["type_box"] = [min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)]
            target["type_page"] = int((elements[0].get("metadata") or {}).get("page_number") or 1)
            if len(elements) == 1 and elements[0].get("_line"):
                target["type_line"] = elements[0]["_line"]
        return target

    def crop(self, name, element):
        metadata = element.get("metadata") or {}
        box = box_of(element, self.scan_size_of(element))
        page = int(metadata.get("page_number") or 1)
        crop = {"name": name, "box": box, "page": page}
        if metadata.get("ceiling") is not None and box:
            # How high the crop may grow: the bottom of the line above, in the scan's pixels.
            scan_height = self.scan_size_of(element)[1]
            crop["ceiling"] = round(metadata["ceiling"] * scan_height / metadata["coordinates"]["layout_height"])
        self.crops.append(crop)
        return f"{self.crops_dir}/{name}.png"

    def letterhead(self):
        """Everything above the first memo row, else the run of titles before the document's title."""
        memo_at = next(
            (i for i, e in enumerate(self.elements[:HEAD_SEARCH]) if is_memo(e) or is_date_label(e)),
            None,
        )
        if memo_at is not None:
            run = self.elements[:memo_at]
        else:
            run = []
            for element in self.elements:
                if element.get("type") not in ("Title", "Header") and element.get("type") not in PICTURE_TYPES:
                    break
                run.append(element)
            run = run[:-1] if len(run) >= 2 else []
        texts = [e for e in run if e.get("type") not in PICTURE_TYPES and text_of(e)]
        pictures = [e for e in run if e.get("type") in PICTURE_TYPES]
        if texts or pictures:
            block = {"type": "letterhead", "lines": [], "logo_width_cm": LOGO_WIDTH_CM}
            for index, element in enumerate(line_elements(texts)):
                line = {"text": text_of(element), "size": 14 if index == 0 else 11, "bold": index == 0}
                block["lines"].append(self.type_mark(line, element))
            if pictures:
                block["logo"] = self.crop("logo", pictures[0])
            self.add(block, *run)
        self.index = len(run)

    def memo(self):
        """A memo row: the number on the left, the date on the right, in one element or several."""
        left, right, used, date_box = "", [], [], None
        while self.index < len(self.elements):
            element = self.elements[self.index]
            text = text_of(element)
            if not left and is_memo(element):
                match = DATE_INSIDE.search(text)
                left = text[: match.start()].strip() if match else text
                if match:
                    right.append(text[match.start() :].strip())
            elif is_date_label(element) or (right and DATE_ONLY.match(text)):
                # The service can return a second, cut-off read of the same date.
                if not any(line.startswith(text) for line in right):
                    right.append(text)
                date_box = date_box or layout_box(element)
            else:
                break
            used.append(element)
            self.index += 1
        if left or right:
            block = {"type": "memo", "left": left, "right": right, "right_width_cm": 5, "space_after": 0}
            if date_box:
                block["_date_x"] = date_box[0] / date_box[4]
            self.add(block, *used[:1])
            return True
        return False

    def signature(self, element=None):
        """A signature and the short printed lines under it. The line just above is its intro.

        The service often returns no picture for the handwriting, so the crop may need a box. On a
        Bangla page it can also return the handwriting as text; those lines go into the crop.
        """
        self.signatures += 1
        block = {"type": "signature", "image": "", "image_width_cm": SIGNATURE_WIDTH_CM, "lines": []}
        above = self.elements[self.index - 1] if self.index > 0 else None
        hand = self.handwriting()
        first = self.elements[self.index] if self.index < len(self.elements) else {}
        previous = self.blocks[-1] if self.blocks else None
        if previous and previous.get("type") == "paragraph" and len(previous["text"]) <= SHORT_LINE:
            block["intro"] = self.blocks.pop()["text"]
        printed = []
        while (
            self.index < len(self.elements)
            and len(block["lines"]) < MAX_SIGNATURE_LINES
            and self.elements[self.index].get("type") in ("NarrativeText", "UncategorizedText")
            and is_short(self.elements[self.index])
            and not is_page_number_line(self.elements[self.index])
            and not is_memo(self.elements[self.index])
            and not is_date_label(self.elements[self.index])
            and (
                same_side(first, self.elements[self.index])
                or (self.bangla and looks_handwritten(self.elements[self.index]))
            )
        ):
            current = self.elements[self.index]
            line = text_of(current)
            self.index += 1
            if self.bangla and looks_handwritten(current):
                if len(printed) == 1 and not hand and "intro" not in block:
                    # The line above the handwriting introduces the signature.
                    block["intro"] = block["lines"].pop()
                    above = printed.pop()
                hand.append(current)
                continue
            # A handwritten date beside the signature is inside its crop already.
            if not (HANDWRITTEN_DATE.search(line) and not block["lines"]):
                block["lines"].append(line)
                printed.append(current)
        if element is not None:
            source = element
        elif printed and all(p.get("metadata") is not first.get("metadata") for p in printed[1:]) and (
            hand or len(printed) > 1
        ) and any(layout_box(p) for p in printed):
            source = {"metadata": above_printed(hand, printed, self.line_height, above)}
        else:
            count = len(block["lines"]) + sum(
                1
                for following in self.elements[self.index :]
                if following.get("metadata") is first.get("metadata") and is_date_label(following)
            )
            source = {"metadata": signature_box(first, count, self.line_height) or {}}
        block["image"] = self.crop(f"sig{self.signatures}", source)
        self.add(block, element if element is not None else (printed[0] if printed else first))

    def handwriting(self):
        """The handwritten lines, read as text, that start a signature on a Bangla page."""
        hand = []
        while self.bangla and self.index < len(self.elements) and looks_handwritten(self.elements[self.index]):
            hand.append(self.elements[self.index])
            self.index += 1
        return hand

    def picture(self, element, position):
        """A picture low on the page beside text is a signature; anything else stays a picture."""
        following = self.elements[position + 1] if position + 1 < len(self.elements) else None
        if following is not None and is_short(following):
            self.signature(element)
            return
        self.add({"type": "image", "path": self.crop(f"image{position}", element)}, element)

    def list_items(self):
        items, boxes = [], []
        first = self.elements[self.index]
        while self.index < len(self.elements) and self.elements[self.index].get("type") == "ListItem":
            element = self.elements[self.index]
            text = text_of(element)
            match = LIST_NUMBER.match(text)
            items.append([match.group(1).strip(), match.group(2).strip()] if match else ["•", text])
            boxes.append(self.type_mark({}, element))
            self.index += 1
        block = {"type": "list", "items": items, "hanging_cm": 0.7}
        if any(boxes):
            block["item_boxes"] = boxes
        self.add(block, first)

    def body(self):
        titled = any(block["type"] == "title" for block in self.blocks)
        while self.index < len(self.elements):
            position = self.index
            element = self.elements[position]
            kind = element.get("type")
            text = text_of(element)
            if kind == "ListItem":
                self.list_items()
                continue
            if text and (is_memo(element) or is_date_label(element)) and self.memo():
                continue
            if kind in ("NarrativeText", "UncategorizedText") and is_short(element) and not is_page_number_line(element) and (
                is_right_side(element) or (self.bangla and looks_handwritten(element))
            ):
                self.signature()
                continue
            self.index += 1
            if kind in PICTURE_TYPES:
                self.picture(element, position)
            elif kind == "Table":
                html = (element.get("metadata") or {}).get("text_as_html")
                rows = table_rows(html, self.inner) if html else []
                block = {"type": "table", "rows": rows} if rows else {"type": "paragraph", "text": text}
                box = box_of(element, self.scan_size_of(element))
                if rows and box:
                    block["box"] = box
                    block["box_page"] = int((element.get("metadata") or {}).get("page_number") or 1)
                self.add(block, element)
            elif not text:
                continue
            elif kind == "Title" and not titled:
                self.add({"type": "title", "text": text}, element)
                titled = True
            elif kind == "Title":
                block = {"type": "heading", "text": text, "bold": True}
                if is_centered(element):
                    block["align"] = "center"
                self.add(block, element)
            elif kind in ("Header", "Footer"):
                # A running head repeats on every page; the first is enough.
                if not any(block.get("text") == text for block in self.blocks):
                    block = {"type": "paragraph", "text": text, "size": 9, "align": "left"}
                    if is_centered(element):
                        block["align"] = "center"
                    self.add(block, element)
            else:
                self.add({"type": "paragraph", "text": text}, element)

    def build(self):
        self.letterhead()
        self.memo()
        self.body()
        pages = [int((e.get("metadata") or {}).get("page_number") or 1) for e in self.source] or [1]
        page = page_margins(self.source)
        page_width, _ = page_size_cm(self.source)
        if page_width > A4_WIDTH_CM:
            page["landscape"] = True
        place_blocks(self.blocks, page["margins_cm"], self.line_height)
        return {"pages": max(pages), "page": page, "font": FONT, "blocks": self.blocks}


def memo_warnings(spec):
    """Memo rows on one page normally share a number, so a difference means one was misread."""
    numbers = [re.sub(r"\s+", "", b.get("left", "")) for b in spec["blocks"] if b["type"] == "memo"]
    stems = [re.sub(r"\(.*\)$", "", number) for number in numbers if number]
    if len(set(stems)) <= 1:
        return []
    return [
        "memo numbers differ, tell the user to check them: " + " / ".join(stems)
    ]


def image_size(path):
    from PIL import Image

    with Image.open(path) as image:
        return image.size


def convert(elements, scan_size=None, crops_dir=DEFAULT_CROPS):
    builder = SpecBuilder(elements, scan_size, crops_dir)
    return builder.build(), builder.crops


def main(argv):
    parser = argparse.ArgumentParser(description="Turn read_document's elements into a letter.py spec.")
    parser.add_argument("elements")
    parser.add_argument("spec")
    parser.add_argument("--scan", help="the page image, to turn element positions into crop boxes")
    parser.add_argument("--crops", default=DEFAULT_CROPS, help="where crop.py writes the pictures")
    args = parser.parse_args(argv)

    elements = json.loads(Path(args.elements).read_text(encoding="utf-8"))
    spec, crops = convert(elements, image_size(args.scan) if args.scan else None, args.crops)
    Path(args.spec).write_text(json.dumps(spec, ensure_ascii=False, indent=1), encoding="utf-8")

    kinds = {}
    for block in spec["blocks"]:
        kinds[block["type"]] = kinds.get(block["type"], 0) + 1
    print(f"spec: {args.spec}")
    print(f"pages: {spec['pages']}")
    print("check against the page: memo numbers and anything handwritten; the service can misread those")
    for warning in memo_warnings(spec):
        print(warning)
    print("blocks: " + ", ".join(f"{count} {kind}" for kind, count in kinds.items()))
    for crop in crops:
        box = ",".join(str(value) for value in crop["box"]) if crop["box"] else "(box needed)"
        print(f"crop: {crop['name']} {box}")
    if not crops:
        print("crop: none")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
