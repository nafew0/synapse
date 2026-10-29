"""Cut logos, signatures and seals out of a scanned page in one call.

    python3 crop.py <scan> <out_dir> name=x0,y0,x1,y1 [name=x0,y0,x1,y1 ...]
    python3 crop.py <scan> <out_dir> --read

--read writes the page as two overlapping halves enlarged 2x (read-top.png and
read-bottom.png), so small print is easier to read; read them together with the scan.

Coordinates are pixels in the scan as given (`file <scan>` prints its size). Each box is
padded a little, trimmed to the ink inside it, given a pure white background, and saved
as <out_dir>/<name>.png at the scan's own resolution. Prints one line per crop with its
size, so the build can place it at the size it had on the page.
"""

import sys
from pathlib import Path

from PIL import Image, ImageOps

PAD = 6
INK = 200
WHITE = 225


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


def reading_halves(scan, out_dir):
    """Two overlapping halves at twice the size: small Bangla print reads far better enlarged."""
    overlap = scan.height // 12
    middle = scan.height // 2
    halves = {"read-top": (0, 0, scan.width, middle + overlap), "read-bottom": (0, middle - overlap, scan.width, scan.height)}
    for name, box in halves.items():
        half = scan.crop(box)
        half = half.resize((half.width * 2, half.height * 2), Image.LANCZOS)
        path = out_dir / f"{name}.png"
        half.save(path)
        print(f"{name}: {path} (scan rows {box[1]}-{box[3]})")
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
        region = scan.crop(clamp_box(box, scan.width, scan.height))
        region, found = trim_to_ink(region)
        if not found:
            print(f"{name}: no ink inside {box}; check the coordinates")
            failed += 1
            continue
        path = out_dir / f"{name}.png"
        whiten(region).save(path)
        print(f"{name}: {path} {region.width}x{region.height}px")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
