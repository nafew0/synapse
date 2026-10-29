"""Build a Word document and run every check on it in one call.

    python3 check.py <out.docx> [--build /mnt/data/qa/build.js.txt] [--original src.docx]

Runs the generator (with --build), validate.py (with --original for an edit), renders the
document, and draws its pages into one grid image. The last lines are a short report and the
grid's path: read that one image, not the pages one by one. Exit 0 when everything passed,
2 when something needs fixing.
"""

import argparse
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))
from office.soffice import run_soffice  # noqa: E402

GRID_COLUMNS = 4
GRID_PAGES = 8
PAGE_WIDTH = 420


def run(*args, cwd=None):
    result = subprocess.run([str(a) for a in args], capture_output=True, text=True, cwd=cwd)
    return result.returncode, (result.stdout + result.stderr).strip()


def tail(text, lines=12):
    return "\n".join(text.splitlines()[-lines:])


def page_grid(pages, out_path):
    """Up to GRID_PAGES pages, numbered, in one image small enough for a single read."""
    tiles = []
    for number, page in enumerate(pages[:GRID_PAGES], 1):
        image = Image.open(page).convert("RGB")
        image = image.resize((PAGE_WIDTH, round(image.height * PAGE_WIDTH / image.width)))
        tiles.append(image)
    columns = min(GRID_COLUMNS, len(tiles))
    rows = (len(tiles) + columns - 1) // columns
    tile_height = max(tile.height for tile in tiles)
    grid = Image.new("RGB", (columns * (PAGE_WIDTH + 10), rows * (tile_height + 10)), (200, 200, 200))
    for index, tile in enumerate(tiles):
        grid.paste(tile, ((index % columns) * (PAGE_WIDTH + 10), (index // columns) * (tile_height + 10)))
    grid.save(out_path, quality=75)


def main(argv):
    parser = argparse.ArgumentParser(description="Build a Word document and run every check on it.")
    parser.add_argument("document", type=Path)
    parser.add_argument("--build", type=Path, help="generator script to run with node first")
    parser.add_argument("--original", type=Path, help="the document this one was edited from")
    args = parser.parse_args(argv)

    if args.build:
        build = args.build.resolve()
        code, output = run("node", build, cwd=build.parent)
        if code != 0:
            print(f"build FAILED:\n{tail(output)}")
            return 2
    if not args.document.exists():
        print(f"no document at {args.document}: the build did not write it")
        return 2

    report = []
    failed = False
    original = ["--original", args.original] if args.original else []
    code, output = run(sys.executable, SCRIPTS / "office" / "validate.py", args.document, *original)
    if code == 0:
        report.append("validation: passed")
    else:
        failed = True
        report.append(f"validation: FAILED\n{tail(output)}")

    qa = Path("/mnt/data/qa") if Path("/mnt/data").exists() else args.document.resolve().parent / "qa"
    qa.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as work:
        run_soffice(["--headless", "--convert-to", "pdf", "--outdir", work, str(args.document.resolve())], capture_output=True, timeout=180)
        pdf = Path(work) / (args.document.stem + ".pdf")
        if not pdf.exists():
            report.append("render: could not render the document")
            print("\n".join(report))
            return 2
        info = subprocess.run(["pdfinfo", str(pdf)], capture_output=True, text=True).stdout
        pages = int(re.search(r"Pages:\s+(\d+)", info).group(1))
        subprocess.run(["pdftoppm", "-png", "-r", "60", "-l", str(GRID_PAGES), str(pdf), str(Path(work) / "p")], check=True)
        grid = qa / f"{args.document.stem}-pages.jpg"
        page_grid(sorted(Path(work).glob("p-*.png")), grid)
    shown = min(pages, GRID_PAGES)
    report.append(f"pages: {pages}")
    report.append(f"grid: {grid}  (pages 1-{shown}; read this image once)")
    print("\n".join(report))
    return 2 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
