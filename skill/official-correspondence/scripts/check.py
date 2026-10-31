"""Gate for an official document: parts the type needs, numbering, dates, placeholders, tone.

    python3 check.py SPEC.json OUT.docx

Exit codes: 0 pass (warnings may be listed), 2 defects listed, 1 bad spec or arguments.
"""

import argparse
import re
import sys
from pathlib import Path

from docx import Document

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build import PLACEHOLDER, SpecError, date_text, house_of, load_spec, subject_text  # noqa: E402

CONTRACTIONS = re.compile(r"\b\w+(?:n't|'re|'ll|'ve)\b|\b(?:I'm|it's|let's)\b", re.I)
INFORMAL = re.compile(r"\b(asap|fyi|hope this (?:email |mail )?finds you|thanks a lot|cheers|hey)\b", re.I)
UNSOURCED = re.compile(r"\b(i am directed to|the undersigned is directed)\b", re.I)
AMERICAN = {"program": "programme", "programs": "programmes", "center": "centre", "centers": "centres", "honor": "honour",
            "favor": "favour", "color": "colour", "labor": "labour", "license": "licence (noun)"}
REQUIRED_ABROAD = {"approval form": r"approval", "invitation or award letter": r"invitation|acceptance|award",
                   "statement of past overseas leave": r"overseas|past leave|previous leave",
                   "total cost and source of funds": r"cost|fund"}


def document_text(doc):
    parts = [p.text for p in doc.paragraphs]
    for table in doc.tables:
        for row in table.rows:
            parts += [p.text for cell in row.cells for p in cell.paragraphs]
    return "\n".join(parts)


def norm(text):
    return re.sub(r"\s+", " ", str(text)).strip()


def spec_defects(spec):
    kind, house, defects = spec["kind"], spec.get("house", "university-lk"), []
    needs = {"circular": ("to", "subject", "body"), "letter": ("to", "subject", "body"),
             "notice": ("body",), "memo": ("to", "from", "subject", "body"),
             "meeting": ("to", "subject", "date_of_meeting", "time", "venue"),
             "order": ("body",), "leave": ("to", "through", "subject", "body", "address_on_leave")}
    for key in needs[kind]:
        if not spec.get(key):
            defects.append(f"{kind} needs {key}")
    if kind in ("letter", "leave") and not spec.get("salutation"):
        if not spec.get("no_salutation"):
            defects.append(f"{kind} needs a salutation (or \"no_salutation\": true for a letter to a list of posts)")
    if kind == "circular" and spec.get("salutation"):
        defects.append("a circular goes to a list of posts with no salutation")
    if kind == "circular" and re.match(r"\s*subject\s*:", str(spec.get("subject", "")), re.I):
        defects.append("write the subject without a \"Subject:\" label")
    if kind == "leave" and spec.get("leave_type") == "abroad":
        attached = " ".join(map(str, spec.get("enclosures") or [])).lower()
        for name, pattern in REQUIRED_ABROAD.items():
            if not re.search(pattern, attached):
                defects.append(f"leave abroad must attach: {name} (Establishments Code X 1.10.1)")
    if house == "bd" and kind == "circular":
        defects.append("for a Bangladesh circular use the govdoc skill's formats, or kind notice")
    return defects


def tone_warnings(spec):
    text = " ".join(str(b) for b in spec.get("body") or [] if isinstance(b, str))
    warnings = []
    if CONTRACTIONS.search(text):
        warnings.append(f"contraction in the body: {CONTRACTIONS.search(text).group()!r}; write it in full")
    if INFORMAL.search(text):
        warnings.append(f"informal wording: {INFORMAL.search(text).group()!r}")
    if UNSOURCED.search(text):
        warnings.append(f"{UNSOURCED.search(text).group()!r} was not found on any published letter we read; use it only if the office does")
    for word, british in AMERICAN.items():
        if re.search(rf"\b{word}\b", text):
            warnings.append(f"British spelling: {word} -> {british}")
    salutation, closing = str(spec.get("salutation", "")).lower(), str(spec.get("closing", "")).lower()
    if "sir" in salutation and "sincerely" in closing or re.search(r"dear (?:prof|dr|mr|ms|mrs)", salutation) and "faithfully" in closing:
        warnings.append("salutation and closing do not pair: Sir/Madam with faithfully, a name with sincerely")
    return warnings


def file_defects(spec, doc, text):
    defects = []
    section = doc.sections[0]
    if abs(section.page_width.cm - 21.0) > 0.1 or abs(section.page_height.cm - 29.7) > 0.1:
        defects.append(f"not A4 ({section.page_width.cm:.1f} x {section.page_height.cm:.1f} cm)")
    flat = norm(text)
    style = house_of(spec)
    wanted = [subject_text(spec, style), date_text(spec, style), *(b for b in spec.get("body") or [] if isinstance(b, str)),
              *(spec.get("to") or []), *(spec.get("copies") or [])]
    if spec.get("date") is None:
        wanted.remove(date_text(spec, style))
    for item in wanted:
        if item and norm(item) not in flat:
            defects.append(f"missing from the file: {norm(item)[:60]!r} (rebuild from this spec)")
    numbers = [p.text[:2] for p in doc.paragraphs if re.match(r"\d{2}\.\t", p.text) and not p.paragraph_format.left_indent]
    expected = [f"{n:02d}" for n in range(2, len(numbers) + 2)]
    if numbers != expected:
        defects.append(f"paragraph numbers run {numbers}, expected {expected}")
    return defects


def check_file(spec, path):
    defects = spec_defects(spec)
    warnings = tone_warnings(spec)
    try:
        doc = Document(str(path))
    except Exception as error:  # python-docx raises several unrelated types for a bad file
        return 2, [f"cannot open {path}: {error}"]
    text = document_text(doc)
    defects += file_defects(spec, doc, text)
    placeholders = sorted(set(PLACEHOLDER.findall(text)))
    lines = [f"kind: {spec['kind']}, house: {spec.get('house', 'university-lk')}"]
    for key in ("my_no", "your_no", "number", "file_no"):
        if spec.get(key):
            lines.append(f"{key} used (must come from the user): {spec[key]}")
    lines.append(f"placeholders to list in the reply: {', '.join(placeholders)}" if placeholders else "placeholders: none")
    if re.search(r"[඀-෿஀-௿]", text):
        warnings.append("Sinhala or Tamil text is set for Word (Iskoola Pota, Latha); the sandbox has no such font, so its render shows boxes")
    lines += [f"DEFECTS ({len(defects)}):", *(f"  - {d}" for d in defects)] if defects else ["defects: none"]
    if warnings:
        lines += ["warnings:", *(f"  - {w}" for w in warnings)]
    return (2 if defects else 0), lines


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("spec")
    parser.add_argument("out")
    try:
        args = parser.parse_args(argv)
    except SystemExit as stop:
        return 0 if stop.code == 0 else 1
    try:
        spec = load_spec(args.spec)
    except SpecError as error:
        print(f"error: {error}")
        return 1
    code, lines = check_file(spec, args.out)
    print("\n".join(lines))
    return code


if __name__ == "__main__":
    sys.exit(main())
