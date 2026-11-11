"""Build a deck on a designed theme from a short JSON spec, then run check.py on it.

    python3 deck.py spec.json /mnt/data/deck.pptx [--themes DIR] [--no-check]
    python3 deck.py --list [--themes DIR]

The spec names a theme and lists slides. Each slide picks one of the theme's layouts, gives a
title, and at most one content block:

    {"theme": "Candy", "slides": [
      {"layout": "cover", "title": "...", "subtitle": "..."},
      {"layout": "content", "title": "...", "bullets": ["...", "..."], "source": "..."}]}

    "bullets": ["...", ...]                        bulleted points in the layout's body
    "text": "..."                                  one paragraph in the body
    "cards": [["Heading", "Detail"], ...]          2-4 peers side by side
    "stats": [["৳2.5 cr", "Budget, up 12%"], ...]  2-4 headline figures with their comparison
    "steps": [["Heading", "Detail"], ...]          3-5 ordered steps
    "chart": {"type": "bar", "labels": [...], "series": [{"name": "...", "values": [...]}],
              "highlight": 2}                      bar, column, line, pie, doughnut or stacked
    "table": [["Header", ...], ["cell", ...]]      first row is the header
    "quote": "...", "by": "..."
    "image": "/mnt/data/photo.jpg"                 alone, or beside bullets or text

Any content slide may add "takeaway" (the conclusion, in a band under the block), "source"
and "notes". Cover, section and closing layouts take "title" and "subtitle" only.

Text is fitted by shrinking to a floor. When it still does not fit, or a block does not suit
its layout, nothing is written: the script prints one line per problem and exits 2. Shorten
or split those slides and run it again.
"""

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

from lxml import etree
from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.dml.color import RGBColor
from pptx.enum.chart import XL_CHART_TYPE, XL_LABEL_POSITION, XL_LEGEND_POSITION
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, MSO_AUTO_SIZE, PP_ALIGN
from pptx.oxml.ns import qn
from pptx.util import Inches, Pt

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))
from check_layout import resolve_font, text_width_emu  # noqa: E402
from infographic import Library, fill_all, place, remove as remove_elements  # noqa: E402

THEMES = SCRIPTS.parent / "themes"
BANGLA = re.compile(r"[\u0980-\u09F1\u09F4-\u09FF]")
"""Bangla letters and digits; the taka and rupee signs are left out because they sit in Latin text."""
BLOCKS = ("bullets", "text", "cards", "stats", "steps", "chart", "table", "quote", "infographic")
TITLE_SIZES = {"cover": (40, 28), "section": (36, 26), "closing": (36, 26), "content": (30, 22)}
SUBTITLE_SIZE = (20, 14)
BODY_SIZE = (20, 14)
GAP = Inches(0.25)
SOURCE_HEIGHT = Inches(0.35)
TAKEAWAY_HEIGHT = Inches(0.75)
DARK_TEXT, DARK_MUTED = "FFFFFF", "E6E6E6"
GREY = "B0B0B0"
"""Nikosh draws about 15% smaller than Latin fonts at the same point size."""
BANGLA_SCALE = 1.15
NO_GRID_TABLE = "{2D5ABB26-0587-4C30-8999-92F81FD0307C}"
CHART_TYPES = {
    "bar": XL_CHART_TYPE.BAR_CLUSTERED,
    "column": XL_CHART_TYPE.COLUMN_CLUSTERED,
    "stacked": XL_CHART_TYPE.COLUMN_STACKED,
    "line": XL_CHART_TYPE.LINE_MARKERS,
    "pie": XL_CHART_TYPE.PIE,
    "doughnut": XL_CHART_TYPE.DOUGHNUT,
}
LIMITS = {"cards": (2, 4), "stats": (2, 4), "steps": (3, 5)}


class SpecError(Exception):
    pass


class Box:
    def __init__(self, x, y, w, h):
        self.x, self.y, self.w, self.h = int(x), int(y), int(w), int(h)

    @classmethod
    def inches(cls, values):
        return cls(*(Inches(v) for v in values))

    def inset(self, amount):
        return Box(self.x + amount, self.y + amount, self.w - 2 * amount, self.h - 2 * amount)

    def take_bottom(self, height):
        """Split off a strip of `height` at the bottom; returns (rest, strip)."""
        return Box(self.x, self.y, self.w, self.h - height - GAP), Box(self.x, self.y + self.h - height, self.w, height)

    def columns(self, count, gap=GAP):
        width = (self.w - gap * (count - 1)) / count
        return [Box(self.x + i * (width + gap), self.y, width, self.h) for i in range(count)]

    def rows(self, count, gap=GAP):
        height = (self.h - gap * (count - 1)) / count
        return [Box(self.x, self.y + i * (height + gap), self.w, height) for i in range(count)]


class Style:
    """Colours and fonts for one slide: the theme's, flipped for dark layouts."""

    def __init__(self, theme, layout):
        colors = theme["colors"]
        self.dark = layout.get("dark", False)
        self.latin = theme["fonts"]["latin"]
        self.bangla = theme["fonts"]["bangla"]
        self.ink = DARK_TEXT if self.dark else colors["ink"]
        self.muted = DARK_MUTED if self.dark else colors["muted"]
        self.emphasis = DARK_TEXT if self.dark else colors["emphasis"]
        self.card = layout.get("card", "FFFFFF" if self.dark else colors["tint"])
        self.card_text = colors["ink"] if self.dark or "card" in layout else self.ink
        self.card_head = colors["emphasis"] if self.dark or "card" in layout else self.emphasis
        self.primary = colors["primary"]
        self.band = "FFFFFF" if self.dark else colors["emphasis"]
        self.band_text = colors["ink"] if self.dark else "FFFFFF"
        self.chart = colors["chart"]
        self.accent = colors["accent"]


def has_bangla(text):
    return bool(BANGLA.search(text))


def scaled(size, text):
    return size * BANGLA_SCALE if has_bangla(text) else size


def line_count(text, width, size, bold, style):
    """Lines the text wraps to; a word wider than the box counts as never fitting, since it would break mid-word."""
    lines, current = 1, 0
    for word in text.split():
        bangla = has_bangla(word)
        font = resolve_font(style.bangla if bangla else style.latin, bold, False)
        word_width = text_width_emu(word + " ", font, size * BANGLA_SCALE if bangla else size)
        if word_width > width * 1.08:
            return 10_000
        if current and current + word_width > width:
            lines += 1
            current = word_width
        else:
            current += word_width
    return lines


def text_height(paragraphs, width, size, bold, style):
    lines = sum(line_count(p, width, size, bold, style) * scaled(size, p) * (1.3 if has_bangla(p) else 1.2) for p in paragraphs)
    gaps = (len(paragraphs) - 1) * size * 0.4
    return Pt(lines + gaps)


def fit(paragraphs, box, sizes, style, bold=False, indent=0):
    """Largest size from sizes=(start, floor) at which the paragraphs fit the box, else None."""
    start, floor = sizes
    for size in range(start, floor - 1, -1):
        if text_height(paragraphs, box.w - indent, size, bold, style) <= box.h:
            return size
    return None


def style_run(run, text, size, color, style, bold=False, italic=False):
    run.text = text
    font = run.font
    font.size, font.bold, font.italic = Pt(round(scaled(size, text))), bold, italic
    font.color.rgb = RGBColor.from_string(color)
    font.name = style.latin
    add_bangla_font(run._r.get_or_add_rPr(), style.bangla, has_bangla(text))


def add_bangla_font(rpr, typeface, bangla):
    if bangla:
        rpr.set("lang", "bn-BD")
    if rpr.find(qn("a:cs")) is not None:
        return
    anchor = rpr.find(qn("a:ea"))
    anchor = anchor if anchor is not None else rpr.find(qn("a:latin"))
    cs = etree.Element(qn("a:cs"), typeface=typeface)
    if anchor is None:
        rpr.append(cs)
    else:
        anchor.addnext(cs)


def write(frame, paragraphs, size, color, style, bold=False, italic=False, align=None, anchor=None, bullet=None):
    frame.clear()
    frame.word_wrap = True
    frame.auto_size = MSO_AUTO_SIZE.NONE
    if anchor is not None:
        frame.vertical_anchor = anchor
    for number, text in enumerate(paragraphs):
        paragraph = frame.paragraphs[0] if number == 0 else frame.add_paragraph()
        if align is not None:
            paragraph.alignment = align
        if number:
            paragraph.space_before = Pt(size * 0.4)
        set_bullet(paragraph, bullet, size)
        style_run(paragraph.add_run(), text, size, color, style, bold, italic)


def textbox(slide, box, paragraphs, size, color, style, **options):
    shape = slide.shapes.add_textbox(box.x, box.y, box.w, box.h)
    frame = shape.text_frame
    frame.margin_left = frame.margin_right = frame.margin_top = frame.margin_bottom = 0
    write(frame, paragraphs, size, color, style, **options)
    return shape


def panel(slide, box, color, shape_type=MSO_SHAPE.ROUNDED_RECTANGLE):
    shape = slide.shapes.add_shape(shape_type, box.x, box.y, box.w, box.h)
    shape.fill.solid()
    shape.fill.fore_color.rgb = RGBColor.from_string(color)
    shape.line.fill.background()
    shape.shadow.inherit = False
    if shape_type == MSO_SHAPE.ROUNDED_RECTANGLE:
        shape.adjustments[0] = min(0.5, Inches(0.12) / max(1, min(box.w, box.h)))
    return shape


def placeholder_box(shape):
    return Box(shape.left, shape.top, shape.width, shape.height)


def frame_box(shape):
    frame = shape.text_frame
    inset = Inches(0.1)
    left = frame.margin_left if frame.margin_left is not None else inset
    right = frame.margin_right if frame.margin_right is not None else inset
    top = frame.margin_top if frame.margin_top is not None else Inches(0.05)
    bottom = frame.margin_bottom if frame.margin_bottom is not None else Inches(0.05)
    return Box(shape.left + left, shape.top + top, shape.width - left - right, shape.height - top - bottom)


def remove(shape):
    shape._element.getparent().remove(shape._element)


class Builder:
    def __init__(self, theme, themes_dir, library=None):
        self.theme = theme
        self.presentation = Presentation(themes_dir / theme["file"])
        self.layouts = {layout.name: layout for master in self.presentation.slide_masters for layout in master.slide_layouts}
        self.problems = []
        self.library = Library(library) if library else Library()
        self.used = set()
        self.title = ""

    def problem(self, number, message):
        self.problems.append(f"slide {number}: {message}")

    def build(self, slides):
        self.title = str(slides[0].get("title", "")) if slides else ""
        for number, spec in enumerate(slides, 1):
            try:
                self.slide(number, spec)
            except SpecError as error:
                self.problem(number, str(error))

    def slide(self, number, spec):
        name = spec.get("layout")
        if name not in self.theme["layouts"] or name not in self.layouts:
            raise SpecError(f"no layout {name!r} in {self.theme['name']}; use one of: {', '.join(self.theme['layouts'])}")
        layout = self.theme["layouts"][name]
        role = layout.get("role", "content")
        style = Style(self.theme, layout)
        blocks = [key for key in BLOCKS if key in spec]
        if role != "content" and (blocks or "image" in spec):
            raise SpecError(f"{name} is a {role} layout: give it title and subtitle only, and put {blocks[0] if blocks else 'image'} on a content slide")
        if len(blocks) > 1:
            raise SpecError(f"one content block per slide, not {' and '.join(blocks)}: split it into two slides")
        slide = self.presentation.slides.add_slide(self.layouts[name])
        title = slide.shapes.title
        body = next((shape for shape in slide.placeholders if shape.placeholder_format.idx == 1), None)
        for shape in list(slide.placeholders):
            if shape not in (title, body):
                remove(shape)
        if title is not None:
            self.fill(title, [spec.get("title", "")], TITLE_SIZES[role], style.ink, style, number, "title")
        if spec.get("notes"):
            slide.notes_slide.notes_text_frame.text = spec["notes"]
        if role != "content":
            self.subtitle(number, spec, body, style)
            return
        area = placeholder_box(body) if body is not None else Box(Inches(0.67), Inches(1.75), Inches(12), Inches(4.8))
        if spec.get("source"):
            area, strip = area.take_bottom(SOURCE_HEIGHT)
            textbox(slide, strip, [spec["source"]], 11, style.muted, style, anchor=MSO_ANCHOR.BOTTOM)
        if spec.get("takeaway"):
            area, strip = area.take_bottom(TAKEAWAY_HEIGHT)
            self.takeaway(slide, strip, spec["takeaway"], style, number)
        block = blocks[0] if blocks else None
        if block in ("bullets", "text"):
            self.body_text(slide, number, spec, block, body, area, layout, style)
            return
        if body is not None:
            remove(body)
        if "image" in spec:
            self.image(slide, number, spec["image"], layout, area)
            if block is not None:
                raise SpecError("an image can sit beside bullets or text only; put the other block on its own slide")
            return
        if block is None:
            raise SpecError("a content slide needs one of: " + ", ".join(BLOCKS) + ", or image")
        getattr(self, block)(slide, number, spec, area, layout, style)

    def fill(self, shape, paragraphs, sizes, color, style, number, what, bold=False):
        box = frame_box(shape)
        size = fit(paragraphs, box, sizes, style, bold)
        if size is None:
            raise SpecError(f"{what} is too long for the {box.w / 914400:.1f}\" x {box.h / 914400:.1f}\" box even at {sizes[1]}pt: shorten it")
        write(shape.text_frame, paragraphs, size, color, style, bold)
        for paragraph in shape.text_frame.paragraphs:
            set_bullet(paragraph, None, size)

    def subtitle(self, number, spec, body, style):
        if body is None:
            return
        if not spec.get("subtitle"):
            remove(body)
            return
        self.fill(body, [spec["subtitle"]], SUBTITLE_SIZE, style.muted if not style.dark else style.ink, style, number, "subtitle")

    def body_text(self, slide, number, spec, block, body, area, layout, style):
        paragraphs = spec["bullets"] if block == "bullets" else [spec["text"]]
        if not paragraphs or not all(isinstance(p, str) and p.strip() for p in paragraphs):
            raise SpecError(f"{block} must be non-empty text")
        if "image" in spec:
            picture = layout.get("picture")
            if picture is None:
                left, right = area.columns(2)
                self.place_image(slide, spec["image"], right)
                area = left
            else:
                self.place_image(slide, spec["image"], Box.inches(picture))
        if body is None:
            body = slide.shapes.add_textbox(area.x, area.y, area.w, area.h)
        body.left, body.top, body.width, body.height = area.x, area.y, area.w, area.h
        box = frame_box(body)
        size = fit(paragraphs, box, BODY_SIZE, style, indent=int(Pt(BODY_SIZE[0] * 1.2)) if block == "bullets" else 0)
        if size is None:
            raise SpecError(f"{block} need more room than the body has even at {BODY_SIZE[1]}pt: cut them or split the slide")
        write(body.text_frame, paragraphs, size, style.ink, style, bullet=style.emphasis if block == "bullets" else None)

    def image(self, slide, number, path, layout, area):
        picture = layout.get("picture")
        self.place_image(slide, path, Box.inches(picture) if picture else area)

    def place_image(self, slide, path, box):
        from PIL import Image

        if not Path(path).is_file():
            raise SpecError(f"no image at {path}")
        with Image.open(path) as image:
            width, height = image.size
        picture = slide.shapes.add_picture(str(path), box.x, box.y, box.w, box.h)
        source, target = width / height, box.w / box.h
        if source > target:
            trim = (1 - target / source) / 2
            picture.crop_left = picture.crop_right = trim
        elif source < target:
            trim = (1 - source / target) / 2
            picture.crop_top = picture.crop_bottom = trim

    def pairs(self, number, spec, block):
        items = spec[block]
        low, high = LIMITS[block]
        if not isinstance(items, list) or not low <= len(items) <= high:
            raise SpecError(f"{block} takes {low}-{high} items, got {len(items) if isinstance(items, list) else 'none'}")
        if not all(isinstance(item, list) and len(item) == 2 for item in items):
            raise SpecError(f'each of {block} is ["heading", "detail"]')
        return items

    def cards(self, slide, number, spec, area, layout, style):
        items = self.pairs(number, spec, "cards")
        columns = layout.get("columns")
        if columns and len(columns) == len(items):
            self.texts_in(slide, number, items, [Box.inches(c).inset(Inches(0.2)) for c in columns], layout.get("columns_text", style.ink), layout.get("columns_text", style.emphasis), style)
            return
        if columns:
            raise SpecError(f"{len(columns)} cards fill this layout's columns; give {len(columns)} or pick another layout")
        boxes = area.columns(len(items))
        for box in boxes:
            panel(slide, box, style.card)
        self.texts_in(slide, number, items, [box.inset(Inches(0.2)) for box in boxes], style.card_text, style.card_head, style)

    def texts_in(self, slide, number, items, boxes, text, head, style):
        heads = [item[0] for item in items]
        width = min(box.w for box in boxes)
        head_size = min((fit([h], Box(0, 0, width, Inches(1.0)), (22, 14), style, True) or 0) for h in heads)
        if not head_size:
            raise SpecError("a card heading needs more than two lines: shorten the headings")
        head_height = max(text_height([h], width, head_size, True, style) for h in heads) + Inches(0.15)
        detail_sizes = [fit([item[1]], Box(0, 0, box.w, box.h - head_height), (20, 13), style) for item, box in zip(items, boxes)]
        if None in detail_sizes:
            raise SpecError(f"card {detail_sizes.index(None) + 1}'s detail does not fit: cut it, or use fewer cards")
        detail_size = min(detail_sizes)
        for (heading, detail), box in zip(items, boxes):
            textbox(slide, Box(box.x, box.y, box.w, head_height), [heading], head_size, head, style, bold=True)
            textbox(slide, Box(box.x, box.y + head_height, box.w, box.h - head_height), [detail], detail_size, text, style)

    def stats(self, slide, number, spec, area, layout, style):
        items = self.pairs(number, spec, "stats")
        boxes = area.columns(len(items))
        height = min(area.h, Inches(2.6))
        boxes = [Box(box.x, area.y + (area.h - height) / 2, box.w, height) for box in boxes]
        inner = [box.inset(Inches(0.2)) for box in boxes]
        width = min(box.w for box in inner)
        value_size = min(fit([value], Box(0, 0, width, Inches(1.0)), (44, 26), style, True) or 0 for value, _ in items)
        if not value_size:
            raise SpecError("a figure is too wide for its column: shorten it (~৳2.5 cr, not ৳2,48,73,921)")
        label_size = [fit([label], Box(0, 0, width, box.h - Inches(1.1)), (18, 12), style) for (_, label), box in zip(items, inner)]
        if None in label_size:
            raise SpecError("a stat label is too long: keep it to the comparison (\"up 12% on 2025\")")
        for (value, label), box in zip(items, inner):
            panel(slide, Box(box.x - Inches(0.2), box.y - Inches(0.2), box.w + Inches(0.4), box.h + Inches(0.4)), style.card)
            textbox(slide, Box(box.x, box.y, box.w, Inches(1.0)), [value], value_size, style.card_head, style, bold=True)
            textbox(slide, Box(box.x, box.y + Inches(1.1), box.w, box.h - Inches(1.1)), [label], min(label_size), style.card_text, style)

    def steps(self, slide, number, spec, area, layout, style):
        items = self.pairs(number, spec, "steps")
        rows = area.rows(len(items), gap=Inches(0.15))
        circle = min(Inches(0.5), rows[0].h)
        text_x = area.x + circle + Inches(0.25)
        width = area.w - circle - Inches(0.25)
        sizes = []
        for heading, detail in items:
            for size in range(20, 12, -1):
                needed = text_height([heading], width, size, True, style) + text_height([detail], width, size - 1, False, style)
                if needed <= rows[0].h:
                    sizes.append(size)
                    break
            else:
                raise SpecError(f"step {len(sizes) + 1} is too long for {len(items)} rows: cut it or use fewer steps")
        size = min(sizes)
        for index, ((heading, detail), row) in enumerate(zip(items, rows), 1):
            dot = panel(slide, Box(area.x, row.y, circle, circle), style.primary if not style.dark else "FFFFFF", MSO_SHAPE.OVAL)
            write(dot.text_frame, [str(index)], 16, "FFFFFF" if not style.dark else style.primary, style, bold=True, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
            head_height = text_height([heading], width, size, True, style)
            textbox(slide, Box(text_x, row.y, width, head_height), [heading], size, style.ink, style, bold=True)
            textbox(slide, Box(text_x, row.y + head_height, width, row.h - head_height), [detail], size - 1, style.muted, style)

    def quote(self, slide, number, spec, area, layout, style):
        lines = [spec["quote"]]
        by = spec.get("by")
        quote_box = Box(area.x, area.y, area.w, area.h - (Inches(0.6) if by else 0))
        size = fit(lines, quote_box, (28, 18), style)
        if size is None:
            raise SpecError("the quote is too long for this layout: quote the key sentence only")
        textbox(slide, quote_box, lines, size, style.ink, style, italic=True, anchor=MSO_ANCHOR.MIDDLE)
        if by:
            textbox(slide, Box(area.x, area.y + area.h - Inches(0.5), area.w, Inches(0.5)), [f"— {by}"], 16, style.muted, style)

    def table(self, slide, number, spec, area, layout, style):
        rows = spec["table"]
        if not isinstance(rows, list) or len(rows) < 2 or len({len(row) for row in rows}) != 1:
            raise SpecError("table needs a header row and at least one data row, all the same length")
        rows = [[str(cell) for cell in row] for row in rows]
        count = len(rows[0])
        lengths = [max(len(row[c]) for row in rows) + 4 for c in range(count)]
        widths = [int(area.w * length / sum(lengths)) for length in lengths]
        cell_inset = Inches(0.08)
        for size in range(18, 10, -1):
            heights = [max(text_height([cell], w - 2 * cell_inset, size, r == 0, style) for cell, w in zip(row, widths)) + Inches(0.16) for r, row in enumerate(rows)]
            if sum(heights) <= area.h:
                break
        else:
            raise SpecError(f"table with {len(rows)} rows does not fit even at 11pt: split it or drop columns")
        shape = slide.shapes.add_table(len(rows), count, area.x, area.y, area.w, sum(heights))
        table = shape.table
        tbl_pr = shape._element.graphic.graphicData.tbl.tblPr
        tbl_pr.set("bandRow", "0")
        tbl_pr.set("firstRow", "0")
        style_id = tbl_pr.find(qn("a:tableStyleId"))
        if style_id is None:
            style_id = etree.SubElement(tbl_pr, qn("a:tableStyleId"))
        style_id.text = NO_GRID_TABLE
        spare = (area.h - sum(heights)) / len(rows)
        heights = [int(h + min(spare, Inches(0.2))) for h in heights]
        for c, width in enumerate(widths):
            table.columns[c].width = width
        numeric = re.compile(r"^[\s৳$€£%+\-.,()০-৯\d]+[a-zA-Z%ক-হ .]*$")
        right = [c > 0 and all(numeric.match(row[c]) for row in rows[1:]) for c in range(count)]
        for r, row in enumerate(rows):
            table.rows[r].height = heights[r]
            for c, value in enumerate(row):
                cell = table.cell(r, c)
                cell.fill.solid()
                cell.fill.fore_color.rgb = RGBColor.from_string(self.theme["colors"]["emphasis"] if r == 0 else (self.theme["colors"]["tint"] if r % 2 == 0 else "FFFFFF"))
                cell.margin_left = cell.margin_right = cell_inset
                cell.margin_top = cell.margin_bottom = Inches(0.04)
                cell.vertical_anchor = MSO_ANCHOR.MIDDLE
                rule_below(cell, "D9D9D9")
                align = PP_ALIGN.RIGHT if right[c] else PP_ALIGN.LEFT
                write(cell.text_frame, [value], size, "FFFFFF" if r == 0 else self.theme["colors"]["ink"], style, bold=r == 0, align=align)

    def chart(self, slide, number, spec, area, layout, style):
        chart_spec = spec["chart"]
        kind = chart_spec.get("type", "bar")
        if kind not in CHART_TYPES:
            raise SpecError(f"chart type {kind!r}: use one of {', '.join(CHART_TYPES)}")
        labels, series = chart_spec.get("labels"), chart_spec.get("series")
        if not labels or not series or any(len(s.get("values", [])) != len(labels) for s in series):
            raise SpecError("chart needs labels and series whose values match the labels one for one")
        data = CategoryChartData()
        data.categories = labels
        for item in series:
            data.add_series(item.get("name", ""), item["values"])
        frame = slide.shapes.add_chart(CHART_TYPES[kind], area.x, area.y, area.w, area.h, data)
        chart = frame.chart
        chart.has_title = False
        chart.font.size = Pt(12)
        chart.font.name = style.latin
        chart.font.color.rgb = RGBColor.from_string(style.ink)
        add_bangla_font(chart.font._rPr, style.bangla, any(has_bangla(str(label)) for label in labels))
        plot = chart.plots[0]
        round_pie = kind in ("pie", "doughnut")
        plot.vary_by_categories = round_pie
        chart.has_legend = round_pie or len(series) > 1
        if chart.has_legend:
            chart.legend.position = XL_LEGEND_POSITION.BOTTOM
            chart.legend.include_in_layout = False
            chart.legend.font.size = Pt(12)
        plot.has_data_labels = kind != "line"
        if plot.has_data_labels:
            labels_format = plot.data_labels
            labels_format.font.size = Pt(12)
            labels_format.font.color.rgb = RGBColor.from_string(style.ink if not round_pie else "FFFFFF")
            if kind in ("bar", "column"):
                labels_format.position = XL_LABEL_POSITION.OUTSIDE_END
        palette = style.chart if not style.dark else ["FFFFFF", *style.chart[1:]]
        highlight = chart_spec.get("highlight")
        if round_pie:
            for index, point in enumerate(plot.series[0].points):
                point.format.fill.solid()
                point.format.fill.fore_color.rgb = RGBColor.from_string(palette[index % len(palette)])
        elif len(series) == 1 and highlight is not None and kind != "line":
            emphasis = self.theme["colors"]["accent"] if not style.dark else "FFFFFF"
            for index, point in enumerate(plot.series[0].points):
                point.format.fill.solid()
                point.format.fill.fore_color.rgb = RGBColor.from_string(emphasis if index == highlight else GREY)
        else:
            for index, item in enumerate(plot.series):
                color = RGBColor.from_string(palette[index % len(palette)])
                if kind == "line":
                    item.format.line.color.rgb = color
                    item.format.line.width = Pt(2.5)
                    item.smooth = False
                else:
                    item.format.fill.solid()
                    item.format.fill.fore_color.rgb = color
        if round_pie:
            return
        category = chart.category_axis
        category.tick_labels.font.size = Pt(12)
        category.has_major_gridlines = False
        category.reverse_order = kind == "bar"
        category.format.line.color.rgb = RGBColor.from_string(GREY)
        value = chart.value_axis
        value.has_major_gridlines = kind == "line"
        if kind == "line":
            value.major_gridlines.format.line.color.rgb = RGBColor.from_string("D9D9D9")
            value.tick_labels.font.size = Pt(11)
        else:
            value.visible = False

    def infographic(self, slide, number, spec, area, layout, style):
        block = spec["infographic"]
        if not isinstance(block, dict) or "kind" not in block or "items" not in block:
            raise SpecError('infographic is {"kind": "cycle", "items": [["Heading", "Detail"], ...]}')
        if style.dark:
            raise SpecError("infographics are drawn for light backgrounds: use a light layout for this slide")
        kinds = self.library.kinds()
        kind = block["kind"]
        if kind not in kinds:
            raise SpecError(f"no infographic kind {kind!r}; use one of: {', '.join(kinds)}")
        items = [infographic_item(item) for item in block["items"]]
        if len(items) not in kinds[kind]:
            raise SpecError(f"{kind} designs take {', '.join(map(str, kinds[kind]))} items, not {len(items)}")
        candidates = self.library.choose(kind, items, block.get("centre"), area, f"{self.title}:{number}", self.used, block.get("design"))
        if not candidates:
            raise SpecError(f"no {kind} design with {len(items)} items matches these fields; give every item a detail, or none")
        tools = Measure(style)
        reason = ""
        for design in candidates:
            elements, factor = place(slide, self.library, design, area)
            reason = fill_all(elements, design, items, block.get("centre"), factor, tools)
            if reason is None:
                self.used.add(design["id"])
                return
            remove_elements(elements)
        raise SpecError(f"no {kind} design fits this text ({reason}): shorten the headings and details")

    def takeaway(self, slide, box, text, style, number):
        panel(slide, box, style.band)
        inner = box.inset(Inches(0.15))
        size = fit([text], Box(0, 0, inner.w - Inches(0.1), inner.h), (18, 13), style, True)
        if size is None:
            raise SpecError("the takeaway is longer than one band: state the conclusion in one sentence")
        textbox(slide, Box(inner.x + Inches(0.1), inner.y, inner.w - Inches(0.1), inner.h), [text], size, style.band_text, style, bold=True, anchor=MSO_ANCHOR.MIDDLE)


def rule_below(cell, color):
    """No side or top borders and a thin rule below: LibreOffice ignores the table style's grid."""
    tc_pr = cell._tc.get_or_add_tcPr()
    for tag in ("a:lnL", "a:lnR", "a:lnT", "a:lnB"):
        for old in tc_pr.findall(qn(tag)):
            tc_pr.remove(old)
    lines = []
    for tag in ("a:lnL", "a:lnR", "a:lnT", "a:lnB"):
        line = etree.Element(qn(tag), w=str(int(Pt(0.75))) if tag == "a:lnB" else "0")
        if tag == "a:lnB":
            fill = etree.SubElement(line, qn("a:solidFill"))
            etree.SubElement(fill, qn("a:srgbClr"), val=color)
        else:
            etree.SubElement(line, qn("a:noFill"))
        lines.append(line)
    for line in reversed(lines):
        tc_pr.insert(0, line)


def set_bullet(paragraph, color, size):
    """Bullets written on the paragraph: LibreOffice ignores the master's list style on these slides."""
    ppr = paragraph._p.get_or_add_pPr()
    for tag in ("a:buClr", "a:buSzPct", "a:buFont", "a:buChar", "a:buNone", "a:buAutoNum"):
        for old in ppr.findall(qn(tag)):
            ppr.remove(old)
    if color is None:
        ppr.set("marL", "0")
        ppr.set("indent", "0")
        ppr.append(etree.Element(qn("a:buNone")))
        return
    indent = int(Pt(size * 1.2))
    ppr.set("marL", str(indent))
    ppr.set("indent", str(-indent))
    clr = etree.SubElement(ppr, qn("a:buClr"))
    etree.SubElement(clr, qn("a:srgbClr"), val=color)
    etree.SubElement(ppr, qn("a:buFont"), typeface="Arial")
    etree.SubElement(ppr, qn("a:buChar"), char="•")


def load_theme(name, themes_dir):
    for path in sorted(themes_dir.glob("*.json")):
        theme = json.loads(path.read_text(encoding="utf8"))
        if theme["name"].lower() == str(name).lower():
            return theme
    names = ", ".join(json.loads(p.read_text(encoding="utf8"))["name"] for p in sorted(themes_dir.glob("*.json")))
    raise SpecError(f"no theme {name!r}; use one of: {names}")


class Measure:
    """deck.py's measuring and font rules, handed to infographic.py."""

    def __init__(self, style):
        self.style = style
        self.scaled = scaled

    def height(self, paragraphs, width, size, bold):
        return text_height(paragraphs, width, size, bold, self.style)

    def fonts(self, rpr, text):
        latin = rpr.find(qn("a:latin"))
        if latin is None:
            latin = etree.SubElement(rpr, qn("a:latin"))
        latin.set("typeface", self.style.latin)
        for old in rpr.findall(qn("a:cs")):
            rpr.remove(old)
        add_bangla_font(rpr, self.style.bangla, has_bangla(text))


def infographic_item(item):
    if isinstance(item, dict) and item.get("head"):
        return {key: str(value) for key, value in item.items() if value not in (None, "")}
    if isinstance(item, list) and 1 <= len(item) <= 2 and all(isinstance(v, str) for v in item):
        return {"head": item[0], **({"body": item[1]} if len(item) == 2 and item[1] else {})}
    raise SpecError('each infographic item is ["Heading", "Detail"] or {"head", "body", "value", "date"}')


def list_themes(themes_dir):
    for path in sorted(themes_dir.glob("*.json")):
        theme = json.loads(path.read_text(encoding="utf8"))
        print(f"{theme['name']}: {theme['description']}")
        for name, layout in theme["layouts"].items():
            notes = [layout.get("role", "content")]
            if layout.get("dark"):
                notes.append("dark")
            if layout.get("picture"):
                notes.append("picture area")
            if layout.get("columns"):
                notes.append(f"{len(layout['columns'])} cards")
            print(f"  {name} ({', '.join(notes)})")
    kinds = Library().kinds()
    if kinds:
        print("Infographic kinds (item counts): " + "; ".join(f"{k} ({', '.join(map(str, v))})" for k, v in kinds.items()))


def main(argv):
    parser = argparse.ArgumentParser(description="Build a themed deck from a JSON spec.")
    parser.add_argument("spec", nargs="?", type=Path)
    parser.add_argument("out", nargs="?", type=Path)
    parser.add_argument("--themes", type=Path, default=THEMES)
    parser.add_argument("--library", type=Path, help="infographic library folder (default: the skill's)")
    parser.add_argument("--list", action="store_true", help="list themes and their layouts")
    parser.add_argument("--no-check", action="store_true", help="skip check.py after building")
    args = parser.parse_args(argv)
    if args.list:
        list_themes(args.themes)
        return 0
    if not args.spec or not args.out:
        parser.error("give spec.json and the output path, or --list")
    try:
        spec = json.loads(args.spec.read_text(encoding="utf8"))
        theme = load_theme(spec.get("theme"), args.themes)
    except (OSError, ValueError, SpecError) as error:
        print(f"spec: {error}")
        return 2
    if not spec.get("slides"):
        print("spec: give at least one slide")
        return 2
    builder = Builder(theme, args.themes, args.library)
    builder.build(spec["slides"])
    if builder.problems:
        print("not built, fix these and run again:\n" + "\n".join(builder.problems))
        return 2
    builder.presentation.save(args.out)
    print(f"built {args.out}: {len(spec['slides'])} slides on {theme['name']}")
    if args.no_check:
        return 0
    result = subprocess.run([sys.executable, str(SCRIPTS / "check.py"), str(args.out)], capture_output=True, text=True)
    print((result.stdout + result.stderr).strip())
    return result.returncode


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
