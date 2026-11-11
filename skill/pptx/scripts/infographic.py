"""Place a prepared infographic from the library into a slide and fill its text slots.

The library (skill/pptx/infographics/) holds one .pptx per kind, one design per slide, and
manifest.json describing each design: kind, item count, slot roles and bounding box. Slot
shapes are named "slot:item<N>.<role>" (head, body, text, number, value, date) or
"slot:centre". Colours are theme slots, so a design takes the deck's theme.

deck.py calls choose() for the candidates and place() for each until one fits.
"""

import copy
import hashlib
import json
import re
from pathlib import Path

from lxml import etree
from pptx import Presentation
from pptx.oxml.ns import qn
from pptx.util import Inches, Pt

LIBRARY = Path(__file__).resolve().parent.parent / "infographics"
SCALED = {
    "off": ("x", "y"), "chOff": ("x", "y"), "ext": ("cx", "cy"), "chExt": ("cx", "cy"),
    "ln": ("w",), "bodyPr": ("lIns", "tIns", "rIns", "bIns"), "spcPts": ("val",),
    "rPr": ("sz",), "defRPr": ("sz",), "endParaRPr": ("sz",),
}
LEVELS = {f"lvl{n}pPr" for n in range(1, 10)} | {"pPr"}
SLOT = re.compile(r"^slot:(?:item(\d+)\.(\w+)|(centre))$")
MAX_GROWTH = 1.25
FLOOR = 0.55
"""How much wider a slot may grow when one word does not fit, e.g. a long Bangla heading."""
WIDEN = 1.3


class Library:
    def __init__(self, folder=LIBRARY):
        self.folder = Path(folder)
        manifest = self.folder / "manifest.json"
        self.designs = json.loads(manifest.read_text(encoding="utf8")) if manifest.exists() else []
        self.decks = {}

    def kinds(self):
        counts = {}
        for design in self.designs:
            counts.setdefault(design["kind"], set()).add(design["items"])
        return {kind: sorted(numbers) for kind, numbers in sorted(counts.items())}

    def choose(self, kind, items, centre, area, seed, used, pinned=None):
        """Designs that fit the content, best first: right count and fields, then shape, then a seeded order."""
        fields = {field for item in items for field in item if item.get(field)}
        if pinned:
            return [d for d in self.designs if d["id"] == pinned]
        matches = []
        for design in self.designs:
            roles = set(design["roles"])
            if design["kind"] != kind or design["items"] != len(items) or design["id"] in used:
                continue
            if "body" in fields and not roles & {"body", "text"}:
                continue
            if "body" in roles and "body" not in fields:
                continue
            if "value" in roles and "value" not in fields:
                continue
            if "date" in roles and "date" not in fields:
                continue
            if "centre" in roles and not centre:
                continue
            x, y, w, h = design["bbox"]
            shape = abs((w / h) - (area.w / area.h))
            order = hashlib.sha256(f"{seed}:{design['id']}".encode()).hexdigest()
            matches.append((round(shape, 1), order, design))
        return [design for _, _, design in sorted(matches, key=lambda m: (m[0], m[1]))]

    def elements(self, design):
        path = self.folder / design["file"]
        if path not in self.decks:
            self.decks[path] = Presentation(path)
        tree = self.decks[path].slides[design["slide"] - 1].shapes._spTree
        return [copy.deepcopy(child) for child in tree if etree.QName(child).localname not in ("nvGrpSpPr", "grpSpPr")]


def scale(element, factor):
    for node in element.iter():
        if not isinstance(node.tag, str):
            continue
        tag = etree.QName(node).localname
        names = SCALED.get(tag, ()) + (("marL", "indent") if tag in LEVELS else ())
        for name in names:
            value = node.get(name)
            if value is not None and value.lstrip("-").isdigit():
                node.set(name, str(round(int(value) * factor)))


def own_xfrm(element):
    holder = element.find(qn("p:grpSpPr")) if etree.QName(element).localname == "grpSp" else element.find(qn("p:spPr"))
    if holder is None:
        holder = element.find(qn("p:xfrm"))
        return holder
    return holder.find(qn("a:xfrm"))


def place(slide, library, design, area):
    """Copy the design into area, scaled to fit and centred; returns the added elements."""
    x, y, w, h = (Inches(v) for v in design["bbox"])
    factor = min(area.w / w, area.h / h, MAX_GROWTH)
    left = area.x + (area.w - w * factor) / 2
    top = area.y + (area.h - h * factor) / 2
    added = []
    tree = slide.shapes._spTree
    for element in library.elements(design):
        scale(element, factor)
        xfrm = own_xfrm(element)
        off = xfrm.find(qn("a:off")) if xfrm is not None else None
        if off is not None:
            off.set("x", str(round(int(off.get("x")) - x * factor + left)))
            off.set("y", str(round(int(off.get("y")) - y * factor + top)))
        tree.append(element)
        added.append(element)
    return added, factor


def slots(elements):
    found = {}
    for element in elements:
        for shape in element.iter(qn("p:sp")):
            name = shape.find(qn("p:nvSpPr") + "/" + qn("p:cNvPr")).get("name", "")
            match = SLOT.match(name)
            if match:
                key = "centre" if match.group(3) else (int(match.group(1)), match.group(2))
                found[key] = shape
    return found


def slot_width(shape, elements):
    """Text width of a slot in EMU, following any group scale above it."""
    ext = shape.find(qn("p:spPr") + "/" + qn("a:xfrm") + "/" + qn("a:ext"))
    width, height = int(ext.get("cx")), int(ext.get("cy"))
    parent = shape.getparent()
    while parent is not None and etree.QName(parent).localname == "grpSp":
        xfrm = parent.find(qn("p:grpSpPr") + "/" + qn("a:xfrm"))
        if xfrm is not None and xfrm.find(qn("a:chExt")) is not None:
            width = width * int(xfrm.find(qn("a:ext")).get("cx")) / max(1, int(xfrm.find(qn("a:chExt")).get("cx")))
            height = height * int(xfrm.find(qn("a:ext")).get("cy")) / max(1, int(xfrm.find(qn("a:chExt")).get("cy")))
        parent = parent.getparent()
    body = shape.find(qn("p:txBody") + "/" + qn("a:bodyPr"))
    inset = Inches(0.1)
    left = int(body.get("lIns", inset)) if body is not None else inset
    right = int(body.get("rIns", inset)) if body is not None else inset
    top = int(body.get("tIns", Inches(0.05))) if body is not None else Inches(0.05)
    bottom = int(body.get("bIns", Inches(0.05))) if body is not None else Inches(0.05)
    return width - left - right, height - top - bottom


def original_size(shape):
    sizes = [int(r.get("sz")) for r in shape.iter(qn("a:rPr"), qn("a:endParaRPr")) if r.get("sz")]
    return max(sizes) / 100 if sizes else 14


def fill(shape, parts, size, tools):
    """Replace the slot's text with parts [(text, bold)], keeping the first run's look."""
    body = shape.find(qn("p:txBody"))
    paragraphs = body.findall(qn("a:p"))
    first = paragraphs[0]
    for extra in paragraphs[1:]:
        body.remove(extra)
    runs = first.findall(qn("a:r"))
    template = copy.deepcopy(runs[0].find(qn("a:rPr"))) if runs and runs[0].find(qn("a:rPr")) is not None else etree.Element(qn("a:rPr"))
    for run in runs:
        first.remove(run)
    for field in first.findall(qn("a:fld")):
        first.remove(field)
    end = first.find(qn("a:endParaRPr"))
    for text, bold in parts:
        run = etree.Element(qn("a:r"))
        rpr = copy.deepcopy(template)
        rpr.set("sz", str(round(tools.scaled(size, text) * 100)))
        if bold is not None:
            rpr.set("b", "1" if bold else "0")
        tools.fonts(rpr, text)
        run.append(rpr)
        etree.SubElement(run, qn("a:t")).text = text
        if end is not None:
            end.addprevious(run)
        else:
            first.append(run)
    autofit = body.find(qn("a:bodyPr") + "/" + qn("a:normAutofit"))
    if autofit is not None:
        autofit.getparent().remove(autofit)


def content(item, role):
    if role == "text":
        head, detail = item.get("head", ""), item.get("body", "")
        return [(head, True), (": " if detail else "", True), (detail, False)] if head else [(detail, None)]
    value = item.get(role)
    return [(str(value), None)] if value else None


def fill_all(elements, design, items, centre, factor, tools):
    """Fill every slot; returns None when done, else why the text does not fit."""
    found = slots(elements)
    for key, shape in found.items():
        if key == "centre":
            parts = [(centre, None)]
        else:
            number, role = key
            if number > len(items):
                return f"design has more items than {len(items)}"
            parts = content(items[number - 1], role)
            if parts is None:
                if role == "number":
                    continue
                parts = [("", None)]
        text = "".join(part for part, _ in parts)
        size = fitted_size(shape, text, parts, elements, tools)
        if size is None:
            widen(shape, WIDEN)
            size = fitted_size(shape, text, parts, elements, tools)
        if size is None:
            return f"{text[:30]!r} does not fit its box"
        fill(shape, parts, size, tools)
    return None


def fitted_size(shape, text, parts, elements, tools):
    width, height = slot_width(shape, elements)
    start = original_size(shape)
    floor = max(9, start * FLOOR)
    size = start
    bold = any(b for _, b in parts) or (all(b is None for _, b in parts) and slot_bold(shape))
    while size >= floor and tools.height([text], width, size, bold) > height * 1.05:
        size -= 0.5
    return size if size >= floor else None


def slot_bold(shape):
    """Whether the slot's own text is bold, so it is measured the way it will render."""
    rpr = shape.find(".//" + qn("a:rPr"))
    return rpr is not None and rpr.get("b") in ("1", "true")


def widen(shape, factor):
    """Make a slot wider, keeping it anchored the way its text is aligned."""
    xfrm = shape.find(qn("p:spPr") + "/" + qn("a:xfrm"))
    off, ext = xfrm.find(qn("a:off")), xfrm.find(qn("a:ext"))
    old = int(ext.get("cx"))
    new = round(old * factor)
    ext.set("cx", str(new))
    ppr = shape.find(".//" + qn("a:pPr"))
    align = ppr.get("algn", "l") if ppr is not None else "l"
    shift = {"ctr": (new - old) / 2, "r": new - old}.get(align, 0)
    off.set("x", str(round(int(off.get("x")) - shift)))


def remove(elements):
    for element in elements:
        element.getparent().remove(element)


def seed_for(title, number):
    return f"{title}:{number}"
