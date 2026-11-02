"""Turn a scanned page or PDF into Word in one call, from read_document's elements.

    python3 scan_to_docx.py <name.elements.json> <source pdf or image> <out.docx>

Renders the source, builds the spec with the page's own margins and table columns, crops the
pictures at their size on the page, then runs letter.py. The last lines are the report. Read
qa/<out>-compare.jpg afterwards. To change anything, edit qa/spec.json and rerun letter.py.
"""

import json
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageFilter, ImageOps

sys.path.insert(0, str(Path(__file__).resolve().parent))
from elements_spec import convert  # noqa: E402

RENDER_DPI = 150
PAGE_WIDTH_CM = 21.0
DARK = 170
RULE_MIN_SHARE = 0.95
RULE_ROW_STEP = 2
RULE_SEARCH = 16
RULE_SPREAD = 3
BLOB_REACH = 3
INK_GAP_ROWS = 12
MAX_SIGNATURE_GROWTH = 200


def render_pages(source, qa):
    """One image per page, in order. An image source is its own single page."""
    if Path(source).suffix.lower() != ".pdf":
        return [Path(source)]
    stem = qa / "page"
    subprocess.run(["pdftoppm", "-r", str(RENDER_DPI), "-png", str(source), str(stem)], check=True)
    return sorted(qa.glob("page-*.png"))


def table_widths(image, box, columns, cm_per_pixel):
    """Column widths from the table's ruled lines on the scan, or None when they cannot be seen.

    A scan is often slightly skewed, so a rule spreads over a few columns of pixels: each column is
    counted together with its neighbours.
    """
    x0, y0, x1, y1 = box
    region = ImageOps.grayscale(image.crop((max(x0 - RULE_SEARCH, 0), y0, x1 + RULE_SEARCH, y1)))
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
        return None
    return [round((b - a) * cm_per_pixel, 2) for a, b in zip(positions, positions[1:])]


def apply_table_widths(spec, pages, cm_per_pixel):
    for block in spec["blocks"]:
        box = block.pop("box", None)
        page = block.pop("box_page", 1)
        if block["type"] != "table" or not box or page > len(pages):
            continue
        columns = sum(int(cell.get("colspan", 1)) for cell in block["rows"][0])
        with Image.open(pages[page - 1]) as image:
            widths = table_widths(image.convert("RGB"), box, columns, cm_per_pixel)
        if widths:
            block["widths_cm"] = widths


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


def place_pictures(spec, made, qa, cm_per_pixel):
    """Sets each picture to its size on the page. One with no crop is left out and reported."""
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
                    block[width_key] = round(image.width * cm_per_pixel, 2)
            else:
                missing.append(name)
                del block[key]
        if block["type"] != "image" or block.get("path"):
            kept.append(block)
    spec["blocks"] = kept
    return missing


def main(argv):
    if len(argv) != 3:
        print(__doc__)
        return 1
    elements_path, source, out = argv
    qa = Path(out).resolve().parent / "qa"
    qa.mkdir(parents=True, exist_ok=True)

    pages = render_pages(source, qa)
    with Image.open(pages[0]) as first:
        scan_size = first.size
    cm_per_pixel = PAGE_WIDTH_CM / scan_size[0]

    elements = json.loads(Path(elements_path).read_text(encoding="utf-8"))
    spec, crops = convert(elements, scan_size, str(qa))
    apply_table_widths(spec, pages, cm_per_pixel)
    missing = place_pictures(spec, run_crops(crops, pages, qa), qa, cm_per_pixel)

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
