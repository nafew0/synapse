"""Embed a whole installed font in a DOCX, so the page looks the same on a PC without it.

ECMA-376 Part 1, 17.8: the font file is stored as an obfuscated word/fonts/fontN.odttf, linked
from fontTable.xml with its key, and settings.xml turns on w:embedTrueTypeFonts. Nikosh allows
embedding but not subsetting, so the whole file goes in (about 0.8 MB).
"""
import re
import subprocess
import uuid
import zipfile
from pathlib import Path

from lxml import etree

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
CT = "http://schemas.openxmlformats.org/package/2006/content-types"
FONT_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/font"
OBFUSCATED_FONT = "application/vnd.openxmlformats-officedocument.obfuscatedFont"
FONT_TABLE = "word/fontTable.xml"
FONT_TABLE_RELS = "word/_rels/fontTable.xml.rels"
SETTINGS = "word/settings.xml"
CONTENT_TYPES = "[Content_Types].xml"

FONT_CHILD_ORDER = ["altName", "panose1", "charset", "family", "notTrueType", "pitch", "sig", "embedRegular"]
"""Schema order of a w:font's children; Word rejects a file with them out of order."""
SETTINGS_BEFORE_EMBED = {
    "writeProtection", "view", "zoom", "removePersonalInformation", "removeDateAndTime",
    "doNotDisplayPageBoundaries", "displayBackgroundShape", "printPostScriptOverText",
    "printFractionalCharacterWidth", "printFormsData",
}


def w(name):
    return f"{{{W}}}{name}"


def font_path(family):
    """The installed file of exactly `family`. fc-match would answer with a substitute instead."""
    try:
        listed = subprocess.run(["fc-list", f":family={family}", "file"], capture_output=True, text=True).stdout
    except FileNotFoundError:
        return None
    files = sorted(line.split(":")[0].strip() for line in listed.splitlines() if line.strip())
    return files[0] if files else None


def obfuscate(font_bytes, key):
    """17.8.1: the first 32 bytes XORed with the key's GUID bytes, read from the end backwards."""
    guid = bytes.fromhex(key.strip("{}").replace("-", ""))[::-1]
    head = bytes(byte ^ guid[index % 16] for index, byte in enumerate(font_bytes[:32]))
    return head + font_bytes[32:]


def insert_ordered(parent, child):
    rank = FONT_CHILD_ORDER.index(etree.QName(child).localname)
    for index, existing in enumerate(parent):
        name = etree.QName(existing).localname
        if name in FONT_CHILD_ORDER and FONT_CHILD_ORDER.index(name) > rank:
            parent.insert(index, child)
            return child
    parent.append(child)
    return child


def font_entry(table, family):
    font = next((f for f in table.findall(w("font")) if f.get(w("name")) == family), None)
    if font is not None:
        return font
    font = etree.SubElement(table, w("font"))
    font.set(w("name"), family)
    for name, value in (("charset", "00"), ("family", "auto"), ("pitch", "variable")):
        insert_ordered(font, etree.Element(w(name))).set(w("val"), value)
    return font


def add_relationship(rels, target):
    used = {rel.get("Id") for rel in rels}
    number = next(n for n in range(1, len(used) + 2) if f"rId{n}" not in used)
    etree.SubElement(rels, f"{{{PKG_REL}}}Relationship", Id=f"rId{number}", Type=FONT_REL, Target=target)
    return f"rId{number}"


def turn_on_embedding(settings):
    if settings.find(w("embedTrueTypeFonts")) is None:
        position = 0
        for index, child in enumerate(settings):
            if etree.QName(child).localname in SETTINGS_BEFORE_EMBED:
                position = index + 1
        settings.insert(position, etree.Element(w("embedTrueTypeFonts")))
    subset = settings.find(w("saveSubsetFonts"))
    if subset is not None:
        settings.remove(subset)


def serialize(root):
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


def embed_font(docx_path, family, path=None):
    """Embeds `family` in the DOCX in place. False when the font is not installed or the file has no
    font table or settings to record it in."""
    path = path or font_path(family)
    if not path:
        return False
    docx_path = Path(docx_path)
    with zipfile.ZipFile(docx_path) as package:
        parts = {name: package.read(name) for name in package.namelist()}
    if FONT_TABLE not in parts or SETTINGS not in parts:
        return False

    table = etree.fromstring(parts[FONT_TABLE])
    font = font_entry(table, family)
    if font.find(w("embedRegular")) is not None:
        return True

    key = "{" + str(uuid.uuid4()).upper() + "}"
    existing = [name for name in parts if re.match(r"^word/fonts/font\d+\.odttf$", name)]
    target = f"fonts/font{len(existing) + 1}.odttf"
    parts[f"word/{target}"] = obfuscate(Path(path).read_bytes(), key)

    rels = (
        etree.fromstring(parts[FONT_TABLE_RELS])
        if FONT_TABLE_RELS in parts
        else etree.Element(f"{{{PKG_REL}}}Relationships", nsmap={None: PKG_REL})
    )
    embed = insert_ordered(font, etree.Element(w("embedRegular")))
    embed.set(f"{{{R}}}id", add_relationship(rels, target))
    embed.set(w("fontKey"), key)
    parts[FONT_TABLE] = serialize(table)
    parts[FONT_TABLE_RELS] = serialize(rels)

    types = etree.fromstring(parts[CONTENT_TYPES])
    if not any(d.get("Extension", "").lower() == "odttf" for d in types.findall(f"{{{CT}}}Default")):
        etree.SubElement(types, f"{{{CT}}}Default", Extension="odttf", ContentType=OBFUSCATED_FONT)
    parts[CONTENT_TYPES] = serialize(types)

    settings = etree.fromstring(parts[SETTINGS])
    turn_on_embedding(settings)
    parts[SETTINGS] = serialize(settings)

    temporary = docx_path.with_suffix(".embedding")
    with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED) as package:
        package.writestr(CONTENT_TYPES, parts.pop(CONTENT_TYPES))
        for name, data in parts.items():
            package.writestr(name, data)
    temporary.replace(docx_path)
    return True
