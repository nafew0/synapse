#!/usr/bin/env python3
"""Drop [Content_Types].xml Overrides that name a part the package does not have.

pptxgenjs writes one slideMaster Override per SLIDE, indexed by slide number
(`dist/pptxgen.cjs.js`, v4.0.1):

    slides.forEach((slide, idx) => {
        strXml += `<Override PartName="/ppt/slideMasters/slideMaster${idx + 1}.xml" .../>`

A deck has one master, so an N-slide deck declares slideMaster1..N and writes
only slideMaster1 -- N-1 declarations pointing at nothing.

PowerPoint and LibreOffice ignore the strays, which is why decks looked fine on
delivery. Readers that walk the Overrides do not: pptx-preview filters them by
content type and dereferences each PartName straight out of the zip, with the
whole loop inside a catch-all, so one missing part leaves it with zero slides
and the artifact panel shows an empty deck.

Run after writeFile(), before validate.py. Idempotent; exits 0 either way.

    python3 /mnt/data/skills/pptx/scripts/fix_content_types.py deck.pptx
"""

import shutil
import sys
import tempfile
import zipfile
from pathlib import Path
from xml.etree import ElementTree

CONTENT_TYPES = "[Content_Types].xml"
NS = "http://schemas.openxmlformats.org/package/2006/content-types"


def phantom_overrides(archive):
    """Parts declared by an Override that are absent from the archive."""
    names = set(archive.namelist())
    root = ElementTree.fromstring(archive.read(CONTENT_TYPES))
    missing = []
    for override in root.findall("{%s}Override" % NS):
        part = (override.get("PartName") or "").lstrip("/")
        if part and part not in names:
            missing.append(part)
    return root, missing


def repair(path):
    with zipfile.ZipFile(path) as archive:
        if CONTENT_TYPES not in archive.namelist():
            print("%s: no %s; nothing to do" % (path.name, CONTENT_TYPES))
            return []
        root, missing = phantom_overrides(archive)
        if not missing:
            print("%s: content types are consistent" % path.name)
            return []
        for override in list(root.findall("{%s}Override" % NS)):
            if (override.get("PartName") or "").lstrip("/") in missing:
                root.remove(override)
        ElementTree.register_namespace("", NS)
        rewritten = ElementTree.tostring(root, encoding="UTF-8", xml_declaration=True)
        entries = [(info, archive.read(info.filename)) for info in archive.infolist()]

    """Rewrite through a temporary file so a failure cannot leave a half-written
    deck where the original was."""
    handle, temp_name = tempfile.mkstemp(suffix=".pptx", dir=str(path.parent))
    import os

    os.close(handle)
    temp = Path(temp_name)
    try:
        with zipfile.ZipFile(temp, "w", zipfile.ZIP_DEFLATED) as out:
            for info, payload in entries:
                out.writestr(info, rewritten if info.filename == CONTENT_TYPES else payload)
        shutil.move(str(temp), str(path))
    except BaseException:
        temp.unlink(missing_ok=True)
        raise

    print("%s: removed %d override(s) naming absent parts:" % (path.name, len(missing)))
    for part in missing:
        print("    /%s" % part)
    return missing


def main(argv):
    if len(argv) != 1:
        print(__doc__.strip().splitlines()[0], file=sys.stderr)
        print("usage: fix_content_types.py <file.pptx>", file=sys.stderr)
        return 1
    path = Path(argv[0])
    if not path.is_file():
        print("Not a file: %s" % path, file=sys.stderr)
        return 1
    repair(path)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
