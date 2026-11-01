"""Where each sheet lives inside an .xlsx, read from the workbook's own XML."""

import posixpath
import re

MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
SHEET_TAG = re.compile(r'<(?:\w+:)?sheet\b[^>]*>')
REL_TAG = re.compile(r'<(?:\w+:)?Relationship\b[^>]*>')
ATTR = re.compile(r'([\w:]+)="([^"]*)"')


def attributes(tag):
    return dict(ATTR.findall(tag))


def sheet_parts(archive):
    """{sheet name: zip path of its worksheet XML}, in workbook order."""
    rels = {}
    for tag in REL_TAG.findall(archive.read("xl/_rels/workbook.xml.rels").decode("utf-8")):
        attrs = attributes(tag)
        target = attrs.get("Target", "")
        path = target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join("xl", target))
        rels[attrs.get("Id")] = path
    parts = {}
    names = set(archive.namelist())
    for tag in SHEET_TAG.findall(archive.read("xl/workbook.xml").decode("utf-8")):
        attrs = attributes(tag)
        rel_id = next((v for k, v in attrs.items() if k.endswith(":id")), None)
        path = rels.get(rel_id)
        if path in names:
            name = attrs.get("name", "").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"').replace("&apos;", "'")
            parts[name] = path
    return parts
