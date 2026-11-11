"""Prepare infographic slides from the packs into the library deck.py fills.

    python3 build.py CATALOGUE.jsonl LIBRARY_DIR [--pick picks.json] [--kinds cycle,funnel]

For each candidate slide (Pack A folders that name one of the version 1 kinds, or the ids in
--pick), it:
- takes the slide out of its source deck and removes the sample title and subtitle
- finds the text slots by their placeholder text: item headings, details, numbers, values and
  dates, plus a centre title
- pairs each slot with its item and orders the items: by the numbering when there is one, else
  clockwise for cycles, left to right for wide designs, top to bottom for the rest
- scales every size to our 13.333 x 7.5 in slide (the packs are twice that), fonts and lines included
- turns colours that match the source theme's accents into theme colour slots, so the graphic
  takes the deck's theme
- sets Calibri for Latin text and Nikosh for Bangla

It writes LIBRARY_DIR/<kind>.pptx (one slide per design) and LIBRARY_DIR/manifest.json, and
prints why each rejected slide was set aside. Slides with pictures, charts, links or text it
cannot place are rejected: version 1 keeps only designs it can fill reliably.
"""

import argparse
import copy
import json
import math
import re
import sys
import zipfile
from collections import Counter
from pathlib import Path

from lxml import etree
from pptx import Presentation
from pptx.oxml.ns import qn
from pptx.util import Inches

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "pptx-themes"))
from clean import scale  # noqa: E402

EMU = 914400
LATIN = "Calibri"
BANGLA = "Nikosh"
V1 = {
    "cycle": ["Cycle", "Product Life Cycle"],
    "process": ["Process", "Arrow"],
    "timeline": ["Timeline", "Roadmap", "Milestones", "30 60 90 Day Plan"],
    "funnel": ["Funnel"],
    "pyramid": ["Pyramid", "Hierarchy"],
    "matrix": ["SWOT", "Matrix Diagram"],
    "comparison": ["Comparison"],
    "kpi": ["Data Analysis", "KPI Dashboard"],
}
NUMBERED = re.compile(r"^(?:title|milestone|step|phase|stage|option|level)\s*0?(\d{1,2})$", re.I)
NUMBER = re.compile(r"^0?(\d{1,2})$")
VALUE = re.compile(r"^[$€£৳]?\d[\d.,]*\s?(%|[kmb]\+?|\+)?$", re.I)
YEAR = re.compile(r"^(19|20)\d{2}$")
CENTRE = re.compile(r"^(your title( here)?|title here|your text here|main title)$", re.I)
FIXED = re.compile(r"^([A-Z]|\d{2,3} days|swot|[SWOT])$", re.I)
NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


def q(tag):
    return qn(tag)


def text_of(element):
    return " ".join(t.text or "" for t in element.iter(q("a:t"))).strip()


def font_size(element):
    sizes = [int(r.get("sz")) / 100 for r in element.iter(q("a:rPr"), q("a:endParaRPr")) if r.get("sz")]
    return max(sizes, default=0)


def own_box(element):
    xfrm = element.find(".//" + q("a:xfrm"))
    if xfrm is None or xfrm.find(q("a:off")) is None:
        return None
    off, ext = xfrm.find(q("a:off")), xfrm.find(q("a:ext"))
    return [int(off.get("x")), int(off.get("y")), int(ext.get("cx")), int(ext.get("cy"))]


def walk(tree, transform=(0.0, 0.0, 1.0, 1.0)):
    """(element, absolute box, group scale) for every leaf shape."""
    dx, dy, sx, sy = transform
    for child in tree:
        tag = etree.QName(child).localname
        if tag == "grpSp":
            xfrm = child.find(q("p:grpSpPr") + "/" + q("a:xfrm"))
            parts = [xfrm.find(q(t)) if xfrm is not None else None for t in ("a:off", "a:ext", "a:chOff", "a:chExt")]
            if None in parts:
                yield from walk(child, transform)
                continue
            off, ext, ch_off, ch_ext = parts
            gx = int(ext.get("cx")) / max(1, int(ch_ext.get("cx")))
            gy = int(ext.get("cy")) / max(1, int(ch_ext.get("cy")))
            inner = (dx + sx * (int(off.get("x")) - int(ch_off.get("x")) * gx),
                     dy + sy * (int(off.get("y")) - int(ch_off.get("y")) * gy), sx * gx, sy * gy)
            yield from walk(child, inner)
        elif tag in ("sp", "pic", "graphicFrame", "cxnSp"):
            box = own_box(child)
            if box:
                x, y, w, h = box
                yield child, [dx + sx * x, dy + sy * y, sx * w, sy * h], (sx, sy)


def centre(box):
    return box[0] + box[2] / 2, box[1] + box[3] / 2


def distance(a, b):
    """Gap between two boxes, with a penalty when b is not below or beside a."""
    (ax, ay), (bx, by) = centre(a), centre(b)
    gap = math.hypot(ax - bx, ay - by)
    return gap * (1.6 if by < a[1] - a[3] else 1.0)


class Reject(Exception):
    pass


def analyse(slide_xml, width, height, kind):
    """Find header, slots and items; raise Reject when the slide cannot be filled reliably."""
    tree = slide_xml.find(q("p:cSld") + "/" + q("p:spTree"))
    if tree.find(".//" + q("p:pic")) is not None or tree.find(".//" + q("p:graphicFrame")) is not None:
        raise Reject("has a picture or chart")
    if any(key in (f"{{{NS_R}}}embed", f"{{{NS_R}}}link") for element in tree.iter() for key in element.attrib):
        raise Reject("has embedded media")
    texts = []
    for element, box, (gx, gy) in walk(tree):
        text = text_of(element)
        if text:
            texts.append({"el": element, "box": box, "text": text, "size": font_size(element), "scale": (gx, gy)})
    if not texts:
        raise Reject("no text")
    top = [t for t in texts if t["box"][1] < 0.2 * height]
    header = []
    if top:
        title = max(top, key=lambda t: t["size"])
        if title["size"] >= 1.3 * statistics_median([t["size"] for t in texts]):
            header.append(title)
            below = [t for t in top if t is not title and t["box"][1] > title["box"][1] and t["size"] < title["size"]
                     and len(t["text"].split()) >= 3]
            header.extend(below[:1])
    rest = [t for t in texts if all(t is not h for h in header)]
    heads, bodies, numbers, values, dates, centres = [], [], [], [], [], []
    for t in rest:
        text = t["text"].strip()
        words = len(text.split())
        if CENTRE.match(text):
            centres.append(t)
        elif NUMBERED.match(text):
            t["n"] = int(NUMBERED.match(text).group(1))
            heads.append(t)
        elif YEAR.match(text):
            dates.append(t)
        elif NUMBER.match(text):
            numbers.append(t)
        elif VALUE.match(text):
            values.append(t)
        elif FIXED.match(text):
            continue
        elif words >= 4:
            bodies.append(t)
        elif words <= 3 and re.search(r"[A-Za-z]", text):
            heads.append(t)
        else:
            raise Reject(f"cannot place text {text[:30]!r}")
    merged = False
    if len(heads) < 2 and len(dates) >= 2:
        heads, dates = dates, []
    elif len(heads) < 2 and len(bodies) >= 2 and not dates:
        heads, bodies, merged = bodies, [], True
    if len(heads) < 2:
        raise Reject(f"{len(heads)} item headings")
    if any(abs(s - 1) > 0.02 for t in heads + bodies for s in t["scale"]):
        raise Reject("text inside a resized group")
    order_items(heads, kind)
    items = [{"text" if merged else "head": h} for h in heads]
    for role, slots in (("body", bodies), ("number", numbers), ("value", values), ("date", dates)):
        if len(slots) > len(items):
            raise Reject(f"{len(slots)} {role} slots for {len(items)} items")
        pairs = sorted(((distance(anchor(item)["box"], slot["box"]), i, j)
                        for i, item in enumerate(items) for j, slot in enumerate(slots)))
        used_items, used_slots = set(), set()
        for _, i, j in pairs:
            if i in used_items or j in used_slots:
                continue
            items[i][role] = slots[j]
            used_items.add(i)
            used_slots.add(j)
    if bodies and sum("body" in item for item in items) < len(items):
        raise Reject("some items have no detail")
    if len(centres) > 1:
        raise Reject("more than one centre title")
    return header, items, centres[0] if centres else None


def anchor(item):
    return item.get("head") or item["text"]


def statistics_median(values):
    ordered = sorted(values)
    return ordered[len(ordered) // 2] if ordered else 0


def order_items(heads, kind):
    """Clockwise when a cycle's headings sit around the ring (designers often number them by
    column instead), else by the numbering, else by position."""
    xs = [centre(h["box"])[0] for h in heads]
    ys = [centre(h["box"])[1] for h in heads]
    ring = kind == "cycle" and in_ring(xs, ys)
    if not ring and all("n" in h for h in heads) and len({h["n"] for h in heads}) == len(heads):
        heads.sort(key=lambda h: h["n"])
        return
    if ring:
        cx, cy = sum(xs) / len(xs), sum(ys) / len(ys)
        heads.sort(key=lambda h: (math.atan2(centre(h["box"])[0] - cx, -(centre(h["box"])[1] - cy)) + 2 * math.pi) % (2 * math.pi))
    elif max(xs) - min(xs) > max(ys) - min(ys):
        heads.sort(key=lambda h: centre(h["box"])[0])
    else:
        heads.sort(key=lambda h: centre(h["box"])[1])


def in_ring(xs, ys):
    """True when the points sit around a centre (three or more quadrants, similar distances)."""
    cx, cy = sum(xs) / len(xs), sum(ys) / len(ys)
    distances = [math.hypot(x - cx, y - cy) for x, y in zip(xs, ys)]
    mean = sum(distances) / len(distances)
    if mean == 0:
        return False
    spread = (sum((d - mean) ** 2 for d in distances) / len(distances)) ** 0.5 / mean
    quadrants = {(x > cx, y > cy) for x, y in zip(xs, ys)}
    return len(quadrants) >= 3 and spread < 0.35


def theme_accents(package, slide_part):
    """Source theme's accent colours, by hex, from the theme the slide's master uses."""
    rels = etree.fromstring(package.read(rels_name(slide_part)))
    layout = resolve(slide_part, next(r.get("Target") for r in rels if r.get("Type").endswith("/slideLayout")))
    layout_rels = etree.fromstring(package.read(rels_name(layout)))
    master = resolve(layout, next(r.get("Target") for r in layout_rels if r.get("Type").endswith("/slideMaster")))
    master_rels = etree.fromstring(package.read(rels_name(master)))
    theme = resolve(master, next(r.get("Target") for r in master_rels if r.get("Type").endswith("/theme")))
    scheme = etree.fromstring(package.read(theme)).find(".//" + q("a:clrScheme"))
    colors = {}
    for n in range(1, 7):
        slot = scheme.find(q(f"a:accent{n}"))
        value = slot.find(q("a:srgbClr")) if slot is not None else None
        if value is not None:
            colors.setdefault(value.get("val").upper(), f"accent{n}")
    return colors


def rels_name(part):
    folder, name = part.rsplit("/", 1)
    return f"{folder}/_rels/{name}.rels"


def resolve(base, target):
    parts = base.rsplit("/", 1)[0].split("/")
    for piece in target.split("/"):
        if piece == "..":
            parts.pop()
        elif piece and piece != ".":
            parts.append(piece)
    return "/".join(parts)


def recolour(tree, accents):
    """Fixed colours equal to a source accent become that theme slot; returns (slots, fixed saturated)."""
    mapped = fixed = 0
    for color in list(tree.iter(q("a:srgbClr"))):
        slot = accents.get(color.get("val", "").upper())
        if slot is None:
            fixed += saturated(color.get("val", "000000"))
            continue
        scheme = etree.Element(q("a:schemeClr"), val=slot)
        for child in color:
            scheme.append(child)
        color.getparent().replace(color, scheme)
        mapped += 1
    mapped += sum(1 for c in tree.iter(q("a:schemeClr")) if c.get("val", "").startswith("accent"))
    return mapped, fixed


def saturated(hex_value):
    r, g, b = (int(hex_value[i:i + 2], 16) / 255 for i in (0, 2, 4))
    high, low = max(r, g, b), min(r, g, b)
    return 1 if high > 0 and (high - low) / high > 0.35 and high > 0.25 else 0


def set_fonts(tree):
    for run in tree.iter(q("a:rPr"), q("a:endParaRPr"), q("a:defRPr")):
        latin = run.find(q("a:latin"))
        if latin is not None and not latin.get("typeface", "").startswith("+"):
            latin.set("typeface", LATIN)
        existing = run.find(q("a:cs"))
        if existing is not None:
            existing.set("typeface", BANGLA)
        else:
            cs = etree.Element(q("a:cs"), typeface=BANGLA)
            anchor = run.find(q("a:ea"))
            anchor = anchor if anchor is not None else latin
            if anchor is not None:
                anchor.addnext(cs)


def name_slots(items, centre_slot):
    for number, item in enumerate(items, 1):
        for role in ("head", "text", "body", "number", "value", "date"):
            if role in item:
                set_name(item[role]["el"], f"slot:item{number}.{role}")
    if centre_slot:
        set_name(centre_slot["el"], "slot:centre")


def set_name(element, name):
    element.find(".//" + q("p:cNvPr")).set("name", name)


def bounding_box(tree):
    boxes = [box for _, box, _ in walk(tree)]
    x0 = min(b[0] for b in boxes)
    y0 = min(b[1] for b in boxes)
    x1 = max(b[0] + b[2] for b in boxes)
    y1 = max(b[1] + b[3] for b in boxes)
    return [round(v / EMU, 3) for v in (x0, y0, x1 - x0, y1 - y0)]


def strip_links(tree):
    for link in list(tree.iter(q("a:hlinkClick"), q("a:hlinkHover"))):
        link.getparent().remove(link)


def candidates(catalogue, picks, kinds):
    rows = [json.loads(line) for line in Path(catalogue).read_text(encoding="utf8").splitlines()]
    if picks:
        chosen = json.loads(Path(picks).read_text(encoding="utf8"))
        by_id = {row["id"].replace("-powerpoint-infographics", ""): row for row in rows}
        return [(by_id[pick["id"]], pick["kind"]) for pick in chosen]
    wanted = {topic: kind for kind, topics in V1.items() if kind in kinds for topic in topics}
    return [(row, wanted[row["topic"]]) for row in rows if row["pack"] == "A" and row["topic"] in wanted]


def source_path(catalogue, deck):
    decks = json.loads((Path(catalogue).parent / "decks.json").read_text(encoding="utf8"))
    return next(d["path"] for d in decks if d["deck"] == deck)


def slide_parts(package):
    presentation = etree.fromstring(package.read("ppt/presentation.xml"))
    rels = {r.get("Id"): r.get("Target") for r in etree.fromstring(package.read("ppt/_rels/presentation.xml.rels"))}
    ids = presentation.find(q("p:sldIdLst"))
    size = presentation.find(q("p:sldSz"))
    parts = [resolve("ppt/presentation.xml", rels[e.get("{%s}id" % NS_R)]) for e in ids]
    return parts, int(size.get("cx")), int(size.get("cy"))


def build(catalogue, library, picks=None, kinds=tuple(V1)):
    library.mkdir(parents=True, exist_ok=True)
    decks, manifest, rejected = {}, [], Counter()
    reasons = []
    for row, kind in candidates(catalogue, picks, kinds):
        path = source_path(catalogue, row["deck"])
        if path not in decks:
            package = zipfile.ZipFile(path)
            decks[path] = (package, *slide_parts(package))
        package, parts, width, height = decks[path]
        part = parts[row["slide"] - 1]
        slide_xml = etree.fromstring(package.read(part))
        try:
            header, items, centre_slot = analyse(slide_xml, width, height, kind)
        except Reject as reason:
            rejected[str(reason).split(" ")[0] if "cannot" not in str(reason) else "cannot place text"] += 1
            reasons.append(f"{row['id']}: {reason}")
            continue
        for h in header:
            h["el"].getparent().remove(h["el"])
        name_slots(items, centre_slot)
        tree = slide_xml.find(q("p:cSld") + "/" + q("p:spTree"))
        mapped, fixed = recolour(tree, theme_accents(package, part))
        if mapped == 0 or fixed > mapped:
            rejected["colours"] += 1
            reasons.append(f"{row['id']}: colours do not follow the theme ({mapped} slots, {fixed} fixed)")
            continue
        strip_links(tree)
        set_fonts(tree)
        scale(tree, Inches(13.333) / width)
        roles = sorted({role for item in items for role in item})
        manifest.append({
            "id": row["id"].replace("-powerpoint-infographics", ""),
            "kind": kind,
            "items": len(items),
            "roles": roles + (["centre"] if centre_slot else []),
            "bbox": bounding_box(tree),
            "source": f"{Path(path).name}#{row['slide']}",
            "tree": tree,
        })
    write_library(library, manifest)
    return manifest, rejected, reasons


def write_library(library, manifest):
    by_kind = {}
    for entry in manifest:
        by_kind.setdefault(entry["kind"], []).append(entry)
    index = []
    for kind, entries in sorted(by_kind.items()):
        deck = Presentation()
        deck.slide_width, deck.slide_height = Inches(13.333), Inches(7.5)
        blank = deck.slide_layouts[6]
        for number, entry in enumerate(entries, 1):
            slide = deck.slides.add_slide(blank)
            target = slide.shapes._spTree
            for child in entry["tree"]:
                if etree.QName(child).localname in ("nvGrpSpPr", "grpSpPr"):
                    continue
                target.append(copy.deepcopy(child))
            tree = entry.pop("tree")
            del tree
            index.append({**entry, "file": f"{kind}.pptx", "slide": number})
        deck.save(library / f"{kind}.pptx")
    (library / "manifest.json").write_text(json.dumps(index, ensure_ascii=False, indent=1), encoding="utf8")


def main(argv):
    parser = argparse.ArgumentParser(description="Prepare infographic slides into a library.")
    parser.add_argument("catalogue")
    parser.add_argument("library", type=Path)
    parser.add_argument("--pick", help="JSON list of {id, kind} to build instead of the version 1 folders")
    parser.add_argument("--kinds", default=",".join(V1))
    parser.add_argument("--reasons", action="store_true", help="print why each rejected slide was set aside")
    args = parser.parse_args(argv)
    manifest, rejected, reasons = build(args.catalogue, args.library, args.pick, tuple(args.kinds.split(",")))
    print(f"prepared {len(manifest)} designs into {args.library}")
    print("by kind and item count:", dict(sorted(Counter(f"{e['kind']}:{e['items']}" for e in manifest).items())))
    print("set aside:", dict(rejected.most_common()))
    if args.reasons:
        print("\n".join(reasons))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
