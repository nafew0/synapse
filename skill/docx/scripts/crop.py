"""Cut logos, signatures and seals out of a scanned page in one call.

    python3 crop.py <scan> <out_dir> name=x0,y0,x1,y1 [name=x0,y0,x1,y1 ...]
    python3 crop.py <scan> <out_dir> --read

--read writes the page as two overlapping halves enlarged up to 2x (read-top.jpg and
read-bottom.jpg), so small print is easier to read, and grid.jpg, the whole page with pixel
rulers, to take crop boxes from.

Coordinates are pixels in the scan as given (`file <scan>` prints its size). Each box is
padded a little, trimmed to the ink inside it, given a pure white background, and saved
as <out_dir>/<name>.png at the scan's own resolution. Prints one line per crop with its
size, so the build can place it at the size it had on the page, and warns when a box cuts
through ink at its edge.
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps

PAD = 6
INK = 200
# Vision models downsample past this, and read_file refuses images over 1 MB.
READ_EDGE = 1568
WHITE = 225
GRID_STEP = 100
MIN_CUT_PIXELS = 2


def parse_box(spec):
    name, _, coords = spec.partition("=")
    values = [int(round(float(v))) for v in coords.split(",")]
    if not name or len(values) != 4:
        raise ValueError(f"expected name=x0,y0,x1,y1, got {spec!r}")
    return name, values


def clamp_box(box, width, height):
    x0, y0, x1, y1 = box
    left, right = sorted((x0, x1))
    top, bottom = sorted((y0, y1))
    return (
        max(0, left - PAD),
        max(0, top - PAD),
        min(width, right + PAD),
        min(height, bottom + PAD),
    )


def whiten(region):
    """Paper tone and scanner grain become white; ink keeps its colour."""
    gray = ImageOps.grayscale(region)
    mask = gray.point(lambda v: 255 if v >= WHITE else 0)
    white = Image.new("RGB", region.size, "white")
    return Image.composite(white, region, mask)


def trim_to_ink(region):
    gray = ImageOps.grayscale(region)
    ink = gray.point(lambda v: 255 if v < INK else 0)
    bbox = ink.getbbox()
    if bbox is None:
        return region, False
    left, top, right, bottom = bbox
    return region.crop((
        max(0, left - PAD),
        max(0, top - PAD),
        min(region.width, right + PAD),
        min(region.height, bottom + PAD),
    )), True


def cut_sides(region, box, scan):
    """Sides where ink runs out through the box, which means the box slices the picture."""
    pixels = ImageOps.grayscale(region).load()
    width, height = region.size
    edges = {
        "left": (box[0] > 0, ((0, y) for y in range(height))),
        "right": (box[2] < scan.width, ((width - 1, y) for y in range(height))),
        "top": (box[1] > 0, ((x, 0) for x in range(width))),
        "bottom": (box[3] < scan.height, ((x, height - 1) for x in range(width))),
    }
    return [
        side
        for side, (inside, points) in edges.items()
        if inside and sum(pixels[point] < INK for point in points) >= MIN_CUT_PIXELS
    ]


def pixel_grid(scan, out_dir):
    """The whole page with a ruled line and label every GRID_STEP pixels of the scan."""
    scale = min(1, READ_EDGE / max(scan.size))
    grid = scan.resize((round(scan.width * scale), round(scan.height * scale)), Image.LANCZOS)
    draw = ImageDraw.Draw(grid)
    for x in range(GRID_STEP, scan.width, GRID_STEP):
        draw.line((x * scale, 0, x * scale, grid.height), fill=(255, 0, 0), width=1)
        draw.text((x * scale + 2, 2), str(x), fill=(255, 0, 0))
    for y in range(GRID_STEP, scan.height, GRID_STEP):
        draw.line((0, y * scale, grid.width, y * scale), fill=(255, 0, 0), width=1)
        draw.text((2, y * scale + 2), str(y), fill=(255, 0, 0))
    path = out_dir / "grid.jpg"
    grid.save(path, quality=85)
    print(f"grid: {path} (labels are scan pixels)")


def reading_halves(scan, out_dir):
    """Two overlapping halves at twice the size: small Bangla print reads far better enlarged."""
    overlap = scan.height // 12
    middle = scan.height // 2
    halves = {"read-top": (0, 0, scan.width, middle + overlap), "read-bottom": (0, middle - overlap, scan.width, scan.height)}
    for name, box in halves.items():
        half = scan.crop(box)
        scale = min(2, READ_EDGE / max(half.size))
        if scale > 1:
            half = half.resize((round(half.width * scale), round(half.height * scale)), Image.LANCZOS)
        path = out_dir / f"{name}.jpg"
        half.save(path, quality=85)
        print(f"{name}: {path} (scan rows {box[1]}-{box[3]})")
    pixel_grid(scan, out_dir)
    return 0


def main(argv):
    if len(argv) == 3 and argv[2] == "--read":
        out_dir = Path(argv[1])
        out_dir.mkdir(parents=True, exist_ok=True)
        return reading_halves(Image.open(argv[0]).convert("RGB"), out_dir)
    if len(argv) < 3:
        print(__doc__.strip())
        return 1
    scan = Image.open(argv[0]).convert("RGB")
    out_dir = Path(argv[1])
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"scan: {scan.width}x{scan.height}px")
    failed = 0
    for spec in argv[2:]:
        try:
            name, box = parse_box(spec)
        except ValueError as error:
            print(f"error: {error}")
            failed += 1
            continue
        clamped = clamp_box(box, scan.width, scan.height)
        region = scan.crop(clamped)
        cut = cut_sides(region, clamped, scan)
        region, found = trim_to_ink(region)
        if not found:
            print(f"{name}: no ink inside {box}; check the coordinates")
            failed += 1
            continue
        path = out_dir / f"{name}.png"
        whiten(region).save(path)
        print(f"{name}: {path} {region.width}x{region.height}px")
        if cut:
            print(f"{name}: BOX CUTS INK on its {', '.join(cut)} side. Move that side outward to the end of the handwriting, or inward past stray print, and crop again. Ink that truly touches a printed name is fine.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
