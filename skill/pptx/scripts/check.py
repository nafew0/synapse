"""Build a deck and run every check on it in one call.

    python3 check.py <deck.pptx> [--build /mnt/data/qa/build.js.txt] [--original src.pptx]

Runs, in order: the generator (with --build), fix_content_types.py, validate.py,
check_layout.py, a placeholder-text scan, and thumbnail.py. The last lines are a short
report and the path of one labelled grid of every slide: read that one image, not the
slides one by one. Exit 0 when everything passed, 2 when something needs fixing.
"""

import argparse
import re
import subprocess
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
PLACEHOLDER = re.compile(r"\bx{3,}\b|lorem|ipsum|\bTODO\b|\[insert|click to (add|edit)", re.IGNORECASE)


def run(*args, cwd=None):
    result = subprocess.run([str(a) for a in args], capture_output=True, text=True, cwd=cwd)
    return result.returncode, (result.stdout + result.stderr).strip()


def tail(text, lines=12):
    return "\n".join(text.splitlines()[-lines:])


def main(argv):
    parser = argparse.ArgumentParser(description="Build a deck and run every check on it.")
    parser.add_argument("deck", type=Path)
    parser.add_argument("--build", type=Path, help="generator script to run with node first")
    parser.add_argument("--original", type=Path, help="the deck or template this one was made from")
    args = parser.parse_args(argv)

    if args.build:
        build = args.build.resolve()
        code, output = run("node", build, cwd=build.parent)
        if code != 0:
            print(f"build FAILED:\n{tail(output)}")
            return 2
    if not args.deck.exists():
        print(f"no deck at {args.deck}: the build did not write it")
        return 2

    original = ["--original", args.original] if args.original else []
    report = []
    failed = False

    run(sys.executable, SCRIPTS / "fix_content_types.py", args.deck)

    code, output = run(sys.executable, SCRIPTS / "office" / "validate.py", args.deck, *original)
    if code == 0:
        report.append("validation: passed")
    else:
        failed = True
        report.append(f"validation: FAILED\n{tail(output)}")

    code, output = run(sys.executable, SCRIPTS / "check_layout.py", args.deck, *original)
    if output.startswith("clean"):
        report.append(f"layout: {output.splitlines()[0]}")
    else:
        failed = True
        report.append(f"layout: defects to fix\n{tail(output, 30)}")

    code, text = run("markitdown", args.deck)
    hits = [line.strip() for line in text.splitlines() if PLACEHOLDER.search(line)]
    if hits:
        failed = True
        report.append("placeholder text left:\n" + "\n".join(f"  {hit[:120]}" for hit in hits[:10]))
    else:
        report.append("placeholder text: none")

    qa = Path("/mnt/data/qa") if Path("/mnt/data").exists() else args.deck.resolve().parent / "qa"
    qa.mkdir(parents=True, exist_ok=True)
    prefix = qa / f"{args.deck.stem}-grid"
    for stale in qa.glob(f"{prefix.name}*.jpg"):
        stale.unlink()
    code, output = run(sys.executable, SCRIPTS / "thumbnail.py", args.deck, prefix)
    grids = sorted(qa.glob(f"{prefix.name}*.jpg"))
    if grids:
        report.append("grid: " + "  ".join(str(grid) for grid in grids) + "  (read this, not single slides)")
    else:
        report.append(f"grid: could not render\n{tail(output)}")

    print("\n".join(report))
    return 2 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
