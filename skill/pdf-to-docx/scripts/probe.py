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

EMU_PER_POINT = 12700
TWIPS_PER_POINT = 20
DEFAULT_PAGE_POINTS = (612.0, 792.0)
RASTER_SUFFIXES = {'.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tif', '.tiff', '.webp'}


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


def live_children(element):
    """Every descendant reached without entering an mc:Fallback."""
    for child in element:
        if child.tag == MC + 'Fallback':
            continue
        yield child
        yield from live_children(child)


def docx_text(path):
    root = _document_root(path)
    return ' '.join(node.text or '' for node in live_children(root) if node.tag == W + 't')


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


def docx_extents(path):
    """Rendered size in points of every anchored or inline picture."""
    root = _document_root(path)
    extents = []
    for node in live_children(root):
        if node.tag not in (WP + 'anchor', WP + 'inline'):
            continue
        if next((child for child in node.iter(A + 'blip')), None) is None:
            continue
        extent = node.find(WP + 'extent')
        if extent is None:
            continue
        extents.append(
            (float(extent.get('cx', 0)) / EMU_PER_POINT, float(extent.get('cy', 0)) / EMU_PER_POINT)
        )
    return extents


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
