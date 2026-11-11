"""Write one spec per kind that shows every design in a library, filled with sample text.

    python3 sheet.py LIBRARY_DIR OUT_DIR [--theme Candy] [--bangla] [--build]

Each spec has one slide per design, pinned by its id, titled "<kind> · <items> items · <id>".
With --build it also builds OUT_DIR/<kind>.pptx through deck.py's builder, keeping the slides
whose design does not fit the sample text (title only) and listing them in OUT_DIR/misfits.json.
"""

import argparse
import json
import sys
from pathlib import Path

SKILL = Path(__file__).resolve().parents[2] / "skill" / "pptx"
sys.path.insert(0, str(SKILL / "scripts"))
from deck import Builder, load_theme  # noqa: E402

HEADS = ["Plan", "Promote", "Admit", "Review", "Report", "Improve", "Train", "Launch", "Measure", "Share",
         "Fund", "Hire", "Build", "Test", "Close"]
BODIES = ["Set intake targets for each campus", "Visit schools and run the campaign", "Publish the merit list in May",
          "Compare intake with the targets", "Send the board a short summary", "Adjust next year's plan"]
BANGLA_HEADS = ["পরিকল্পনা", "প্রচার", "ভর্তি", "পর্যালোচনা", "প্রতিবেদন", "উন্নয়ন", "প্রশিক্ষণ", "শুরু", "পরিমাপ", "বিনিময়",
                "অর্থায়ন", "নিয়োগ", "নির্মাণ", "পরীক্ষা", "সমাপ্তি"]
BANGLA_BODIES = ["প্রতিটি ক্যাম্পাসের লক্ষ্য ঠিক করা", "স্কুল পরিদর্শন ও প্রচার চালানো", "মে মাসে মেধাতালিকা প্রকাশ",
                 "লক্ষ্যের সাথে ভর্তি মেলানো", "বোর্ডে সংক্ষিপ্ত প্রতিবেদন পাঠানো", "পরের বছরের পরিকল্পনা ঠিক করা"]


def items(count, bangla):
    heads, bodies = (BANGLA_HEADS, BANGLA_BODIES) if bangla else (HEADS, BODIES)
    return [{"head": heads[i % len(heads)], "body": bodies[i % len(bodies)], "value": f"{(i + 2) * 11}%",
             "date": str(2021 + i)} for i in range(count)]


def build(kind, slides, args):
    builder = Builder(load_theme(args.theme, SKILL / "themes"), SKILL / "themes", args.library)
    builder.build(slides)
    builder.presentation.save(args.out / f"{kind}.pptx")
    misfits = {}
    for problem in builder.problems:
        number = int(problem.split(":")[0].split()[1])
        misfits[slides[number - 1]["infographic"]["design"]] = problem.split(": ", 1)[1]
    return misfits


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("library", type=Path)
    parser.add_argument("out", type=Path)
    parser.add_argument("--theme", default="Candy")
    parser.add_argument("--layout", default="content")
    parser.add_argument("--bangla", action="store_true")
    parser.add_argument("--build", action="store_true", help="also build each kind's deck")
    args = parser.parse_args(argv)
    designs = json.loads((args.library / "manifest.json").read_text(encoding="utf8"))
    args.out.mkdir(parents=True, exist_ok=True)
    by_kind, misfits = {}, {}
    for design in designs:
        by_kind.setdefault(design["kind"], []).append(design)
    for kind, group in sorted(by_kind.items()):
        slides = [{
            "layout": args.layout,
            "title": f"{kind} · {d['items']} items · {d['id']}",
            "infographic": {"kind": kind, "design": d["id"], "items": items(d["items"], args.bangla),
                            "centre": "কেন্দ্র" if args.bangla else "Admissions"},
        } for d in group]
        (args.out / f"{kind}.json").write_text(json.dumps({"theme": args.theme, "slides": slides}, ensure_ascii=False), encoding="utf8")
        if args.build:
            misfits.update(build(kind, slides, args))
    print(f"wrote {len(by_kind)} specs to {args.out}")
    if args.build:
        (args.out / "misfits.json").write_text(json.dumps(misfits, ensure_ascii=False, indent=1), encoding="utf8")
        print(f"{len(misfits)} designs did not fit the sample text")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
