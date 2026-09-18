"""Repair what LibreOffice's PDF import leaves broken: page backgrounds and dropped images.

A full-bleed page fill is not dropped, as it first appears — it survives as a bare VML shape whose
style names neither a z-index nor a page-relative origin. Word paints it over the text boxes,
which are all `behindDoc`, and both renderers offset it by the page margin, so a dark title page
shows as a solid block with its white text buried underneath. Two style properties put it back
where it belongs. A fill the import really did drop is re-created from the PDF instead.

Rasters are re-inserted at their source rectangle when the import loses one. Nothing here ever
flattens a page into a picture.

The import emits one body paragraph per PDF page, each holding that page's shapes. That mapping is
checked before anything is anchored to a page; when it does not hold, the repair that needs it is
skipped and reported rather than guessed at.
"""
import io
import re
import shutil
import zipfile
from pathlib import Path
from xml.etree import ElementTree

from probe import EMU_PER_POINT, docx_media, docx_page_size, live_children, pdf_media, pdf_pages

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
WP = '{http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing}'
A = '{http://schemas.openxmlformats.org/drawingml/2006/main}'
PIC = '{http://schemas.openxmlformats.org/drawingml/2006/picture}'
WPS = '{http://schemas.microsoft.com/office/word/2010/wordprocessingShape}'
REL = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'
RELS = '{http://schemas.openxmlformats.org/package/2006/relationships}'
TYPES = '{http://schemas.openxmlformats.org/package/2006/content-types}'
IMAGE_RELATIONSHIP = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image'

DOCUMENT = 'word/document.xml'
DOCUMENT_RELS = 'word/_rels/document.xml.rels'
CONTENT_TYPES = '[Content_Types].xml'

VML = '{urn:schemas-microsoft-com:vml}'
VML_SHAPES = {'shape', 'rect', 'roundrect', 'oval', 'background'}
# The value Word itself writes for "behind text"; anything negative sits under the text layer.
BEHIND_TEXT_Z_INDEX = -251658240
POINTS_PER_UNIT = {'pt': 1.0, 'in': 72.0, 'cm': 72 / 2.54, 'mm': 7.2 / 2.54, 'px': 0.75}

# A fill counts as the page background when it covers this much of the page in both directions.
FULL_BLEED = 0.97
# Below this the fill is decoration rather than a background, and the import usually keeps it.
MIN_BACKGROUND_AREA = 0.9
CONTENT_TYPE_BY_SUFFIX = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.tif': 'image/tiff',
    '.tiff': 'image/tiff',
    '.bmp': 'image/bmp',
}

NAMESPACES = {
    'wpc': 'http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas',
    'mc': 'http://schemas.openxmlformats.org/markup-compatibility/2006',
    'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
    'm': 'http://schemas.openxmlformats.org/officeDocument/2006/math',
    'wp14': 'http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing',
    'wp': 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
    'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
    'w14': 'http://schemas.microsoft.com/office/word/2010/wordml',
    'w15': 'http://schemas.microsoft.com/office/word/2012/wordml',
    'wpg': 'http://schemas.microsoft.com/office/word/2010/wordprocessingGroup',
    'wpi': 'http://schemas.microsoft.com/office/word/2010/wordprocessingInk',
    'wne': 'http://schemas.microsoft.com/office/word/2006/wordml',
    'wps': 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape',
    'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
    'pic': 'http://schemas.openxmlformats.org/drawingml/2006/picture',
}


def points_to_emu(points):
    return round(points * EMU_PER_POINT)


def srgb(color):
    """A pdfplumber non-stroking color, in whatever space the PDF used, as RRGGBB."""
    if color is None:
        return None
    if isinstance(color, (int, float)):
        channels = (float(color),) * 3
    elif len(color) == 1:
        channels = (float(color[0]),) * 3
    elif len(color) == 3:
        channels = tuple(float(value) for value in color)
    elif len(color) == 4:
        cyan, magenta, yellow, black = (float(value) for value in color)
        channels = (
            (1 - cyan) * (1 - black),
            (1 - magenta) * (1 - black),
            (1 - yellow) * (1 - black),
        )
    else:
        return None
    return ''.join(f'{max(0, min(255, round(channel * 255))):02X}' for channel in channels)


def page_backgrounds(pdf_path):
    """Pages whose PDF paints a full-bleed fill, as {page number: RRGGBB}."""
    import pdfplumber

    backgrounds = {}
    with pdfplumber.open(str(pdf_path)) as pdf:
        for number, page in enumerate(pdf.pages, start=1):
            area = page.width * page.height
            if not area:
                continue
            for rect in page.rects:
                if not rect.get('fill'):
                    continue
                width = abs(rect['x1'] - rect['x0'])
                height = abs(rect['bottom'] - rect['top'])
                covers = width >= FULL_BLEED * page.width and height >= FULL_BLEED * page.height
                if not covers or width * height < MIN_BACKGROUND_AREA * area:
                    continue
                color = srgb(rect.get('non_stroking_color'))
                if color and color != 'FFFFFF':
                    backgrounds[number] = color
    return backgrounds


def image_placements(pdf_path):
    """Every raster placement, as {page: [(x0_pt, top_pt, width_pt, height_pt, srcsize)]}."""
    import pdfplumber

    placements = {}
    with pdfplumber.open(str(pdf_path)) as pdf:
        for number, page in enumerate(pdf.pages, start=1):
            for image in page.images:
                placements.setdefault(number, []).append(
                    {
                        'x': float(image['x0']),
                        'y': float(image['top']),
                        'width': abs(float(image['x1']) - float(image['x0'])),
                        'height': abs(float(image['bottom']) - float(image['top'])),
                        'srcsize': tuple(image.get('srcsize') or ()),
                    }
                )
    return placements


def missing_images(pdf_path, docx_path):
    """Source rasters with no counterpart in word/media, matched by occurrence, not by name."""
    delivered = {}
    for entry in docx_media(docx_path):
        delivered[(entry['width'], entry['height'])] = delivered.get((entry['width'], entry['height']), 0) + 1

    placements = image_placements(pdf_path)
    missing = []
    for entry in pdf_media(pdf_path):
        key = (entry['width'], entry['height'])
        if delivered.get(key):
            delivered[key] -= 1
            continue
        placement = _match_placement(placements.get(entry['page'], []), key)
        if placement is None:
            missing.append({**entry, 'placement': None})
            continue
        missing.append({**entry, 'placement': placement})
    return missing


def _match_placement(placements, srcsize):
    for placement in placements:
        if placement['srcsize'] == srcsize and not placement.get('used'):
            placement['used'] = True
            return placement
    return None


def restore(pdf_path, docx_path):
    """Repair docx_path in place. Returns what was restored and what could not be."""
    pdf_path, docx_path = Path(pdf_path), Path(docx_path)
    summary = {
        'backgrounds_sent_to_back': 0,
        'backgrounds_added': 0,
        'images_restored': 0,
        'warnings': [],
    }

    backgrounds = page_backgrounds(pdf_path)
    missing = missing_images(pdf_path, docx_path)
    for entry in missing:
        if entry['placement'] is None:
            summary['warnings'].append(
                f"page {entry['page']}: an image is missing from the output and its position on the "
                'page could not be recovered, so it was not re-inserted'
            )
    insertable = [entry for entry in missing if entry['placement'] is not None]

    with zipfile.ZipFile(docx_path) as archive:
        parts = {name: archive.read(name) for name in archive.namelist()}

    for prefix, uri in NAMESPACES.items():
        ElementTree.register_namespace(prefix, uri)

    root = ElementTree.fromstring(parts[DOCUMENT])
    body = root.find(W + 'body')
    paragraphs = [child for child in body if child.tag == W + 'p']
    width_pt, height_pt = docx_page_size(docx_path)

    covered = set()
    for index, paragraph in enumerate(paragraphs, start=1):
        found, repaired = _send_backgrounds_to_back(paragraph, width_pt, height_pt)
        summary['backgrounds_sent_to_back'] += repaired
        if found:
            covered.add(index)

    pages = pdf_pages(pdf_path)
    mapped = len(paragraphs) == pages
    if not mapped and (backgrounds or insertable):
        summary['warnings'].append(
            f'the converted document has {len(paragraphs)} page paragraph(s) for {pages} PDF page(s), '
            'so nothing was anchored to a page; only the shapes already in the document were reordered'
        )
    if not mapped:
        return _finish(summary, docx_path, parts, root, changed=bool(summary['backgrounds_sent_to_back']))

    next_id = _next_docpr_id(root)
    added_media = {}

    for number, color in sorted(backgrounds.items()):
        if number in covered:
            continue
        run = _background_run(color, width_pt, height_pt, next_id)
        _insert_run(paragraphs[number - 1], run)
        next_id += 1
        summary['backgrounds_added'] += 1

    if insertable:
        rels = ElementTree.fromstring(parts[DOCUMENT_RELS])
        for index, entry in enumerate(insertable, start=1):
            name, payload = _encode_image(entry['image'], index)
            target = f'media/{name}'
            relationship_id = _add_relationship(rels, target)
            added_media[f'word/{target}'] = payload
            run = _picture_run(relationship_id, entry['placement'], next_id, name)
            _insert_run(paragraphs[entry['page'] - 1], run)
            next_id += 1
            summary['images_restored'] += 1
        parts[DOCUMENT_RELS] = ElementTree.tostring(rels, encoding='UTF-8', xml_declaration=True)
        parts[CONTENT_TYPES] = _with_content_types(parts[CONTENT_TYPES], added_media)

    parts.update(added_media)
    changed = any(
        summary[key] for key in ('backgrounds_sent_to_back', 'backgrounds_added', 'images_restored')
    )
    return _finish(summary, docx_path, parts, root, changed)


def _finish(summary, docx_path, parts, root, changed):
    if not changed:
        return summary
    parts[DOCUMENT] = ElementTree.tostring(root, encoding='UTF-8', xml_declaration=True)
    _rewrite(docx_path, parts)
    return summary


def _insert_run(paragraph, run):
    """w:pPr has to stay the first child of w:p, so a new run goes straight after it."""
    paragraph.insert(1 if len(paragraph) and paragraph[0].tag == W + 'pPr' else 0, run)


def _send_backgrounds_to_back(paragraph, width_pt, height_pt):
    """Re-anchor the page-sized fills the import kept, so they sit at the page origin, behind text.

    Returns (page backgrounds found, page backgrounds repaired).

    LibreOffice does not drop a full-bleed page fill; it writes it as a bare VML shape whose style
    names neither a z-index nor a page-relative origin. Word then paints it over the text boxes —
    which are `behindDoc` — and both renderers offset it by the page margin, so it bleeds off the
    opposite corner. Two style properties fix both faults without touching the shape itself.
    """
    found = repaired = 0
    for shape in live_children(paragraph):
        if not _is_vml_shape(shape) or not _is_page_background(shape, width_pt, height_pt):
            continue
        found += 1
        style = _parse_style(shape.get('style'))
        if style.get('z-index', '').startswith('-'):
            continue
        style['mso-position-horizontal-relative'] = 'page'
        style['mso-position-vertical-relative'] = 'page'
        style['margin-left'] = '0pt'
        style['margin-top'] = '0pt'
        style['z-index'] = str(BEHIND_TEXT_Z_INDEX)
        shape.set('style', _format_style(style))
        repaired += 1
    return found, repaired


def _is_vml_shape(element):
    return element.tag.startswith(VML) and element.tag[len(VML) :] in VML_SHAPES


def _is_page_background(shape, width_pt, height_pt):
    """A filled shape that covers the page in both directions is its background."""
    if not (shape.get('fillcolor') or '').strip():
        return False
    style = _parse_style(shape.get('style'))
    width = _points(style.get('width'))
    height = _points(style.get('height'))
    if width is None or height is None:
        return False
    return width >= FULL_BLEED * width_pt and height >= FULL_BLEED * height_pt


def _parse_style(style):
    entries = (part.split(':', 1) for part in (style or '').split(';') if ':' in part)
    return {key.strip(): value.strip() for key, value in entries}


def _format_style(style):
    return ';'.join(f'{key}:{value}' for key, value in style.items())


def _points(value):
    match = re.fullmatch(r'(-?[\d.]+)(pt|in|cm|mm|px)?', (value or '').strip())
    if not match:
        return None
    return float(match.group(1)) * POINTS_PER_UNIT.get(match.group(2) or 'pt', 1.0)


def _next_docpr_id(root):
    used = {int(node.get('id')) for node in root.iter(WP + 'docPr') if (node.get('id') or '').isdigit()}
    return max(used, default=0) + 1


def _element(xml):
    return ElementTree.fromstring(_declare(xml))


def _declare(xml):
    declarations = ' '.join(f'xmlns:{prefix}="{uri}"' for prefix, uri in NAMESPACES.items())
    return xml.replace('<w:r>', f'<w:r {declarations}>', 1)


def _anchor(body_xml, x_emu, y_emu, cx, cy, doc_pr_id, name, behind):
    return f'''<w:r><w:drawing>
      <wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="{doc_pr_id}"
                 behindDoc="{behind}" locked="0" layoutInCell="1" allowOverlap="1">
        <wp:simplePos x="0" y="0"/>
        <wp:positionH relativeFrom="page"><wp:posOffset>{x_emu}</wp:posOffset></wp:positionH>
        <wp:positionV relativeFrom="page"><wp:posOffset>{y_emu}</wp:posOffset></wp:positionV>
        <wp:extent cx="{cx}" cy="{cy}"/>
        <wp:effectExtent l="0" t="0" r="0" b="0"/>
        <wp:wrapNone/>
        <wp:docPr id="{doc_pr_id}" name="{name}"/>
        <a:graphic>{body_xml}</a:graphic>
      </wp:anchor>
    </w:drawing></w:r>'''


def _background_run(color, width_pt, height_pt, doc_pr_id):
    cx, cy = points_to_emu(width_pt), points_to_emu(height_pt)
    shape = f'''<a:graphicData uri="{WPS[1:-1]}">
        <wps:wsp>
          <wps:cNvSpPr/>
          <wps:spPr>
            <a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
            <a:solidFill><a:srgbClr val="{color}"/></a:solidFill>
            <a:ln><a:noFill/></a:ln>
          </wps:spPr>
          <wps:bodyPr/>
        </wps:wsp>
      </a:graphicData>'''
    return _element(_anchor(shape, 0, 0, cx, cy, doc_pr_id, f'Page background {doc_pr_id}', behind='1'))


def _picture_run(relationship_id, placement, doc_pr_id, name):
    cx, cy = points_to_emu(placement['width']), points_to_emu(placement['height'])
    picture = f'''<a:graphicData uri="{PIC[1:-1]}">
        <pic:pic>
          <pic:nvPicPr>
            <pic:cNvPr id="{doc_pr_id}" name="{name}"/>
            <pic:cNvPicPr/>
          </pic:nvPicPr>
          <pic:blipFill><a:blip r:embed="{relationship_id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
          <pic:spPr>
            <a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          </pic:spPr>
        </pic:pic>
      </a:graphicData>'''
    return _element(
        _anchor(
            picture,
            points_to_emu(placement['x']),
            points_to_emu(placement['y']),
            cx,
            cy,
            doc_pr_id,
            name,
            behind='0',
        )
    )


def _encode_image(image, index):
    buffer = io.BytesIO()
    image.convert('RGB').save(buffer, format='PNG')
    return f'restored{index}.png', buffer.getvalue()


def _add_relationship(rels, target):
    used = {node.get('Id') for node in rels}
    number = len(used) + 1
    while f'rIdRestored{number}' in used:
        number += 1
    relationship_id = f'rIdRestored{number}'
    ElementTree.SubElement(
        rels,
        RELS + 'Relationship',
        {'Id': relationship_id, 'Type': IMAGE_RELATIONSHIP, 'Target': target},
    )
    return relationship_id


def _with_content_types(payload, added_media):
    root = ElementTree.fromstring(payload)
    declared = {
        (node.get('Extension') or '').lower() for node in root if node.tag == TYPES + 'Default'
    }
    for name in added_media:
        suffix = Path(name).suffix.lower()
        content_type = CONTENT_TYPE_BY_SUFFIX.get(suffix)
        if not content_type or suffix.lstrip('.') in declared:
            continue
        ElementTree.SubElement(
            root, TYPES + 'Default', {'Extension': suffix.lstrip('.'), 'ContentType': content_type}
        )
        declared.add(suffix.lstrip('.'))
    ElementTree.register_namespace('', TYPES[1:-1])
    return ElementTree.tostring(root, encoding='UTF-8', xml_declaration=True)


def _rewrite(docx_path, parts):
    temporary = docx_path.with_suffix('.docx.restoring')
    with zipfile.ZipFile(temporary, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, payload in parts.items():
            archive.writestr(name, payload)
    shutil.move(str(temporary), str(docx_path))


def has_restorable_gaps(pdf_path, docx_path):
    return bool(page_backgrounds(pdf_path)) or bool(missing_images(pdf_path, docx_path))
