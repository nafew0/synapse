"""How a sheet prints and scrolls, reduced to comparable values.

Shared by copy_sheet.py, which copies these settings to a new tab, and verify_structure.py, which
checks that an edit kept them.
"""

HEADER_FOOTER_ITEMS = ('oddHeader', 'oddFooter', 'evenHeader', 'evenFooter', 'firstHeader', 'firstFooter')
HEADER_FOOTER_PARTS = ('left', 'center', 'right')
MARGIN_SIDES = ('left', 'right', 'top', 'bottom')
MARGIN_PLACES = 2


def header_footer(ws):
    """Every non-empty page header or footer part, as {'oddHeader center': (text, font, size)}."""
    items = {}
    for item in HEADER_FOOTER_ITEMS:
        for part in HEADER_FOOTER_PARTS:
            section = getattr(getattr(ws.HeaderFooter, item), part)
            if section.text:
                items[f'{item} {part}'] = (section.text, section.font, section.size)
    return items


def print_area(ws):
    """The print area without its sheet name, so a copied tab compares equal to its template."""
    if not ws.print_area:
        return None
    areas = ws.print_area if isinstance(ws.print_area, list) else ws.print_area.split(',')
    return ','.join(area.rsplit('!', 1)[-1].replace('$', '') for area in areas)


def page_breaks(ws):
    return {
        'rows': sorted(brk.id for brk in ws.row_breaks.brk),
        'columns': sorted(brk.id for brk in ws.col_breaks.brk),
    }


def layout_key(ws):
    """Settings that decide how the sheet prints and scrolls; scale is left out because fit to
    page overrides it.

    None means the file leaves the setting to the application. LibreOffice fills in its own on
    save, and header and footer margins only matter when there is a header or footer to place.
    """
    setup, properties, margins, options = ws.page_setup, ws.sheet_properties.pageSetUpPr, ws.page_margins, ws.print_options
    headers = header_footer(ws)
    key = {
        'orientation': None if setup.orientation in (None, 'default') else setup.orientation,
        'paper size': int(setup.paperSize) if setup.paperSize else None,
        'fit to page': bool(properties and properties.fitToPage),
        'fit to width': int(1 if setup.fitToWidth is None else setup.fitToWidth),
        'fit to height': int(1 if setup.fitToHeight is None else setup.fitToHeight),
        'print area': print_area(ws),
        'print titles': ws.print_title_rows or None,
        'centered horizontally': bool(options.horizontalCentered),
        'centered vertically': bool(options.verticalCentered),
        'header and footer': headers,
        'header margin': round(margins.header, MARGIN_PLACES) if headers else None,
        'footer margin': round(margins.footer, MARGIN_PLACES) if headers else None,
        'page breaks': page_breaks(ws),
        'freeze panes': ws.freeze_panes,
        'hidden columns': sorted(k for k, v in ws.column_dimensions.items() if v.hidden),
        'hidden rows': sorted(k for k, v in ws.row_dimensions.items() if v.hidden),
    }
    for side in MARGIN_SIDES:
        key[f'{side} margin'] = round(getattr(margins, side), MARGIN_PLACES)
    return key
