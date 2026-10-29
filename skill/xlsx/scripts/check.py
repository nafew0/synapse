"""Recalculate a workbook and run every gate on it in one call.

    python3 check.py <out.xlsx> [--original src.xlsx --allow 'Sheet!B2:D9' ... --new-sheet NAME[:TEMPLATE] ...]
                     [--formula 'Sheet!F12' ... --expect 'Sheet!F12=150000' ...]

Runs recalc.py (which rewrites the file in place), verify_calculations.py when --formula or
--expect is given, verify_structure.py when --original is given, and renders the first pages
into one image. The last lines are a short report and that image's path. Exit 0 when every
gate passed, 2 when something needs fixing. Never deliver on 2.
"""

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))
from office.soffice import run_soffice  # noqa: E402

MAX_PAGES = 4


def run(*args):
    result = subprocess.run([str(a) for a in args], capture_output=True, text=True)
    return result.returncode, result.stdout.strip(), result.stderr.strip()


def parse_json(text):
    try:
        return json.loads(text[text.index("{"):])
    except (ValueError, json.JSONDecodeError):
        return None


def render_pages(workbook, out_path):
    """The first pages side by side in one image, so one read shows the printed sheet."""
    with tempfile.TemporaryDirectory() as work:
        run_soffice(["--headless", "--convert-to", "pdf", "--outdir", work, str(workbook)], capture_output=True, timeout=180)
        pdf = Path(work) / (workbook.stem + ".pdf")
        if not pdf.exists():
            return None, 0
        subprocess.run(["pdftoppm", "-png", "-r", "70", "-l", str(MAX_PAGES), str(pdf), str(Path(work) / "p")], check=True)
        pages = sorted(Path(work).glob("p-*.png"))
        images = [Image.open(page).convert("RGB") for page in pages]
        height = max(image.height for image in images)
        sheet = Image.new("RGB", (sum(image.width for image in images) + 12 * (len(images) - 1), height), "white")
        x = 0
        for image in images:
            sheet.paste(image, (x, 0))
            x += image.width + 12
        sheet.save(out_path, quality=75)
        info = subprocess.run(["pdfinfo", str(pdf)], capture_output=True, text=True).stdout
        total = next((int(line.split()[-1]) for line in info.splitlines() if line.startswith("Pages:")), len(pages))
        return out_path, total


def main(argv):
    parser = argparse.ArgumentParser(description="Recalculate a workbook and run every gate on it.")
    parser.add_argument("workbook", type=Path)
    parser.add_argument("--original", type=Path, help="the user's workbook before the edit")
    parser.add_argument("--allow", action="append", default=[], help="a range you meant to change")
    parser.add_argument("--new-sheet", action="append", default=[], help="a tab you added, NAME or NAME:TEMPLATE")
    parser.add_argument("--formula", action="append", default=[], help="a cell that must hold a formula")
    parser.add_argument("--expect", action="append", default=[], help="Sheet!A1=value the cell must show")
    args = parser.parse_args(argv)

    report = []
    failed = False

    _, out, err = run(sys.executable, SCRIPTS / "recalc.py", args.workbook)
    recalc = parse_json(out) or {}
    if recalc.get("status") == "success":
        report.append(f"recalc: success, {recalc.get('total_formulas', 0)} formula(s), no errors")
    else:
        failed = True
        report.append(f"recalc: FAILED {json.dumps(recalc or {'output': (out or err)[-400:]}, ensure_ascii=False)[:600]}")

    if args.formula or args.expect:
        flags = [x for f in args.formula for x in ("--formula", f)] + [x for e in args.expect for x in ("--expect", e)]
        _, out, err = run(sys.executable, SCRIPTS / "verify_calculations.py", args.workbook, *flags)
        calc = parse_json(out) or {}
        if calc.get("status") == "success":
            report.append(f"calculations: success, {len(calc.get('checked', []))} checked")
        else:
            failed = True
            report.append(f"calculations: FAILED {'; '.join(calc.get('failures', [])) or (out or err)[-400:]}")

    if args.original:
        flags = [x for a in args.allow for x in ("--allow", a)] + [x for n in args.new_sheet for x in ("--new-sheet", n)]
        _, out, err = run(sys.executable, SCRIPTS / "verify_structure.py", args.original, args.workbook, *flags)
        structure = parse_json(out) or {}
        if structure.get("status") == "success":
            report.append(
                f"structure: success, {structure.get('cells_checked_outside_allowed', 0)} untouched cell(s) and "
                f"{structure.get('merged_ranges_checked', 0)} merged range(s) verified"
            )
        else:
            failed = True
            issues = structure.get("issues") or []
            details = [f"{issue.get('kind')}: {issue.get('detail')}" for issue in issues[:12]]
            report.append("structure: FAILED\n  " + ("\n  ".join(details) or structure.get("error") or (out or err)[-600:]))

    qa = Path("/mnt/data/qa") if Path("/mnt/data").exists() else args.workbook.resolve().parent / "qa"
    qa.mkdir(parents=True, exist_ok=True)
    image, pages = render_pages(args.workbook.resolve(), qa / f"{args.workbook.stem}-pages.jpg")
    if image:
        shown = min(pages, MAX_PAGES)
        report.append(f"render: {image}  ({pages} printed page(s), first {shown} shown; read this image once)")
    else:
        report.append("render: could not render the workbook")

    print("\n".join(report))
    return 2 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
