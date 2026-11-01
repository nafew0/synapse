"""Before editing a user's workbook: list what an openpyxl load-and-save would destroy.

    python3 preflight.py <workbook.xlsx>

Prints one line per at-risk feature and a verdict. "openpyxl: safe" means load it with
load_workbook(path, rich_text=True) and edit as usual. "openpyxl: UNSAFE" means change its
cells with cells.py instead, which edits the XML and leaves everything else in place.
Exit 0 when safe, 2 when unsafe.
"""

import re
import sys
import zipfile

from parts import sheet_parts

# What openpyxl drops or rewrites on save, found by round-tripping real-office features.
RISKS = [
    ("sparklines", r"<x14:sparklineGroup\b", "sheets"),
    ("Excel 2010 conditional formats (data bar styles, icon sets) in an extension", r"<x14:conditionalFormatting\b", "sheets"),
    ("Excel 2010 data validation (lists on other sheets) in an extension", r"<x14:dataValidation\b", "sheets"),
    ("slicers", r"<x14:slicerList\b|<x15:slicerList\b", "sheets"),
    ("text boxes and shapes", r"<(?:\w+:)?(?:sp|grpSp|cxnSp)[ >]", "drawings"),
    ("form controls (buttons, check boxes)", r"<(?:\w+:)?control\b|ctrlProp", "sheets"),
]


def read_all(archive, pattern):
    return "".join(archive.read(n).decode("utf-8", "replace") for n in archive.namelist() if re.match(pattern, n))


def inspect(path):
    findings = []
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        sources = {
            "sheets": read_all(archive, r"xl/worksheets/sheet\d+\.xml$"),
            "drawings": read_all(archive, r"xl/drawings/drawing\d+\.xml$"),
        }
        for label, pattern, where in RISKS:
            count = len(re.findall(pattern, sources[where]))
            if count:
                findings.append((label, count, True))
        if any(n.startswith("xl/pivotTables/") for n in names):
            findings.append(("pivot tables", sum(n.startswith("xl/pivotTables/pivotTable") for n in names), True))
        if "xl/vbaProject.bin" in names:
            findings.append(("macros (keep_vba=True keeps them; cells.py is safer)", 1, True))
        strings = archive.read("xl/sharedStrings.xml").decode("utf-8", "replace") if "xl/sharedStrings.xml" in names else ""
        rich = len(re.findall(r"<(?:\w+:)?si>\s*<(?:\w+:)?r>", strings)) + len(re.findall(r"<(?:\w+:)?is>\s*<(?:\w+:)?r>", sources["sheets"]))
        if rich:
            findings.append(("cells with mixed formatting (rich text): load with rich_text=True", rich, False))
        vml = read_all(archive, r"xl/drawings/.*\.vml$")
        if 'ObjectType="Note"' in vml:
            findings.append(("comment boxes with their own size and position (openpyxl resets them)", vml.count('ObjectType="Note"'), False))
        sheets = list(sheet_parts(archive))
    unsafe = any(blocking for _, _, blocking in findings)
    return sheets, findings, unsafe


def main(argv):
    if len(argv) != 1:
        print(__doc__.strip())
        return 1
    sheets, findings, unsafe = inspect(argv[0])
    print(f"sheets: {', '.join(sheets)}")
    for label, count, _ in findings:
        print(f"- {label}: {count}")
    if unsafe:
        print("openpyxl: UNSAFE. Change cells with scripts/cells.py; an openpyxl save would delete the items above.")
        return 2
    note = " (load with rich_text=True)" if findings else ""
    print(f"openpyxl: safe{note}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
