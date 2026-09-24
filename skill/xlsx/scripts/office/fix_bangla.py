#!/usr/bin/env python3
"""Give every Bangla run of a DOCX or PPTX a font that draws Bangla, and embed Nikosh in a DOCX.

Word and PowerPoint draw Bangla with a run's complex-script font, not the font most generators
set. docx-js, pptxgenjs and hand-written XML usually leave that slot empty or set it to Calibri,
so the user's PC substitutes some other face. This fixes, for each run containing Bangla:

- the complex-script font (`w:rFonts/@w:cs`, `a:cs`): kept when it draws Bangla, otherwise
  Nikosh (`bangla.font_for`). The Latin font is never touched, so English keeps its face;
- DOCX only: a missing complex-script size or bold/italic (`w:szCs`, `w:bCs`, `w:iCs`) given the
  Latin one's value, because Word sizes and emboldens Bangla by those. One already set is kept;
- the language: `w:lang/@w:bidi` or `a:rPr/@lang` set to bn-BD.

A new document (`--new`) takes Nikosh even where a theme would give Vrinda or another Windows
font, since new Bangla text is set in Nikosh. An edited document keeps any inherited font that
draws Bangla, so an office's own template font survives.

In a DOCX that names Nikosh, the whole font file is embedded (Nikosh does not allow
subsetting), so the document looks the same on a PC without Nikosh. XLSX files cannot embed
fonts; set their Bangla cells with `bangla.font_for` instead.

Usage:
    python fix_bangla.py document.docx [-o fixed.docx] [--new] [--no-embed]
    python fix_bangla.py deck.pptx [-o fixed.pptx] [--new]

Prints JSON and exits 0; 1 on bad input.
"""
import argparse
import json
import re
import sys
import uuid
from pathlib import Path

from lxml import etree

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from office.bangla import DEFAULT_FONT, LANGUAGE, can_draw, font_for, font_path
from office.runs import CT, NS, PKG_REL, R, W, Docx, Package, Pptx, a, w

RPR_ORDER = [
    'rStyle', 'rFonts', 'b', 'bCs', 'i', 'iCs', 'caps', 'smallCaps', 'strike', 'dstrike', 'outline',
    'shadow', 'emboss', 'imprint', 'noProof', 'snapToGrid', 'vanish', 'webHidden', 'color', 'spacing',
    'w', 'kern', 'position', 'sz', 'szCs', 'highlight', 'u', 'effect', 'bdr', 'shd', 'fitText',
    'vertAlign', 'rtl', 'cs', 'em', 'lang', 'eastAsianLayout', 'specVanish', 'oMath',
]
"""Schema order of a Word run's properties; Word rejects a file with them out of order."""
A_RPR_ORDER = [
    'ln', 'noFill', 'solidFill', 'gradFill', 'blipFill', 'pattFill', 'grpFill', 'effectLst', 'effectDag',
    'highlight', 'uLnTx', 'uLn', 'uFillTx', 'uFill', 'latin', 'ea', 'cs', 'sym', 'hlinkClick',
    'hlinkMouseOver', 'rtl', 'extLst',
]
SETTINGS_BEFORE_EMBED = [
    'writeProtection', 'view', 'zoom', 'removePersonalInformation', 'removeDateAndTime',
    'doNotDisplayPageBoundaries', 'displayBackgroundShape', 'printPostScriptOverText',
    'printFractionalCharacterWidth', 'printFormsData',
]
FONT_CHILD_ORDER = ['altName', 'panose1', 'charset', 'family', 'notTrueType', 'pitch', 'sig', 'embedRegular']
FONT_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/font'
FONT_TABLE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable'
SETTINGS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings'
OBFUSCATED_FONT = 'application/vnd.openxmlformats-officedocument.obfuscatedFont'
FONT_TABLE_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml'
SETTINGS_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml'
OFF = ('0', 'false', 'off')


class InputError(Exception):
    pass


def insert_ordered(parent, child, order, namespace):
    """Put `child` where the schema expects it among `parent`'s children."""
    name = etree.QName(child).localname
    rank = order.index(name)
    for index, existing in enumerate(parent):
        qname = etree.QName(existing)
        if qname.namespace == namespace and qname.localname in order and order.index(qname.localname) > rank:
            parent.insert(index, child)
            return child
    parent.append(child)
    return child


def ensure(parent, name, order, namespace):
    found = parent.find(f'{{{namespace}}}{name}')
    if found is not None:
        return found
    return insert_ordered(parent, etree.Element(f'{{{namespace}}}{name}'), order, namespace)


def run_properties(run):
    rpr = run.find('w:rPr', NS)
    if rpr is None:
        rpr = etree.Element(w('rPr'))
        run.insert(0, rpr)
    return rpr


def is_on(element):
    return element is not None and element.get(w('val'), 'true') not in OFF


def chosen_font(font, source, new):
    """The complex-script font a run should name, or None when what it inherits is fine."""
    inherited = source in ('style', 'defaults', 'theme')
    if font and can_draw(font) and not (new and inherited and font != DEFAULT_FONT):
        return None
    return DEFAULT_FONT if new else font_for(font)


def mirror(rpr, latin, complex_script):
    """Give a property's missing complex-script twin the Latin one's value.

    A twin that is already set is left alone: offices often set Bangla a size larger than the
    English on purpose (w:sz 24, w:szCs 28), and that choice is the document's to keep."""
    source = rpr.find(f'w:{latin}', NS)
    if source is None or rpr.find(f'w:{complex_script}', NS) is not None:
        return False
    target = insert_ordered(rpr, etree.Element(w(complex_script)), RPR_ORDER, W)
    if source.get(w('val')) is not None:
        target.set(w('val'), source.get(w('val')))
    return True


def fix_docx_run(run, font, source, new):
    """Changes made to one Word run, as a list of property names."""
    changes = []
    rpr = run_properties(run)
    target = chosen_font(font, source, new)
    if target:
        fonts = ensure(rpr, 'rFonts', RPR_ORDER, W)
        if fonts.get(w('cs')) != target or fonts.get(w('cstheme')):
            fonts.set(w('cs'), target)
            fonts.attrib.pop(w('cstheme'), None)
            changes.append('font')
    for latin, complex_script in (('sz', 'szCs'), ('b', 'bCs'), ('i', 'iCs')):
        if mirror(rpr, latin, complex_script):
            changes.append(complex_script)
    lang = ensure(rpr, 'lang', RPR_ORDER, W)
    if lang.get(w('bidi')) != LANGUAGE:
        lang.set(w('bidi'), LANGUAGE)
        changes.append('lang')
    return changes


def fix_docx_styles(package):
    """Mirror sizes and bold into the complex-script slots of every style, so Bangla in a heading
    is as large and as bold as the English beside it."""
    styles = package.xml('word/styles.xml')
    if styles is None:
        return 0
    count = 0
    for rpr in styles.iter(w('rPr')):
        for latin, complex_script in (('sz', 'szCs'), ('b', 'bCs'), ('i', 'iCs')):
            count += mirror(rpr, latin, complex_script)
    if count:
        package.mark('word/styles.xml')
    return count


def fix_docx(package, new):
    document = Docx(package)
    fixed, fonts = {}, set()
    for run in list(document.runs()):
        if not run.bangla:
            continue
        changes = fix_docx_run(run.element, run.font, run.source, new)
        font, _ = document.cs_font(run.element)
        fonts.add(font)
        for change in changes:
            fixed[change] = fixed.get(change, 0) + 1
        if changes:
            package.mark(run.part)
    styles = fix_docx_styles(package) if fonts else 0
    return {'runs_changed': fixed, 'styles_changed': styles, 'fonts': sorted(f for f in fonts if f)}


def fix_pptx(package, new):
    deck = Pptx(package)
    fixed, fonts = {}, set()
    for run in list(deck.runs()):
        if not run.bangla:
            continue
        rpr = run.element.find('a:rPr', NS)
        if rpr is None:
            rpr = etree.Element(a('rPr'))
            run.element.insert(0, rpr)
        target = chosen_font(run.font, run.source, new)
        if target:
            cs = ensure(rpr, 'cs', A_RPR_ORDER, NS['a'])
            if cs.get('typeface') != target:
                cs.set('typeface', target)
                fixed['font'] = fixed.get('font', 0) + 1
        if rpr.get('lang') != LANGUAGE:
            rpr.set('lang', LANGUAGE)
            fixed['lang'] = fixed.get('lang', 0) + 1
        fonts.add(deck.cs_font(run.element)[0])
        package.mark(run.part)
    return {'runs_changed': fixed, 'fonts': sorted(f for f in fonts if f)}


def relationships(package, part):
    """(rels part name, root) for `part`, created empty when the package has none."""
    folder, name = part.rsplit('/', 1) if '/' in part else ('', part)
    rels = f'{folder}/_rels/{name}.rels' if folder else f'_rels/{name}.rels'
    root = package.xml(rels)
    if root is None:
        root = etree.Element(f'{{{PKG_REL}}}Relationships', nsmap={None: PKG_REL})
    return rels, root


def add_relationship(package, part, kind, target):
    rels, root = relationships(package, part)
    for rel in root:
        if rel.get('Type') == kind and rel.get('Target') == target:
            return rel.get('Id')
    used = {rel.get('Id') for rel in root}
    number = 1
    while f'rId{number}' in used:
        number += 1
    etree.SubElement(root, f'{{{PKG_REL}}}Relationship', Id=f'rId{number}', Type=kind, Target=target)
    package.put_xml(rels, root)
    return f'rId{number}'


def add_content_type(package, extension=None, part=None, content_type=None):
    root = package.xml('[Content_Types].xml')
    if extension and not any(d.get('Extension', '').lower() == extension for d in root.findall(f'{{{CT}}}Default')):
        etree.SubElement(root, f'{{{CT}}}Default', Extension=extension, ContentType=content_type)
        package.mark('[Content_Types].xml')
    if part and not any(o.get('PartName') == f'/{part}' for o in root.findall(f'{{{CT}}}Override')):
        etree.SubElement(root, f'{{{CT}}}Override', PartName=f'/{part}', ContentType=content_type)
        package.mark('[Content_Types].xml')


def word_part(package, name, root_tag, rel_type, content_type):
    """The root of word/<name>, created and registered when the document has none."""
    part = f'word/{name}'
    root = package.xml(part)
    if root is None:
        root = etree.Element(w(root_tag), nsmap={'w': W, 'r': R})
        add_relationship(package, 'word/document.xml', rel_type, name)
        add_content_type(package, part=part, content_type=content_type)
        package.put_xml(part, root)
    return root


def obfuscate(font_bytes, key):
    """ECMA-376 Part 1, 17.8.1: the first 32 bytes XORed with the font key's GUID bytes, read
    from the end of the GUID string backwards."""
    digits = key.strip('{}').replace('-', '')
    guid = bytes.fromhex(digits)[::-1]
    head = bytes(byte ^ guid[index % 16] for index, byte in enumerate(font_bytes[:32]))
    return head + font_bytes[32:]


def settings_position(settings):
    """Index for w:embedTrueTypeFonts: after the few settings the schema puts before it."""
    position = 0
    for index, child in enumerate(settings):
        qname = etree.QName(child)
        if qname.namespace == W and qname.localname in SETTINGS_BEFORE_EMBED:
            position = index + 1
    return position


def embed_docx_font(package, family):
    """Embed the installed `family` in the document. Returns False when it is not installed."""
    path = font_path(family)
    if path is None:
        return False
    table = word_part(package, 'fontTable.xml', 'fonts', FONT_TABLE_REL, FONT_TABLE_TYPE)
    font = next((f for f in table.findall('w:font', NS) if f.get(w('name')) == family), None)
    if font is None:
        font = etree.SubElement(table, w('font'))
        font.set(w('name'), family)
        insert_ordered(font, etree.Element(w('charset')), FONT_CHILD_ORDER, W).set(w('val'), '00')
        insert_ordered(font, etree.Element(w('family')), FONT_CHILD_ORDER, W).set(w('val'), 'auto')
        insert_ordered(font, etree.Element(w('pitch')), FONT_CHILD_ORDER, W).set(w('val'), 'variable')
    if font.find('w:embedRegular', NS) is not None:
        return True
    key = '{' + str(uuid.uuid4()).upper() + '}'
    existing = [n for n in package.names(re.compile(r'^word/fonts/font\d+\.odttf$'))]
    target = f'fonts/font{len(existing) + 1}.odttf'
    package.put_bytes(f'word/{target}', obfuscate(Path(path).read_bytes(), key))
    rel = add_relationship(package, 'word/fontTable.xml', FONT_REL, target)
    embed = insert_ordered(font, etree.Element(w('embedRegular')), FONT_CHILD_ORDER, W)
    embed.set(f'{{{R}}}id', rel)
    embed.set(w('fontKey'), key)
    package.put_xml('word/fontTable.xml', table)
    add_content_type(package, extension='odttf', content_type=OBFUSCATED_FONT)
    settings = word_part(package, 'settings.xml', 'settings', SETTINGS_REL, SETTINGS_TYPE)
    if settings.find('w:embedTrueTypeFonts', NS) is None:
        settings.insert(settings_position(settings), etree.Element(w('embedTrueTypeFonts')))
    subset = settings.find('w:saveSubsetFonts', NS)
    if subset is not None:
        settings.remove(subset)
    package.put_xml('word/settings.xml', settings)
    return True


def fix(path, out, new=False, embed=True):
    package = Package(path)
    suffix = Path(path).suffix.lower()
    if suffix in ('.docx', '.dotx', '.docm'):
        result = fix_docx(package, new)
        uses_default = DEFAULT_FONT in result['fonts']
        result['embedded'] = bool(embed and uses_default and embed_docx_font(package, DEFAULT_FONT))
        if embed and uses_default and not result['embedded']:
            result['warning'] = f'{DEFAULT_FONT} is not installed here, so it was not embedded'
    elif suffix in ('.pptx', '.potx', '.pptm'):
        result = fix_pptx(package, new)
        result['embedded'] = False
    else:
        raise InputError(f'fix_bangla.py takes a .docx or .pptx file, not {path}')
    package.save(out)
    result['output'] = str(out)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('document', type=Path)
    parser.add_argument('-o', '--output', type=Path, help='write here instead of rewriting the input')
    parser.add_argument('--new', action='store_true', help='a document you created: set Bangla in Nikosh')
    parser.add_argument('--no-embed', action='store_true', help='do not embed Nikosh in a DOCX')
    args = parser.parse_args()
    try:
        if not args.document.is_file():
            raise InputError(f'File not found: {args.document}')
        result = fix(args.document, args.output or args.document, args.new, not args.no_embed)
    except (InputError, KeyError, etree.XMLSyntaxError) as error:
        print(json.dumps({'error': str(error)}))
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
