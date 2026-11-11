"""Index every slide of the infographic packs into one catalogue, with a first guess at its kind.

    python3 index.py --pack A=/path/to/01-MASSIVE-Powerpoint-Infographics \
                     --pack B="/path/to/5000+ Infographics" --out out

Writes out/catalogue.jsonl (one line per slide) and out/decks.json (each deck's id and path,
for render.py). Reads the files only; nothing in the packs is changed.

The guess comes from the folder or deck name when it names a kind (confidence "name"), else
from the slide's structure: shapes in a ring, a narrowing stack, a 2x2 grid, a row of years, a
chart or table frame, percentages, many map pieces (confidence "shape"). It is a starting
point for sort.py, where a person confirms or changes it.
"""

import argparse
import json
import re
import statistics
import sys
import zipfile
from pathlib import Path

from lxml import etree

sys.path.insert(0, str(Path(__file__).resolve().parent))
from kinds import named_kind  # noqa: E402

NS = {
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
}
EMU = 914400
SLIDE = re.compile(r"ppt/slides/slide(\d+)\.xml$")
YEAR = re.compile(r"\b(19|20)\d{2}\b")
MONTH = re.compile(r"\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\bq[1-4]\b|\bweek\b|\bday \d", re.I)
PERCENT = re.compile(r"\d+\s?%")
NUMBERED = re.compile(r"^(?:title|step|phase|option|stage|item|level)?\s*0?(\d)$", re.I)
SKIP_DECKS = re.compile(r"arrows small size", re.I)


def q(tag):
    prefix, name = tag.split(":")
    return f"{{{NS[prefix]}}}{name}"


def xfrm_box(element):
    xfrm = element.find(".//" + q("a:xfrm"))
    if xfrm is None:
        return None
    off, ext = xfrm.find(q("a:off")), xfrm.find(q("a:ext"))
    if off is None or ext is None:
        return None
    return [int(off.get("x")), int(off.get("y")), int(ext.get("cx")), int(ext.get("cy"))]


def walk(tree, transform=(0, 0, 1.0, 1.0)):
    """Yield (element, absolute box) for every leaf shape, following group transforms."""
    dx, dy, sx, sy = transform
    for child in tree:
        tag = etree.QName(child).localname
        if tag == "grpSp":
            xfrm = child.find(q("p:grpSpPr") + "/" + q("a:xfrm"))
            if xfrm is None:
                yield from walk(child, transform)
                continue
            off, ext = xfrm.find(q("a:off")), xfrm.find(q("a:ext"))
            ch_off, ch_ext = xfrm.find(q("a:chOff")), xfrm.find(q("a:chExt"))
            if None in (off, ext, ch_off, ch_ext):
                yield from walk(child, transform)
                continue
            gsx = int(ext.get("cx")) / max(1, int(ch_ext.get("cx")))
            gsy = int(ext.get("cy")) / max(1, int(ch_ext.get("cy")))
            inner = (
                dx + sx * (int(off.get("x")) - int(ch_off.get("x")) * gsx),
                dy + sy * (int(off.get("y")) - int(ch_off.get("y")) * gsy),
                sx * gsx,
                sy * gsy,
            )
            yield from walk(child, inner)
        elif tag in ("sp", "pic", "graphicFrame", "cxnSp"):
            box = xfrm_box(child)
            if box is None:
                continue
            x, y, w, h = box
            yield child, [dx + sx * x, dy + sy * y, sx * w, sy * h]


def text_of(element):
    return " ".join(t.text or "" for t in element.iter(q("a:t"))).strip()


def font_size(element):
    sizes = [int(r.get("sz")) / 100 for r in element.iter(q("a:rPr")) if r.get("sz")]
    return max(sizes, default=0)


def slide_features(xml, width, height):
    root = etree.fromstring(xml)
    tree = root.find(q("p:cSld") + "/" + q("p:spTree"))
    texts, blobs = [], []
    counts = {"shapes": 0, "pictures": 0, "custom": 0, "charts": 0, "tables": 0, "lines": 0}
    for element, (x, y, w, h) in walk(tree):
        tag = etree.QName(element).localname
        counts["shapes"] += 1
        if tag == "pic":
            counts["pictures"] += 1
            continue
        if tag == "cxnSp":
            counts["lines"] += 1
            continue
        if tag == "graphicFrame":
            uri = element.find(".//" + q("a:graphicData"))
            uri = uri.get("uri", "") if uri is not None else ""
            counts["charts" if "chart" in uri else "tables" if "table" in uri else "shapes"] += 1
            continue
        if element.find(".//" + q("a:custGeom")) is not None:
            counts["custom"] += 1
        text = text_of(element)
        box = [round(v / EMU, 2) for v in (x, y, w, h)]
        if text:
            texts.append({"text": text[:80], "box": box, "size": font_size(element)})
        area = (w * h) / (width * height)
        if 0.004 <= area <= 0.2 and len(text) <= 3:
            blobs.append((x + w / 2, y + h / 2, w, h))
    return texts, blobs, counts


def similar(blobs):
    """The largest set of blobs whose areas are within 35% of each other."""
    best = []
    for _, _, w, h in blobs:
        area = w * h
        group = [b for b in blobs if 0.65 <= (b[2] * b[3]) / area <= 1.35]
        if len(group) > len(best):
            best = group
    return best


def ring(blobs, width):
    if len(blobs) < 3:
        return False
    cx = statistics.mean(b[0] for b in blobs)
    cy = statistics.mean(b[1] for b in blobs)
    distances = [((b[0] - cx) ** 2 + (b[1] - cy) ** 2) ** 0.5 for b in blobs]
    mean = statistics.mean(distances)
    if mean < 0.06 * width or statistics.pstdev(distances) / mean > 0.2:
        return False
    quadrants = {(b[0] > cx, b[1] > cy) for b in blobs}
    return len(quadrants) >= 3


def stack(blobs, width):
    """'funnel' or 'pyramid' when shapes are centred on one vertical line and their widths change in step."""
    if len(blobs) < 3:
        return None
    middle = statistics.median(b[0] for b in blobs)
    column = sorted((b for b in blobs if abs(b[0] - middle) < 0.03 * width), key=lambda b: b[1])
    if len(column) < 3:
        return None
    widths = [b[2] for b in column]
    if all(a > b * 1.05 for a, b in zip(widths, widths[1:])):
        return "funnel"
    if all(b > a * 1.05 for a, b in zip(widths, widths[1:])):
        return "pyramid"
    return None


def grid(blobs):
    if len(blobs) != 4:
        return False
    xs = sorted(b[0] for b in blobs)
    ys = sorted(b[1] for b in blobs)
    return xs[1] - xs[0] < xs[2] - xs[1] and ys[1] - ys[0] < ys[2] - ys[1]


def row(blobs, height):
    if len(blobs) < 3:
        return False
    return statistics.pstdev(b[1] for b in blobs) < 0.04 * height


def guess(texts, blobs, counts, width, height):
    words = " ".join(t["text"] for t in texts)
    peers = similar(blobs)
    if counts["charts"]:
        return "chart"
    if counts["tables"]:
        return "table"
    if counts["custom"] > 60 and len(texts) < 12 and counts["custom"] > 4 * max(1, len(blobs)):
        return "map" if len(texts) <= 8 else "illustration"
    if counts["pictures"] and not texts:
        return "illustration"
    if len(texts) <= 3 and max((t["size"] for t in texts), default=0) >= 60 and len(blobs) < 4:
        return "cover"
    kind = stack(peers, width)
    if kind:
        return kind
    if grid(peers):
        return "matrix"
    if ring(peers, width):
        centre = any(abs(b[0] - statistics.mean(p[0] for p in peers)) < 0.05 * width
                     and abs(b[1] - statistics.mean(p[1] for p in peers)) < 0.05 * height
                     and b[2] * b[3] > 1.3 * statistics.mean(p[2] * p[3] for p in peers) for b in blobs)
        return "hub" if centre else "cycle"
    if len(YEAR.findall(words)) >= 3 or len(MONTH.findall(words)) >= 3:
        return "timeline"
    if len(PERCENT.findall(words)) >= 2:
        return "kpi"
    if row(peers, height):
        return "process"
    return None


def item_count(texts, blobs):
    numbers = {int(m.group(1)) for t in texts if (m := NUMBERED.match(t["text"].strip()))}
    if len(numbers) >= 2 and max(numbers) == len(numbers):
        return max(numbers)
    heads = [t for t in texts if re.match(r"^title\s*\d+$|^title here$|^lorem ipsum$", t["text"], re.I)]
    if len(heads) >= 2:
        return len(heads)
    peers = similar(blobs)
    return len(peers) if len(peers) >= 2 else None


def deck_slides(path):
    with zipfile.ZipFile(path) as package:
        presentation = etree.fromstring(package.read("ppt/presentation.xml"))
        size = presentation.find(q("p:sldSz"))
        width, height = int(size.get("cx")), int(size.get("cy"))
        order = slide_order(package)
        for number, part in enumerate(order, 1):
            yield number, package.read(part), width, height


def slide_order(package):
    """Slide part names in presentation order, via presentation.xml's relationship ids."""
    rels = etree.fromstring(package.read("ppt/_rels/presentation.xml.rels"))
    targets = {r.get("Id"): "ppt/" + r.get("Target").lstrip("/").removeprefix("ppt/") for r in rels}
    presentation = etree.fromstring(package.read("ppt/presentation.xml"))
    rel = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
    ids = presentation.find(q("p:sldIdLst"))
    if ids is None:
        return []
    return [targets[entry.get(rel)] for entry in ids if entry.get(rel) in targets]


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def index(packs, out):
    out.mkdir(parents=True, exist_ok=True)
    decks, lines = [], []
    for pack, root in packs:
        for path in sorted(root.rglob("*.pptx")):
            if SKIP_DECKS.search(path.stem):
                continue
            relative = path.relative_to(root)
            folder = relative.parts[0] if len(relative.parts) > 1 else path.stem
            topic = re.sub(r"\s*powerpoint infographics$", "", folder, flags=re.I)
            deck = f"{pack.lower()}-{slug(str(relative.with_suffix('')))}"
            named = named_kind(topic)
            decks.append({"deck": deck, "pack": pack, "topic": topic, "path": str(path)})
            for number, xml, width, height in deck_slides(path):
                texts, blobs, counts = slide_features(xml, width, height)
                shaped = guess(texts, blobs, counts, width, height)
                lines.append({
                    "id": f"{deck}-{number:03d}",
                    "deck": deck,
                    "pack": pack,
                    "topic": topic,
                    "slide": number,
                    "guess": named or shaped,
                    "confidence": "name" if named else ("shape" if shaped else "none"),
                    "shape_guess": shaped,
                    "items": item_count(texts, blobs),
                    "counts": counts,
                    "texts": texts[:30],
                    "size": [round(width / EMU, 2), round(height / EMU, 2)],
                })
    with open(out / "catalogue.jsonl", "w", encoding="utf8") as handle:
        handle.writelines(json.dumps(line, ensure_ascii=False) + "\n" for line in lines)
    (out / "decks.json").write_text(json.dumps(decks, ensure_ascii=False, indent=1), encoding="utf8")
    return decks, lines


def main(argv):
    parser = argparse.ArgumentParser(description="Index infographic packs.")
    parser.add_argument("--pack", action="append", required=True, help="NAME=folder, repeatable")
    parser.add_argument("--out", type=Path, default=Path(__file__).resolve().parent / "out")
    args = parser.parse_args(argv)
    packs = [(name, Path(folder)) for name, folder in (p.split("=", 1) for p in args.pack)]
    decks, lines = index(packs, args.out)
    by = {}
    for line in lines:
        by[line["confidence"]] = by.get(line["confidence"], 0) + 1
    print(f"{len(decks)} decks, {len(lines)} slides -> {args.out / 'catalogue.jsonl'}")
    print("guessed from name:", by.get("name", 0), "| from shape:", by.get("shape", 0), "| no guess:", by.get("none", 0))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
