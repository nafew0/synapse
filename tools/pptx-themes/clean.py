"""Turn a LibreOffice-exported template into a clean theme master for deck.py.

    python3 clean.py <template.pptx> <config.json> <out.pptx> [themes dir]

Scales the deck to 13.333 x 7.5 in (shapes, text sizes, line widths, indents), deletes the
sample slides and every layout the config does not keep, renames the kept layouts, names
their placeholders "title" and "body" (body idx 1), moves placeholders the config gives a
box for, and drops LibreOffice's shrink-to-fit (deck.py fits text itself). Sets every Latin
font to Calibri and Nikosh for Bangla, and writes the palette from the theme's JSON
(skill/pptx/themes/<Name>.json) into the colour scheme, so anything coloured by theme slot,
infographics included, takes the theme's colours.

Config: {"layouts": {"<master>.<layout>": {"name": "cover", "title": [x, y, w, h],
"body": [x, y, w, h], "color": "FFFFFF", "body_size": 20}}} with boxes in inches on the final slide.
"""

import copy
import json
import sys
from pathlib import Path

from lxml import etree
from pptx import Presentation
from pptx.opc.constants import RELATIONSHIP_TYPE as RT
from pptx.oxml.ns import qn
from pptx.util import Inches

WIDTH, HEIGHT = Inches(13.333), Inches(7.5)
BANGLA = "Nikosh"
"""Calibri ships with Office; the sandbox has Carlito with the same widths, so fit checks hold."""
LATIN = "Calibri"
THEMES = Path(__file__).resolve().parents[2] / "skill" / "pptx" / "themes"
SYMBOL_FONTS = {"Wingdings", "Symbol", "OpenSymbol", "Webdings"}
SCALED = {
    "off": ("x", "y"),
    "chOff": ("x", "y"),
    "ext": ("cx", "cy"),
    "chExt": ("cx", "cy"),
    "ln": ("w",),
    "bodyPr": ("lIns", "tIns", "rIns", "bIns"),
    "spcPts": ("val",),
    "tab": ("pos",),
    "rPr": ("sz",),
    "defRPr": ("sz",),
    "endParaRPr": ("sz",),
}
LEVELS = [f"lvl{n}pPr" for n in range(1, 10)] + ["pPr"]
TITLE_TYPES = {"title", "ctrTitle"}
BODY_TYPES = {"body", "subTitle", "obj", None}


def scale(root, factor):
    for element in root.iter():
        if not isinstance(element.tag, str):
            continue
        tag = etree.QName(element).localname
        names = SCALED.get(tag, ()) + (("marL", "indent") if tag in LEVELS else ())
        for name in names:
            value = element.get(name)
            if value is not None and value.lstrip("-").isdigit():
                element.set(name, str(round(int(value) * factor)))


def drop_autofit(root):
    for autofit in list(root.iter(qn("a:normAutofit"))):
        autofit.getparent().remove(autofit)


def set_latin(root):
    for latin in root.iter(qn("a:latin")):
        name = latin.get("typeface", "")
        if not name.startswith("+") and name not in SYMBOL_FONTS:
            latin.set("typeface", LATIN)


def add_bangla(root):
    for element in root.iter(qn("a:rPr"), qn("a:defRPr"), qn("a:endParaRPr")):
        latin = element.find(qn("a:latin"))
        if latin is None or element.find(qn("a:cs")) is not None:
            continue
        anchor = element.find(qn("a:ea"))
        (anchor if anchor is not None else latin).addnext(etree.Element(qn("a:cs"), typeface=BANGLA))


def scheme_colors(colors):
    """The theme JSON's palette as the twelve slots of <a:clrScheme>."""
    accents = list(dict.fromkeys([*colors["chart"], colors["primary"], colors["accent"], colors["emphasis"]]))
    accents = (accents * 6)[:6]
    slots = {"dk1": colors["ink"], "lt1": "FFFFFF", "dk2": colors["emphasis"], "lt2": colors["tint"],
             "hlink": colors["primary"], "folHlink": colors["muted"]}
    slots.update({f"accent{n}": color for n, color in enumerate(accents, 1)})
    return slots


def set_theme(master, colors):
    """Write the palette into the colour scheme and set the theme fonts: Calibri, Nikosh for Bangla."""
    theme = master.part.part_related_by(RT.THEME)
    root = etree.fromstring(theme.blob)
    scheme = root.find(".//" + qn("a:clrScheme"))
    for name, color in scheme_colors(colors).items():
        slot = scheme.find(qn(f"a:{name}"))
        for child in list(slot):
            slot.remove(child)
        etree.SubElement(slot, qn("a:srgbClr"), val=color.upper())
    for font in root.iter(qn("a:majorFont"), qn("a:minorFont")):
        font.find(qn("a:latin")).set("typeface", LATIN)
        cs = font.find(qn("a:cs"))
        if cs is not None:
            cs.set("typeface", BANGLA)
    theme._blob = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


def drop_slides(presentation):
    ids = presentation.slides._sldIdLst
    for entry in list(ids):
        presentation.part.drop_rel(entry.rId)
        ids.remove(entry)


def role(shape):
    ph = shape.find(".//" + qn("p:ph"))
    if ph is None:
        return None
    kind = ph.get("type")
    if kind in TITLE_TYPES:
        return "title"
    return "body" if kind in BODY_TYPES else None


def place(shape, box):
    sp_pr = shape.find(qn("p:spPr"))
    xfrm = sp_pr.find(qn("a:xfrm"))
    if xfrm is None:
        xfrm = etree.Element(qn("a:xfrm"))
        sp_pr.insert(0, xfrm)
    for key in ("rot", "flipH", "flipV"):
        xfrm.attrib.pop(key, None)
    xfrm.clear()
    x, y, w, h = (Inches(v) for v in box)
    etree.SubElement(xfrm, qn("a:off"), x=str(x), y=str(y))
    etree.SubElement(xfrm, qn("a:ext"), cx=str(w), cy=str(h))
    body = shape.find(qn("p:txBody") + "/" + qn("a:bodyPr"))
    if body is not None:
        body.attrib.pop("vert", None)
        body.attrib.pop("rot", None)


def style(shape, color=None, size=None):
    tx = shape.find(qn("p:txBody"))
    if tx is None:
        return
    styles = tx.find(qn("a:lstStyle"))
    if styles is None:
        styles = etree.Element(qn("a:lstStyle"))
        tx.find(qn("a:bodyPr")).addnext(styles)
    level = styles.find(qn("a:lvl1pPr"))
    if level is None:
        level = etree.SubElement(styles, qn("a:lvl1pPr"))
    default = level.find(qn("a:defRPr"))
    if default is None:
        default = etree.SubElement(level, qn("a:defRPr"))
    runs = [default, *tx.iter(qn("a:rPr"), qn("a:endParaRPr"))]
    if size:
        for run in runs:
            run.set("sz", str(size * 100))
    if not color:
        return
    fill = etree.Element(qn("a:solidFill"))
    etree.SubElement(fill, qn("a:srgbClr"), val=color)
    for run in runs:
        for old in run.findall(qn("a:solidFill")):
            run.remove(old)
        run.insert(0, copy.deepcopy(fill))


def area(shape):
    ext = shape.find(qn("p:spPr") + "/" + qn("a:xfrm") + "/" + qn("a:ext"))
    return 0 if ext is None else int(ext.get("cx")) * int(ext.get("cy"))


def tidy_layout(layout, spec):
    root = layout._element
    root.find(qn("p:cSld")).set("name", spec["name"])
    shapes = [(shape, role(shape)) for shape in root.iter(qn("p:sp"))]
    bodies = sorted((shape for shape, kind in shapes if kind == "body"), key=area, reverse=True)
    for extra, shape in enumerate(bodies[1:], 10):
        shape.find(qn("p:nvSpPr") + "/" + qn("p:cNvPr")).set("name", f"extra{extra}")
        shape.find(".//" + qn("p:ph")).set("idx", str(extra))
    others = [shape for shape, kind in shapes if kind is None and shape.find(".//" + qn("p:ph")) is not None]
    for number, shape in enumerate(others, 20):
        shape.find(".//" + qn("p:ph")).set("idx", str(number))
    for shape, kind in shapes:
        if kind is None or (kind == "body" and shape is not bodies[0]):
            continue
        shape.find(qn("p:nvSpPr") + "/" + qn("p:cNvPr")).set("name", kind)
        if kind == "body":
            shape.find(".//" + qn("p:ph")).set("idx", "1")
        if spec.get(kind):
            place(shape, spec[kind])
        style(shape, spec.get("color"), spec.get(f"{kind}_size"))


def remove_layout(master, layout):
    ids = master._element.find(qn("p:sldLayoutIdLst"))
    for entry in list(ids):
        if master.part.related_part(entry.get(qn("r:id"))) is layout.part:
            master.part.drop_rel(entry.get(qn("r:id")))
            ids.remove(entry)


def remove_master(presentation, master):
    ids = presentation.part._element.find(qn("p:sldMasterIdLst"))
    for entry in list(ids):
        if presentation.part.related_part(entry.get(qn("r:id"))) is master.part:
            presentation.part.drop_rel(entry.get(qn("r:id")))
            ids.remove(entry)


def main(source, config_path, target, themes=THEMES):
    config = json.load(open(config_path, encoding="utf8"))[Path(source).stem]["layouts"]
    colors = json.loads((Path(themes) / f"{Path(source).stem}.json").read_text(encoding="utf8"))["colors"]
    presentation = Presentation(source)
    factor = WIDTH / presentation.slide_width
    drop_slides(presentation)
    for m, master in enumerate(list(presentation.slide_masters)):
        for l, layout in enumerate(list(master.slide_layouts)):
            spec = config.get(f"{m}.{l}")
            if spec is None:
                remove_layout(master, layout)
                continue
            scale(layout._element, factor)
            set_latin(layout._element)
            add_bangla(layout._element)
            drop_autofit(layout._element)
            tidy_layout(layout, spec)
        if len(master.slide_layouts) == 0:
            remove_master(presentation, master)
            continue
        scale(master._element, factor)
        set_latin(master._element)
        add_bangla(master._element)
        drop_autofit(master._element)
        for shape in master._element.iter(qn("p:sp")):
            if role(shape) == "body":
                shape.find(".//" + qn("p:ph")).set("idx", "1")
        set_theme(master, colors)
    presentation.slide_width, presentation.slide_height = WIDTH, HEIGHT
    presentation.save(target)
    names = [layout.name for master in presentation.slide_masters for layout in master.slide_layouts]
    print(f"{target}: {', '.join(names)}")


if __name__ == "__main__":
    main(*sys.argv[1:5])
