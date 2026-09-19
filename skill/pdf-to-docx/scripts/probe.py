"""Read the facts a PDF and a converted .docx must agree on.

Shared by convert.py (which reports them) and verify_conversion.py (which compares them).

LibreOffice writes every positioned text box twice: once as DrawingML inside an
`mc:AlternateContent/mc:Choice`, once as VML inside the `mc:Fallback` beside it. Counting both
doubles every character and every image, so everything here walks the Choice branch only.
"""
import io
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
WP = '{http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing}'
A = '{http://schemas.openxmlformats.org/drawingml/2006/main}'
MC = '{http://schemas.openxmlformats.org/markup-compatibility/2006}'
R = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'

EMU_PER_POINT = 12700
TWIPS_PER_POINT = 20
DEFAULT_PAGE_POINTS = (612.0, 792.0)
RASTER_SUFFIXES = {'.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tif', '.tiff', '.webp'}
MIN_PICTURE_POINTS = 8.0
"""A raster smaller than this in either direction is a rule, a bullet glyph or an artefact of the
page rather than a picture. Shared so a converter and the gate draw the line in the same place."""


class InputError(Exception):
    pass


def normalize(text):
    """Whitespace-insensitive form, so a reflowed line break is not counted as lost text."""
    return re.sub(r'\s+', '', text or '')


def _document_root(path):
    try:
        with zipfile.ZipFile(path) as archive:
            return ElementTree.fromstring(archive.read('word/document.xml'))
    except (zipfile.BadZipFile, KeyError) as error:
        raise InputError(f'{path}: not a readable .docx ({error})') from error


HEADER_FOOTER = re.compile(r'^word/(header|footer)\d*\.xml$')


def _visible_parts(path):
    """Every part a reader sees: the document, then its headers and footers.

    A running header lives in `word/header1.xml`, not in `document.xml`. Measuring only the
    document counts a letterhead moved into a real Word header as content that went missing.
    """
    try:
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
            parts = [('word/document.xml', archive.read('word/document.xml'))]
            parts += [
                (name, archive.read(name)) for name in sorted(names) if HEADER_FOOTER.match(name)
            ]
    except (zipfile.BadZipFile, KeyError, OSError) as error:
        raise InputError(f'{path}: not a readable .docx ({error})') from error
    roots = []
    for name, payload in parts:
        try:
            roots.append((name, ElementTree.fromstring(payload)))
        except ElementTree.ParseError:
            continue
    return roots


def live_children(element):
    """Every descendant reached without entering an mc:Fallback."""
    for child in element:
        if child.tag == MC + 'Fallback':
            continue
        yield child
        yield from live_children(child)


def docx_text(path):
    return ' '.join(
        node.text or ''
        for _, root in _visible_parts(path)
        for node in live_children(root)
        if node.tag == W + 't'
    )


def docx_pages(path):
    """LibreOffice separates pages with explicit breaks, so counting them counts the pages."""
    root = _document_root(path)
    body = root.find(W + 'body')
    if body is None:
        raise InputError(f'{path}: the document has no body')
    breaks = sum(
        1
        for node in live_children(root)
        if node.tag == W + 'br' and node.get(W + 'type') == 'page'
    )
    trailing = body.find(W + 'sectPr')
    sections = sum(1 for node in body.iter(W + 'sectPr') if node is not trailing)
    return 1 + breaks + sections


def rendered_pages(path, timeout=120):
    """How many pages a reader actually sees, or None when LibreOffice is not on PATH.

    `docx_pages` counts the breaks the file carries. That is exact for a document whose every line
    is positioned, and a guess for one that reflows: the same words set in another face take a
    different amount of room, and the spill onto an extra page shows up in the renderer rather than
    in the XML.
    """
    import shutil
    import subprocess
    import tempfile

    soffice = shutil.which('soffice')
    if soffice is None:
        return None
    with tempfile.TemporaryDirectory() as workspace:
        try:
            result = subprocess.run(
                [soffice, '--headless', '--convert-to', 'pdf', '--outdir', workspace, str(path)],
                capture_output=True,
                timeout=timeout,
            )
        except (OSError, subprocess.SubprocessError):
            return None
        produced = Path(workspace) / f'{Path(path).stem}.pdf'
        if result.returncode != 0 or not produced.is_file():
            return None
        try:
            return pdf_pages(produced)
        except Exception:  # noqa: BLE001 - an unreadable render tells us nothing either way
            return None


def docx_page_size(path):
    root = _document_root(path)
    size = next((node for node in root.iter(W + 'pgSz')), None)
    if size is None:
        return DEFAULT_PAGE_POINTS
    width = float(size.get(W + 'w', 0)) / TWIPS_PER_POINT
    height = float(size.get(W + 'h', 0)) / TWIPS_PER_POINT
    return width, height


def docx_media(path):
    """Every raster in word/media, as (name, pixel width, pixel height)."""
    from PIL import Image

    media = []
    with zipfile.ZipFile(path) as archive:
        for name in sorted(archive.namelist()):
            if not name.startswith('word/media/') or Path(name).suffix.lower() not in RASTER_SUFFIXES:
                continue
            payload = archive.read(name)
            try:
                with Image.open(io.BytesIO(payload)) as image:
                    media.append({'name': name, 'width': image.width, 'height': image.height, 'bytes': payload})
            except OSError:
                continue
    return media


def docx_running_text(path):
    """The text in the headers and footers — what Word repeats on every page."""
    return ' '.join(
        node.text or ''
        for name, root in _visible_parts(path)
        if HEADER_FOOTER.match(name)
        for node in live_children(root)
        if node.tag == W + 't'
    )


def docx_extents(path):
    """Rendered size in points of every anchored or inline picture."""
    extents = []
    for _, root in _visible_parts(path):
        for node in live_children(root):
            extent = _picture_extent(node)
            if extent is not None:
                extents.append(extent)
    return extents


def _picture_extent(node):
    if node.tag not in (WP + 'anchor', WP + 'inline'):
        return None
    if next((child for child in node.iter(A + 'blip')), None) is None:
        return None
    extent = node.find(WP + 'extent')
    if extent is None:
        return None
    return (
        float(extent.get('cx', 0)) / EMU_PER_POINT,
        float(extent.get('cy', 0)) / EMU_PER_POINT,
    )


def docx_pictures(path):
    """Every picture that will actually draw, as {'width', 'height', 'repeats'} in points.

    `repeats` marks a picture in a header or footer: Word draws that one copy on every page, so it
    answers for the same picture on each page of the source.

    A picture whose part was lost still leaves its `<wp:extent>` behind — the anchor is in
    `document.xml` and the file it points at is gone, which Word shows as an empty frame. Resolving
    each blip against the package is what separates "the logo is there" from "the logo's hole is
    there".
    """
    with zipfile.ZipFile(path) as archive:
        parts = set(archive.namelist())
    pictures = []
    for name, root in _visible_parts(path):
        relationships = _part_relationships(path, name)
        for node in live_children(root):
            extent = _picture_extent(node)
            if extent is None:
                continue
            blip = next((child for child in node.iter(A + 'blip')), None)
            target = relationships.get(blip.get(R + 'embed'))
            if target is None or f'word/{target}' not in parts:
                continue
            pictures.append(
                {
                    'width': extent[0],
                    'height': extent[1],
                    'repeats': bool(HEADER_FOOTER.match(name)),
                }
            )
    return pictures


def _part_relationships(path, part):
    """Relationship id to target for one part — each has its own `_rels` file."""
    rels = f'{Path(part).parent.as_posix()}/_rels/{Path(part).name}.rels'
    try:
        with zipfile.ZipFile(path) as archive:
            payload = archive.read(rels)
    except (KeyError, OSError, zipfile.BadZipFile):
        return {}
    try:
        root = ElementTree.fromstring(payload)
    except ElementTree.ParseError:
        return {}
    return {
        node.get('Id'): node.get('Target', '').lstrip('/')
        for node in root
        if node.get('Id') and node.get('Target')
    }


def pdf_pages(path):
    from pypdf import PdfReader

    try:
        return len(PdfReader(str(path)).pages)
    except Exception as error:
        raise InputError(f'{path}: not a readable PDF ({error})') from error


def pdf_page_size(path):
    from pypdf import PdfReader

    box = PdfReader(str(path)).pages[0].mediabox
    return float(box.width), float(box.height)


def pdf_text(path):
    import pdfplumber

    with pdfplumber.open(str(path)) as pdf:
        return ' '.join(page.extract_text() or '' for page in pdf.pages)


def pdf_image_count(path):
    """How many rasters the PDF places, counted without decoding any of them.

    `pdf_media` can only report the images it manages to decode, so on its own it cannot tell
    "this document has no pictures" from "this document has pictures I could not read". This is
    the honest denominator for both answers.
    """
    import pdfplumber

    with pdfplumber.open(str(path)) as pdf:
        return sum(len(page.images) for page in pdf.pages)


def pdf_placements(path):
    """Where and how large every meaningful raster is drawn, in points.

    Pixel dimensions say what the producer embedded; these say what the reader shows, which is what
    a conversion has to reproduce. The two differ whenever a PDF scales an image into its box, and
    on an official document they usually do.
    """
    import pdfplumber

    placements = []
    with pdfplumber.open(str(path)) as pdf:
        for number, page in enumerate(pdf.pages, start=1):
            for image in page.images or []:
                width = float(image['x1']) - float(image['x0'])
                height = float(image['bottom']) - float(image['top'])
                if width < MIN_PICTURE_POINTS or height < MIN_PICTURE_POINTS:
                    continue
                placements.append({'page': number, 'width': width, 'height': height})
    return placements


def pdf_media(path):
    """Every embedded raster it can decode, as (page, pixel width, pixel height, PIL image)."""
    from pypdf import PdfReader

    media = []
    for number, page in enumerate(PdfReader(str(path)).pages, start=1):
        try:
            images = list(page.images)
        except Exception:
            continue
        for image in images:
            try:
                pil = image.image
            except Exception:
                continue
            if pil is None:
                continue
            media.append({'page': number, 'width': pil.width, 'height': pil.height, 'image': pil})
    return media


def decode_qr(image):
    """Every QR payload cv2 can read out of a PIL image."""
    import cv2
    import numpy

    frame = numpy.array(image.convert('RGB'))[:, :, ::-1]
    detector = cv2.QRCodeDetector()
    found = set()
    try:
        ok, payloads, _, _ = detector.detectAndDecodeMulti(frame)
    except cv2.error:
        ok, payloads = False, ()
    if ok:
        found.update(payload for payload in payloads if payload)
    if found:
        return found
    try:
        payload, _, _ = detector.detectAndDecode(frame)
    except cv2.error:
        payload = ''
    if payload:
        found.add(payload)
    return found
