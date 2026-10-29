"""Copy formula results from a recalculated copy into the user's workbook, touching nothing else.

LibreOffice can recalculate a workbook, but saving it rewrites the whole file: it drops
sparklines, text boxes and rich text, restyles data bars, unlinks theme fonts and respells
number formats. So the recalculation runs on a copy, and this writes only each formula cell's
cached value (and type) into the deliverable's sheet XML, then asks Excel to recalculate on open.
"""

import shutil
import tempfile
import zipfile

from lxml import etree

from parts import MAIN_NS, sheet_parts

NS = {"m": MAIN_NS}
C, F, V, IS = (f"{{{MAIN_NS}}}{tag}" for tag in ("c", "f", "v", "is"))


def shared_strings(archive):
    if "xl/sharedStrings.xml" not in archive.namelist():
        return []
    root = etree.fromstring(archive.read("xl/sharedStrings.xml"))
    return ["".join(si.itertext()) for si in root.findall("m:si", NS)]


def computed_values(path):
    """{sheet name: {cell ref: (type, text)}} for every formula cell in the recalculated copy."""
    with zipfile.ZipFile(path) as archive:
        strings = shared_strings(archive)
        values = {}
        for name, part in sheet_parts(archive).items():
            cells = {}
            for cell in etree.fromstring(archive.read(part)).iter(C):
                if cell.find(F) is None:
                    continue
                kind = cell.get("t", "n")
                if kind == "inlineStr":
                    text, kind = "".join(cell.find(IS).itertext()) if cell.find(IS) is not None else "", "str"
                else:
                    node = cell.find(V)
                    if node is None or node.text is None:
                        continue
                    text = node.text
                    if kind == "s":
                        text, kind = strings[int(text)], "str"
                cells[cell.get("r")] = (kind, text)
            values[name] = cells
        return values


def set_value(cell, kind, text):
    value = cell.find(V)
    if value is None:
        value = etree.SubElement(cell, V)
    value.text = text
    for stale in cell.findall(IS):
        cell.remove(stale)
    if kind == "n":
        cell.attrib.pop("t", None)
    else:
        cell.set("t", kind)


def full_calc_on_load(workbook_xml):
    root = etree.fromstring(workbook_xml)
    calc = root.find("m:calcPr", NS)
    if calc is None:
        calc = etree.SubElement(root, f"{{{MAIN_NS}}}calcPr")
        # calcPr belongs after definedNames and before the extension list
        for later in ("oleSize", "customWorkbookViews", "pivotCaches", "smartTagPr", "smartTagTypes",
                      "webPublishing", "fileRecoveryPr", "webPublishObjects", "extLst"):
            node = root.find(f"m:{later}", NS)
            if node is not None:
                node.addprevious(calc)
                break
    calc.set("fullCalcOnLoad", "1")
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


def graft(recalculated, target):
    """Write the recalculated copy's formula results into `target` in place. Returns the count."""
    values = computed_values(recalculated)
    written = 0
    with zipfile.ZipFile(target) as source:
        parts = sheet_parts(source)
        replaced = {}
        for name, part in parts.items():
            sheet_values = values.get(name, {})
            if not sheet_values:
                continue
            root = etree.fromstring(source.read(part))
            changed = 0
            for cell in root.iter(C):
                if cell.find(F) is not None and cell.get("r") in sheet_values:
                    set_value(cell, *sheet_values[cell.get("r")])
                    changed += 1
            if changed:
                replaced[part] = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
                written += changed
        replaced["xl/workbook.xml"] = full_calc_on_load(source.read("xl/workbook.xml"))
        with tempfile.NamedTemporaryFile(suffix=".xlsx", delete=False) as handle:
            temporary = handle.name
        with zipfile.ZipFile(temporary, "w") as out:
            for info in source.infolist():
                data = replaced.get(info.filename)
                out.writestr(info, data if data is not None else source.read(info.filename))
    shutil.move(temporary, target)
    return written
