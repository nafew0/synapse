"""Render a 640 px thumbnail of every indexed slide, for sort.py.

    python3 render.py out          # inside an image with LibreOffice and Poppler

Reads out/decks.json, writes out/thumbs/<deck>/<NNN>.png and skips decks that already have
every thumbnail, so it can be stopped and rerun. Runs four LibreOffice instances side by
side, each with its own profile. Run it with the packs mounted read-only at the same paths
they have on the host and with no network (see README.md).
"""

import json
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

WIDTH = 640
WORKERS = 4


def convert(path, work, worker):
    profile = f"-env:UserInstallation=file:///tmp/lo-profile-{worker}"
    result = subprocess.run(
        ["soffice", profile, "--headless", "--convert-to", "pdf", "--outdir", work, path],
        capture_output=True, text=True, timeout=1800,
    )
    return next(Path(work).glob("*.pdf"), None), result.stderr.strip()[-200:]


def warm_up(worker):
    """Create a worker's LibreOffice profile once, alone: first starts racing each other fail."""
    with tempfile.TemporaryDirectory() as work:
        blank = Path(work) / "blank.txt"
        blank.write_text("x")
        convert(str(blank), work, worker)


def render(deck, out, worker):
    target = out / "thumbs" / deck["deck"]
    expected = deck.get("slides", 0)
    if target.is_dir() and expected and len(list(target.glob("*.png"))) >= expected:
        return deck["deck"], "skipped"
    target.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as work:
        pdf, error = convert(deck["path"], work, worker)
        if pdf is None:
            pdf, error = convert(deck["path"], work, worker)
        if pdf is None:
            return deck["deck"], f"FAILED: {error}"
        subprocess.run(["pdftoppm", "-png", "-scale-to-x", str(WIDTH), "-scale-to-y", "-1", str(pdf), f"{work}/s"], check=True)
        pages = sorted(Path(work).glob("s-*.png"), key=lambda p: int(p.stem.split("-")[-1]))
        for number, page in enumerate(pages, 1):
            shutil.move(page, target / f"{number:03d}.png")
    return deck["deck"], f"{len(pages)} slides"


def render_with_slot(deck, out, slots):
    """Each running conversion holds one profile, so no two instances share a profile."""
    worker = slots.pop()
    try:
        return render(deck, out, worker)
    except Exception as error:  # noqa: BLE001 - one bad deck must not stop the rest
        return deck["deck"], f"FAILED: {error}"
    finally:
        slots.append(worker)


def main(argv):
    out = Path(argv[0])
    decks = json.loads((out / "decks.json").read_text(encoding="utf8"))
    counts = {}
    for line in (out / "catalogue.jsonl").read_text(encoding="utf8").splitlines():
        deck = json.loads(line)["deck"]
        counts[deck] = counts.get(deck, 0) + 1
    for deck in decks:
        deck["slides"] = counts.get(deck["deck"], 0)
    for worker in range(WORKERS):
        warm_up(worker)
    done = 0
    slots = list(range(WORKERS))
    with ThreadPoolExecutor(WORKERS) as pool:
        futures = [pool.submit(render_with_slot, deck, out, slots) for deck in decks]
        for future in as_completed(futures):
            name, status = future.result()
            done += 1
            print(f"[{done}/{len(decks)}] {name}: {status}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
