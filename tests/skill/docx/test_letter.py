"""Tests for skill/docx/scripts/crop.py and letter.py.

Kept outside skill/docx/ on purpose: every file in a deployment skill directory is uploaded
into each user's code sandbox.

The build tests need LibreOffice, pdftoppm and fc-match, so they run in the sandbox image:
    python -m pytest tests/skill/docx
"""
import json
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest
from docx import Document
from PIL import Image, ImageDraw

SCRIPTS = Path(__file__).resolve().parents[3] / 'skill' / 'docx' / 'scripts'
needs_office = pytest.mark.skipif(
    not (shutil.which('soffice') and shutil.which('pdftoppm')), reason='needs LibreOffice and poppler'
)


def run(script, *args, cwd):
    return subprocess.run(
        [sys.executable, str(SCRIPTS / script), *map(str, args)], cwd=cwd, capture_output=True, text=True
    )


@pytest.fixture
def scan(tmp_path):
    """A cream page with a dark square 'logo' at 40-80 and a scribble 'signature' at 300-420."""
    page = Image.new('RGB', (600, 800), (250, 248, 235))
    draw = ImageDraw.Draw(page)
    draw.rectangle((40, 40, 80, 80), fill=(20, 20, 20))
    draw.line((300, 500, 360, 470, 420, 510), fill=(30, 30, 90), width=4)
    path = tmp_path / 'scan.png'
    page.save(path)
    return path


def test_fit_bisects_to_the_loosest_step_that_fits(monkeypatch, tmp_path):
    sys.path.insert(0, str(SCRIPTS))
    import letter

    spec = {'page': {'margins_cm': [2.5, 2.5, 2.5, 2.5]}, 'blocks': []}
    ladder = letter.fit_ladder(spec)
    fits_from = len(ladder) - 3
    current = {}
    monkeypatch.setattr(letter, 'build', lambda _spec, _out, style: current.update(index=ladder.index(style)))
    monkeypatch.setattr(letter, 'fit_ladder', lambda _spec: ladder)
    monkeypatch.setattr(letter, 'render', lambda _out, _work: ('p.pdf', 1 if current['index'] >= fits_from else 2))

    style, _, pages, builds = letter.fit(spec, tmp_path / 'o.docx', 1, tmp_path)

    assert (ladder.index(style), pages) == (fits_from, 1)
    assert builds <= 7 < len(ladder)


def test_a_signature_box_grows_up_to_its_ink_and_stops_at_a_gap():
    sys.path.insert(0, str(SCRIPTS))
    from scan_to_docx import signature_top

    page = Image.new('L', (300, 300), 255)
    draw = ImageDraw.Draw(page)
    draw.line((60, 80, 60, 200), fill=0, width=2)
    draw.line((40, 40, 200, 40), fill=0, width=2)
    assert abs(signature_top(page, [20, 150, 280, 220]) - 80) <= 1
    assert signature_top(Image.new('L', (300, 300), 255), [20, 150, 280, 220]) == 150


def test_a_font_is_embedded_where_word_will_find_it(tmp_path):
    sys.path.insert(0, str(SCRIPTS))
    from lxml import etree
    from office.embed import embed_font, obfuscate

    font = tmp_path / 'Nikosh.ttf'
    font.write_bytes(bytes(range(256)) * 4)
    out = tmp_path / 'letter.docx'
    Document().save(out)

    assert embed_font(out, 'Nikosh', path=font)
    assert embed_font(out, 'Nikosh', path=font)

    with zipfile.ZipFile(out) as package:
        names = package.namelist()
        table = etree.fromstring(package.read('word/fontTable.xml'))
        rels = package.read('word/_rels/fontTable.xml.rels').decode()
        settings = package.read('word/settings.xml').decode()
        types = package.read('[Content_Types].xml').decode()
        stored = package.read('word/fonts/font1.odttf')
    w = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
    entry = next(f for f in table if f.get(f'{w}name') == 'Nikosh')
    embed = entry.find(f'{w}embedRegular')
    assert names[0] == '[Content_Types].xml'
    assert [n for n in names if n.startswith('word/fonts/')] == ['word/fonts/font1.odttf']
    assert obfuscate(stored, embed.get(f'{w}fontKey')) == font.read_bytes()
    assert 'Target="fonts/font1.odttf"' in rels
    assert 'embedTrueTypeFonts' in settings
    assert 'Extension="odttf"' in types
    Document(str(out))


def test_embedding_is_skipped_when_the_font_is_not_installed(tmp_path):
    sys.path.insert(0, str(SCRIPTS))
    from office.embed import embed_font

    out = tmp_path / 'letter.docx'
    Document().save(out)
    assert not embed_font(out, 'No Such Font Family 123')


@pytest.mark.skipif(not shutil.which('qpdf'), reason='needs qpdf, as in the sandbox')
def test_a_pdf_cut_short_is_repaired(tmp_path):
    pypdf = pytest.importorskip('pypdf')
    sys.path.insert(0, str(SCRIPTS))
    import scan_to_docx

    writer = pypdf.PdfWriter()
    for _ in range(3):
        writer.add_blank_page(width=200, height=300)
    whole = tmp_path / 'whole.pdf'
    writer.write(str(whole))
    data = whole.read_bytes()
    broken = tmp_path / 'broken.pdf'
    broken.write_bytes(data[: data.rindex(b'xref')])

    repaired = scan_to_docx.repair_pdf(broken, tmp_path)
    assert len(pypdf.PdfReader(str(repaired), strict=True).pages) == 3


def test_a_damaged_pdf_without_qpdf_stops_with_a_clear_message(tmp_path, monkeypatch):
    sys.path.insert(0, str(SCRIPTS))
    import scan_to_docx

    monkeypatch.setattr(scan_to_docx.shutil, 'which', lambda _name: None)
    assert scan_to_docx.repair_pdf(tmp_path / 'broken.pdf', tmp_path) is None


def sideways_line(text, x0, y0, x1, y1, page=1):
    return {
        'type': 'NarrativeText',
        'text': text,
        'metadata': {
            'page_number': page,
            'coordinates': {
                'points': [[x0, y0], [x0, y1], [x1, y1], [x1, y0]],
                'layout_width': 200,
                'layout_height': 300,
            },
        },
    }


def test_a_sideways_page_and_its_boxes_are_turned_upright(tmp_path):
    sys.path.insert(0, str(SCRIPTS))
    from scan_to_docx import text_direction, upright

    elements = [
        sideways_line('মন্ত্রণালয়ের নাম: মাধ্যমিক', 10, 150, 20, 280),
        sideways_line('ক্রম নির্দিষ্ট ফ্ল্যাগশিপ কর্মসূচি', 40, 20, 50, 280),
    ]
    page = tmp_path / 'page-1.png'
    Image.new('L', (200, 300), 255).save(page)

    assert text_direction(elements) == 'clockwise'
    upright(elements, [page])

    with Image.open(page) as turned:
        assert turned.size == (300, 200)
    title = elements[0]['metadata']['coordinates']
    xs, ys = [p[0] for p in title['points']], [p[1] for p in title['points']]
    assert (title['layout_width'], title['layout_height']) == (300, 200)
    assert (min(xs), max(xs), min(ys), max(ys)) == (20, 150, 10, 20)


def test_an_upright_page_is_left_alone(tmp_path):
    sys.path.insert(0, str(SCRIPTS))
    from scan_to_docx import text_direction

    assert text_direction([sideways_line('একটি সাধারণ লাইন যা পাশাপাশি', 10, 10, 190, 30)]) is None


def test_a_landscape_spec_builds_a_landscape_page(tmp_path):
    sys.path.insert(0, str(SCRIPTS))
    from letter import Style, build

    spec = {'page': {'landscape': True, 'margins_cm': [1, 1, 1, 1]}, 'blocks': [{'type': 'paragraph', 'text': 'x'}]}
    out = tmp_path / 'wide.docx'
    style = Style(spec)
    build(spec, out, style)
    section = Document(out).sections[0]
    assert round(section.page_width.cm, 1) == 29.7 and round(style.text_width_cm, 1) == 27.7


def ruled_table(columns_px, height=400, angle=0.0):
    page = Image.new('L', (columns_px[-1] + 80, height + 80), 255)
    draw = ImageDraw.Draw(page)
    for x in columns_px:
        draw.line((x, 40, x, 40 + height), fill=0, width=2)
    for y in (40, 120, 40 + height):
        draw.line((columns_px[0], y, columns_px[-1], y), fill=0, width=2)
    return page.rotate(angle, fillcolor=255, resample=Image.Resampling.BILINEAR).convert('RGB')


def test_a_tilted_table_still_gives_its_column_widths():
    sys.path.insert(0, str(SCRIPTS))
    from scan_to_docx import table_widths

    columns_px = [40, 90, 290, 440, 640]
    page = ruled_table(columns_px, angle=1.5)
    widths = table_widths(page, (40, 40, 640, 440), 4, 0.1)
    assert widths is not None
    assert all(abs(got - want) <= 0.6 for got, want in zip(widths, [5, 20, 15, 20]))


def test_faint_broken_rules_still_give_column_widths():
    sys.path.insert(0, str(SCRIPTS))
    from scan_to_docx import table_widths

    columns_px = [40, 90, 290, 440, 640]
    page = Image.new('L', (720, 480), 255)
    draw = ImageDraw.Draw(page)
    for x in columns_px:
        for y in range(40, 440, 10):
            draw.line((x, y, x, y + 5), fill=150, width=2)
    widths = table_widths(page.convert('RGB'), (40, 40, 640, 440), 4, 0.1)
    assert widths is not None
    assert all(abs(got - want) <= 0.6 for got, want in zip(widths, [5, 20, 15, 20]))


def test_tables_without_readable_rules_share_the_widths_found_elsewhere(tmp_path, monkeypatch):
    sys.path.insert(0, str(SCRIPTS))
    import scan_to_docx

    row = [{'text': 'a'}, {'text': 'b'}, {'text': 'c'}]
    spec = {'blocks': [
        {'type': 'table', 'rows': [row], 'box': [0, 0, 1, 1], 'box_page': 1},
        {'type': 'table', 'rows': [row], 'box': [0, 0, 1, 1], 'box_page': 1},
    ]}
    found = iter([[1.0, 5.0, 3.0], None])
    monkeypatch.setattr(scan_to_docx, 'table_widths', lambda *_args: next(found))
    page = tmp_path / 'page-1.png'
    Image.new('RGB', (10, 10), 'white').save(page)

    scan_to_docx.apply_table_widths(spec, [page], 0.1)

    assert [block['widths_cm'] for block in spec['blocks']] == [[1.0, 5.0, 3.0], [1.0, 5.0, 3.0]]


def test_a_picture_is_not_clipped_by_tight_leading(scan):
    sys.path.insert(0, str(SCRIPTS))
    from docx.enum.text import WD_LINE_SPACING
    from docx.shared import Pt
    from letter import picture

    paragraph = Document().add_paragraph()
    paragraph.paragraph_format.line_spacing_rule = WD_LINE_SPACING.EXACTLY
    paragraph.paragraph_format.line_spacing = Pt(12.5)
    picture(paragraph, scan, 2)
    assert paragraph.paragraph_format.line_spacing_rule == WD_LINE_SPACING.SINGLE


def test_fitting_shrinks_the_signature_but_keeps_its_proportions(scan, tmp_path):
    sys.path.insert(0, str(SCRIPTS))
    from letter import Style, build

    spec = {'blocks': [{'type': 'signature', 'image': str(scan), 'image_width_cm': 4, 'lines': ['Name']}]}
    out = tmp_path / 'out.docx'
    build(spec, out, Style(spec, signature_scale=0.5))
    shape = Document(out).tables[0].rows[0].cells[-1].paragraphs[0].runs[0]._r.xpath('.//wp:extent')[0]
    assert round(int(shape.get('cx')) / 360000, 1) == 2.0
    assert round(int(shape.get('cy')) / int(shape.get('cx')), 2) == round(800 / 600, 2)


def test_crop_trims_to_ink_and_whitens_paper(scan, tmp_path):
    result = run('crop.py', scan, tmp_path / 'qa', 'logo=20,20,120,120', 'sig=280,440,440,540', cwd=tmp_path)

    assert result.returncode == 0, result.stdout
    logo = Image.open(tmp_path / 'qa' / 'logo.png')
    assert logo.width < 60 and logo.height < 60
    assert logo.getpixel((0, 0)) == (255, 255, 255)
    assert 'sig:' in result.stdout


def test_crop_warns_when_a_box_slices_the_ink(scan, tmp_path):
    sliced = run('crop.py', scan, tmp_path / 'qa', 'sig=340,440,440,540', cwd=tmp_path)
    whole = run('crop.py', scan, tmp_path / 'qa', 'sig=280,440,440,540', cwd=tmp_path)

    assert 'BOX CUTS INK on its left side' in sliced.stdout
    assert 'BOX CUTS INK' not in whole.stdout


def test_crop_reports_a_box_with_no_ink(scan, tmp_path):
    result = run('crop.py', scan, tmp_path / 'qa', 'empty=150,150,250,250', cwd=tmp_path)

    assert result.returncode == 1
    assert 'no ink' in result.stdout


def test_crop_read_writes_two_enlarged_halves(scan, tmp_path):
    result = run('crop.py', scan, tmp_path / 'qa', '--read', cwd=tmp_path)

    assert result.returncode == 0
    top = Image.open(tmp_path / 'qa' / 'read-top.jpg')
    assert top.format == 'JPEG' and top.width == 1200


def test_crop_read_writes_a_grid_labelled_in_scan_pixels(tmp_path):
    Image.new('RGB', (3000, 4000), 'white').save(tmp_path / 'page.png')

    run('crop.py', tmp_path / 'page.png', tmp_path / 'qa', '--read', cwd=tmp_path)

    grid = Image.open(tmp_path / 'qa' / 'grid.jpg')
    assert max(grid.size) <= 1568
    scale = grid.width / 3000
    red, green, _ = grid.getpixel((round(1000 * scale), 500))
    assert red > green + 40
    assert (tmp_path / 'qa' / 'grid.jpg').stat().st_size < 1024 * 1024


def test_crop_read_caps_a_high_resolution_page_under_the_read_limit(tmp_path):
    Image.effect_noise((1240, 1754), 40).convert('RGB').save(tmp_path / 'page.png')

    run('crop.py', tmp_path / 'page.png', tmp_path / 'qa', '--read', cwd=tmp_path)

    path = tmp_path / 'qa' / 'read-top.jpg'
    assert max(Image.open(path).size) <= 1568
    assert path.stat().st_size < 1024 * 1024


def spec_for(scan_dir, body_paragraphs=1):
    return {
        'pages': 1,
        'blocks': [
            {'type': 'letterhead', 'logo': str(scan_dir / 'qa' / 'logo.png'), 'logo_width_cm': 1.5,
             'lines': [{'text': 'বাংলাদেশ বিশ্ববিদ্যালয় মঞ্জুরী কমিশন', 'size': 18, 'bold': True}]},
            {'type': 'memo', 'left': 'স্মারক নং- ১২৩', 'right': ['তারিখ : ০১ আশ্বিন ১৪৩৩', '১৬ সেপ্টেম্বর ২০২৬']},
            {'type': 'title', 'text': 'অফিস আদেশ', 'underline': True},
            *[{'type': 'paragraph', 'text': 'কমিশনের আইসিটি বিভাগে পদায়ন করা হলো। ' * 12}] * body_paragraphs,
            {'type': 'signature', 'intro': 'কর্তৃপক্ষের অনুমোদনক্রমে,', 'image': str(scan_dir / 'qa' / 'sig.png'),
             'lines': ['তাহমিনা রহমান', 'যুগ্মসচিব']},
            {'type': 'list', 'items': [['১।', 'সচিব, ইউজিসি, ঢাকা।'], ['২-১২।', 'পরিচালক, ইউজিসি, ঢাকা।']]},
        ],
    }


@needs_office
def test_letter_builds_one_valid_page_with_pictures_and_bangla_font_slot(scan, tmp_path):
    run('crop.py', scan, tmp_path / 'qa', 'logo=20,20,120,120', 'sig=280,440,440,540', cwd=tmp_path)
    (tmp_path / 'spec.json').write_text(json.dumps(spec_for(tmp_path), ensure_ascii=False), encoding='utf-8')

    result = run('letter.py', 'spec.json', 'order.docx', '--source', scan, cwd=tmp_path)

    assert result.returncode == 0, result.stdout + result.stderr
    assert 'pages: 1 (target 1)' in result.stdout
    assert 'pictures placed: 2' in result.stdout
    assert 'validation: passed' in result.stdout
    assert (tmp_path / 'qa' / 'order-compare.jpg').exists()
    document = Document(str(tmp_path / 'order.docx'))
    assert document.core_properties.author == 'Synapse'
    xml = zipfile.ZipFile(tmp_path / 'order.docx').read('word/document.xml').decode()
    assert 'w:cs="Nikosh"' in xml
    assert 'w:bidi="bn-BD"' in xml


@needs_office
def test_letter_shrinks_a_long_order_onto_one_page(scan, tmp_path):
    run('crop.py', scan, tmp_path / 'qa', 'logo=20,20,120,120', 'sig=280,440,440,540', cwd=tmp_path)
    (tmp_path / 'spec.json').write_text(json.dumps(spec_for(tmp_path, 9), ensure_ascii=False), encoding='utf-8')

    result = run('letter.py', 'spec.json', 'order.docx', cwd=tmp_path)

    assert 'pages: 1 (target 1)' in result.stdout, result.stdout + result.stderr
    assert 'builds 1' not in result.stdout


def header_row(columns, label='heading'):
    return [{'text': f'{label} {i}', 'header': True} for i in range(columns)]


def body_row(columns, text='x'):
    return [{'text': f'{text}{i}'} for i in range(columns)]


def test_a_table_continued_on_the_next_page_joins_the_first_without_its_repeated_heading():
    sys.path.insert(0, str(SCRIPTS))
    from scan_to_docx import join_continued_tables

    spec = {'blocks': [
        {'type': 'table', 'rows': [header_row(3), body_row(3, 'a')], 'widths_cm': [1.0, 2.0, 3.0]},
        {'type': 'table', 'rows': [header_row(3, 'heeding'), body_row(3, 'b')], 'page_break': True, 'widths_cm': [1.1, 2.1, 3.1]},
        {'type': 'table', 'rows': [body_row(3, 'c')], 'page_break': True},
        {'type': 'paragraph', 'text': 'after', 'page_break': True},
    ]}
    join_continued_tables(spec)
    table, after = spec['blocks']
    assert [row[0]['text'] for row in table['rows']] == ['heading 0', 'a0', 'b0', 'c0']
    assert table['header_rows'] == 1 and table['widths_cm'] == [1.0, 2.0, 3.0]
    assert table['size'] < 10
    assert after['page_break']


def test_page_numbers_between_continued_tables_do_not_stop_the_join():
    sys.path.insert(0, str(SCRIPTS))
    from scan_to_docx import join_continued_tables

    spec = {'blocks': [
        {'type': 'table', 'rows': [header_row(3), body_row(3, 'a')]},
        {'type': 'paragraph', 'text': '1', 'size': 7},
        {'type': 'table', 'rows': [header_row(3), body_row(3, 'b')], 'page_break': True},
        {'type': 'paragraph', 'text': '২'},
        {'type': 'table', 'rows': [header_row(3), body_row(3, 'c')], 'page_break': True},
        {'type': 'paragraph', 'text': '3'},
    ]}
    join_continued_tables(spec)
    assert [block['type'] for block in spec['blocks']] == ['table', 'paragraph']
    assert [row[0]['text'] for row in spec['blocks'][0]['rows']] == ['heading 0', 'a0', 'b0', 'c0']


def test_a_serial_read_outside_the_table_goes_back_into_its_record():
    sys.path.insert(0, str(SCRIPTS))
    from scan_to_docx import join_continued_tables

    record = [{'text': ''}, {'text': 'record text'}, {'text': ''}]
    spec = {'blocks': [
        {'type': 'table', 'rows': [header_row(3), body_row(3, 'a'), record]},
        {'type': 'paragraph', 'text': '13.'},
        {'type': 'paragraph', 'text': '11'},
        {'type': 'table', 'rows': [header_row(3), body_row(3, 'b')], 'page_break': True},
    ]}
    join_continued_tables(spec)
    assert len(spec['blocks']) == 1
    assert [row[0]['text'] for row in spec['blocks'][0]['rows']] == ['heading 0', 'a0', '13.', 'b0']


def test_a_page_number_before_other_text_is_kept():
    sys.path.insert(0, str(SCRIPTS))
    from scan_to_docx import join_continued_tables

    spec = {'blocks': [
        {'type': 'table', 'rows': [header_row(3), body_row(3)]},
        {'type': 'paragraph', 'text': '1'},
        {'type': 'paragraph', 'text': 'after', 'page_break': True},
    ]}
    join_continued_tables(spec)
    assert [block.get('text') for block in spec['blocks']] == [None, '1', 'after']


def test_tables_with_different_columns_stay_apart():
    sys.path.insert(0, str(SCRIPTS))
    from scan_to_docx import join_continued_tables

    spec = {'blocks': [
        {'type': 'table', 'rows': [header_row(3), body_row(3)]},
        {'type': 'table', 'rows': [header_row(4), body_row(4)], 'page_break': True},
    ]}
    join_continued_tables(spec)
    assert len(spec['blocks']) == 2 and spec['blocks'][1]['page_break']
    assert 'size' not in spec['blocks'][0]


def record(serial, *texts):
    return [{'text': serial}] + [{'text': text} for text in texts]


def test_a_record_cut_at_the_page_edge_goes_on_in_the_same_row():
    sys.path.insert(0, str(SCRIPTS))
    from scan_to_docx import join_continued_tables

    spec = {'blocks': [
        {'type': 'table', 'rows': [header_row(3), record('১.', 'লার্নিং', 'a) প্রশিক্ষিত'), record('২.', 'ভাষা', 'a) মডিউল')]},
        {'type': 'table', 'page_break': True, 'rows': [
            header_row(3), record('', '', 'b) মুদ্রিত বই'), record('', 'কারিগরি', 'a) ট্রেড কোর্স')]},
    ]}
    join_continued_tables(spec)
    rows = spec['blocks'][0]['rows']
    assert [row[0]['text'] for row in rows] == ['heading 0', '১.', '২.', '']
    assert rows[2][1]['text'] == 'ভাষা' and rows[2][2]['text'] == 'a) মডিউল b) মুদ্রিত বই'
    assert rows[3][1]['text'] == 'কারিগরি'


def test_text_left_between_two_pages_of_a_table_stays_as_a_row_across_it():
    sys.path.insert(0, str(SCRIPTS))
    from scan_to_docx import join_continued_tables

    spec = {'blocks': [
        {'type': 'table', 'rows': [header_row(3), record('১.', 'a', 'b')]},
        {'type': 'paragraph', 'text': '২. বাধ্যতামূল ক তৃতীয় ভাষা'},
        {'type': 'paragraph', 'text': '2'},
        {'type': 'table', 'page_break': True, 'rows': [header_row(3), record('৩.', 'c', 'd')]},
    ]}
    join_continued_tables(spec)
    assert len(spec['blocks']) == 1
    rows = spec['blocks'][0]['rows']
    assert rows[2] == [{'text': '২. বাধ্যতামূলক তৃতীয় ভাষা', 'colspan': 3}]
    assert rows[3][0]['text'] == '৩.'


def test_an_early_page_edge_record_joins_once_later_pages_show_the_records_are_numbered():
    sys.path.insert(0, str(SCRIPTS))
    from scan_to_docx import join_continued_tables

    spec = {'blocks': [
        {'type': 'table', 'rows': [header_row(3), record('১.', 'a', 'x'), record('', 'b', 'y')]},
        {'type': 'table', 'page_break': True, 'rows': [header_row(3), record('', '', 'more'), record('৩.', 'c', 'z'), record('৪.', 'd', 'w')]},
    ]}
    join_continued_tables(spec)
    rows = spec['blocks'][0]['rows']
    assert [row[0]['text'] for row in rows] == ['heading 0', '১.', '', '৩.', '৪.']
    assert rows[2][2]['text'] == 'y more'


def test_a_table_without_numbered_records_keeps_the_next_page_rows_apart():
    sys.path.insert(0, str(SCRIPTS))
    from scan_to_docx import join_continued_tables

    spec = {'blocks': [
        {'type': 'table', 'rows': [header_row(2), record('', 'এক'), record('', 'দুই')]},
        {'type': 'table', 'page_break': True, 'rows': [header_row(2), record('', 'তিন')]},
    ]}
    join_continued_tables(spec)
    assert [row[1]['text'] for row in spec['blocks'][0]['rows']] == ['heading 1', 'এক', 'দুই', 'তিন']


def test_misread_serial_numbers_are_counted_again_in_the_table_digits():
    sys.path.insert(0, str(SCRIPTS))
    from scan_to_docx import renumber_serials

    serials = ['#', '1.', '২.', '3.', '4.', '৫.', '১.', '7.', '3.', '', '10.']
    rows = [header_row(2)] + [record(serial, 'বাংলা লেখা') for serial in serials]
    spec = {'blocks': [{'type': 'table', 'header_rows': 1, 'rows': rows}]}
    renumber_serials(spec)
    assert [row[0]['text'] for row in spec['blocks'][0]['rows'][1:]] == [
        '#', '১.', '২.', '৩.', '৪.', '৫.', '৬.', '৭.', '৮.', '৯.', '১০.']


def test_serials_read_as_letters_count_as_digits():
    sys.path.insert(0, str(SCRIPTS))
    from scan_to_docx import renumber_serials, serial_value

    assert [serial_value(text) for text in ('L.', 'l.', 'LO.', 'L7.', "'6.", 'I2)')] == [1, 1, 10, 17, 6, 12]
    assert serial_value('লার্নিং') is None
    serials = ['L.', '2.', '3.', 'l.', '5.', '6.', 'L7.', '8.', '9.', 'LO.']
    rows = [header_row(2)] + [record(serial, 'text') for serial in serials]
    spec = {'blocks': [{'type': 'table', 'header_rows': 1, 'rows': rows}]}
    renumber_serials(spec)
    assert [row[0]['text'] for row in spec['blocks'][0]['rows'][1:]] == [f'{n}.' for n in range(1, 11)]


def test_a_record_kept_as_a_full_width_row_counts_and_its_rest_does_not():
    sys.path.insert(0, str(SCRIPTS))
    from scan_to_docx import renumber_serials

    rows = [header_row(3), record('L.', 'a', 'b'), [{'text': '২. ভাষা শিক্ষা a) মডিউল', 'colspan': 3}],
            record('', '', 'f) আরও'), record('3.', 'c', 'd'), record('', 'e', 'f'), record('5.', 'g', 'h')]
    spec = {'blocks': [{'type': 'table', 'header_rows': 1, 'rows': rows}]}
    renumber_serials(spec)
    out = spec['blocks'][0]['rows'][1:]
    assert [row[0]['text'] for row in out] == ['১.', '২. ভাষা শিক্ষা a) মডিউল', '', '৩.', '৪.', '৫.']


def test_numbers_that_do_not_count_the_records_are_left_as_read():
    sys.path.insert(0, str(SCRIPTS))
    from scan_to_docx import renumber_serials

    for serials in (['4.', '9.', '12.', '30.'], ['1.', '2.', 'ক', '4.']):
        rows = [header_row(2)] + [record(serial, 'text') for serial in serials]
        spec = {'blocks': [{'type': 'table', 'header_rows': 1, 'rows': rows}]}
        renumber_serials(spec)
        assert [row[0]['text'] for row in spec['blocks'][0]['rows'][1:]] == serials


def test_wordy_columns_widen_and_empty_ones_narrow_within_the_same_total():
    sys.path.insert(0, str(SCRIPTS))
    from scan_to_docx import WORD_CHARACTER_CM, balance_widths

    wordy = 'অনেক লম্বা বাংলা লেখা যা ঘরের ভিতর মোড়ানো হয় ' * 6
    rows = [header_row(4)] + [[{'text': '১'}, {'text': wordy}, {'text': ''}, {'text': '২০২৬-২৭'}] for _ in range(5)]
    spec = {'blocks': [{'type': 'table', 'rows': rows, 'header_rows': 1, 'widths_cm': [3.0, 3.0, 3.0, 3.0]}]}
    balance_widths(spec)
    widths = spec['blocks'][0]['widths_cm']
    assert abs(sum(widths) - 12.0) < 0.05
    assert widths[1] > 4.5 and widths[2] < 3.0
    assert widths[3] >= len('২০২৬-২৭') * WORD_CHARACTER_CM


def test_heading_rows_repeat_on_every_page(tmp_path):
    sys.path.insert(0, str(SCRIPTS))
    from letter import Style, build

    spec = {'blocks': [{'type': 'table', 'rows': [header_row(2), body_row(2)], 'header_rows': 1}]}
    out = tmp_path / 'table.docx'
    build(spec, out, Style(spec))
    rows = Document(out).tables[0].rows
    assert rows[0]._tr.trPr.find('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}tblHeader') is not None
    assert rows[1]._tr.trPr is None or rows[1]._tr.trPr.find('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}tblHeader') is None


def test_no_column_is_scaled_under_its_longest_word():
    sys.path.insert(0, str(SCRIPTS))
    from scan_to_docx import fit_above_floors

    widths = fit_above_floors([1.0, 1.0, 8.0], [2.0, 0.5, 0.5], 6.0)
    assert abs(sum(widths) - 6.0) < 1e-9
    assert widths[0] == 2.0 and widths[1] >= 0.5 and widths[2] > widths[1]


def test_smaller_type_lets_a_column_narrow_to_its_longest_word_at_that_size():
    sys.path.insert(0, str(SCRIPTS))
    from scan_to_docx import balance_widths

    rows = [header_row(3)] + [[{'text': 'লক্ষ্যমাত্রা'}, {'text': 'লেখা ' * 80}, {'text': 'x'}] for _ in range(3)]

    def first_width(size):
        block = {'type': 'table', 'rows': rows, 'header_rows': 1, 'widths_cm': [2.2, 3.0, 3.0], 'size': size}
        balance_widths({'font': {'size': 10.5}, 'blocks': [block]})
        return block['widths_cm'][0]

    assert first_width(8.5) < first_width(10.5)


def upright_line(text, x0, y0, x1, y1, page=1):
    line = sideways_line(text, x0, y0, x1, y1, page)
    line['metadata']['coordinates'].update(layout_width=300, layout_height=200)
    return line


def test_a_sideways_page_turns_by_how_its_lines_run_not_by_a_stamp_read_first():
    sys.path.insert(0, str(SCRIPTS))
    from scan_to_docx import text_direction

    elements = [
        sideways_line('অফিসের সিল ও তারিখ এখানে', 180, 20, 190, 120),
        sideways_line('মন্ত্রণালয়ের নাম: মাধ্যমিক', 10, 150, 20, 280),
        sideways_line('ক্রম নির্দিষ্ট ফ্ল্যাগশিপ কর্মসূচি', 40, 20, 50, 280),
        sideways_line('দ্বিতীয় সারির লেখা এখানে আছে', 70, 20, 80, 280),
        sideways_line('তৃতীয় সারির লেখা এখানে আছে', 100, 20, 110, 280),
        sideways_line('চতুর্থ সারির লেখা এখানে আছে', 130, 20, 140, 280),
    ]
    assert text_direction(elements) == 'clockwise'


def test_an_upside_down_page_and_its_boxes_are_turned_round(tmp_path):
    sys.path.insert(0, str(SCRIPTS))
    from scan_to_docx import text_direction, upright

    elements = [
        upright_line('মন্ত্রণালয়ের নাম: মাধ্যমিক', 20, 170, 280, 180),
        upright_line('প্রথম অনুচ্ছেদের লেখা এখানে', 20, 100, 280, 110),
        upright_line('শেষ লাইনের লেখা এখানে আছে', 20, 20, 280, 30),
    ]
    page = tmp_path / 'page-1.png'
    image = Image.new('L', (300, 200), 255)
    image.putpixel((0, 0), 0)
    image.save(page)

    assert text_direction(elements) == 'upside_down'
    upright(elements, [page])

    with Image.open(page) as turned:
        assert turned.size == (300, 200) and turned.getpixel((299, 199)) == 0
    first = elements[0]['metadata']['coordinates']
    ys = [p[1] for p in first['points']]
    assert (min(ys), max(ys)) == (20, 30) and first['layout_height'] == 200


def test_a_page_read_top_to_bottom_is_left_alone():
    sys.path.insert(0, str(SCRIPTS))
    from scan_to_docx import text_direction

    elements = [
        upright_line('মন্ত্রণালয়ের নাম: মাধ্যমিক', 20, 20, 280, 30),
        upright_line('প্রথম অনুচ্ছেদের লেখা এখানে', 20, 100, 280, 110),
        upright_line('শেষ লাইনের লেখা এখানে আছে', 20, 170, 280, 180),
    ]
    assert text_direction(elements) is None


BBOX = '''<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml"><head><title></title></head><body><doc>
<page width="595.000000" height="842.000000"><flow>
<block xMin="72.0" yMin="70.0" xMax="300.0" yMax="100.0">
<line xMin="72.0" yMin="70.0" xMax="300.0" yMax="84.0"><word xMin="72" yMin="70" xMax="120" yMax="84">বার্ষিক</word><word xMin="125" yMin="70" xMax="300" yMax="84">প্রতিবেদন</word></line>
<line xMin="72.0" yMin="86.0" xMax="200.0" yMax="100.0"><word xMin="72" yMin="86" xMax="200" yMax="100">২০২৬</word></line>
</block>
<block xMin="72.0" yMin="150.0" xMax="520.0" yMax="170.0"><line xMin="72" yMin="150" xMax="520" yMax="170"><word xMin="72" yMin="150" xMax="520" yMax="170">AT&amp;T</word></line></block>
</flow></page></doc></body></html>'''


def test_a_digital_page_s_blocks_keep_their_lines_and_positions():
    sys.path.insert(0, str(SCRIPTS))
    from scan_to_docx import bbox_elements

    first, second = bbox_elements(BBOX, 3)
    assert first['text'] == 'বার্ষিক প্রতিবেদন\n২০২৬' and second['text'] == 'AT&T'
    coordinates = first['metadata']['coordinates']
    assert first['metadata']['page_number'] == 3
    assert (coordinates['layout_width'], coordinates['layout_height']) == (595.0, 842.0)
    assert coordinates['points'][0] == [72.0, 70.0] and coordinates['points'][2] == [300.0, 100.0]


def test_parser_text_pages_are_replaced_by_the_pdf_s_own_blocks():
    sys.path.insert(0, str(SCRIPTS))
    from scan_to_docx import with_digital_pages

    scanned = sideways_line('স্ক্যান করা পাতার লেখা', 10, 10, 190, 30, page=1)
    parser = {'type': 'NarrativeText', 'text': 'flat text', 'metadata': {'page_number': 2, 'source': 'parser'}}
    unread = {'type': 'NarrativeText', 'text': 'kept', 'metadata': {'page_number': 3, 'source': 'parser'}}
    blocks = [{'type': 'NarrativeText', 'text': f'block {n}', 'metadata': {'page_number': 2}} for n in (1, 2)]
    merged = with_digital_pages([scanned, parser, unread], 'x.pdf', read=lambda _source, page: blocks if page == 2 else [])
    assert [e['text'] for e in merged] == ['স্ক্যান করা পাতার লেখা', 'block 1', 'block 2', 'kept']


def test_a_section_turns_the_page_and_default_table_widths_fill_it(tmp_path):
    sys.path.insert(0, str(SCRIPTS))
    from letter import Style, build

    spec = {'page': {'margins_cm': [1, 1, 1, 1]}, 'blocks': [
        {'type': 'paragraph', 'text': 'portrait'},
        {'type': 'table', 'rows': [body_row(2)], 'section': {'landscape': True}},
    ]}
    out = tmp_path / 'mixed.docx'
    build(spec, out, Style(spec))
    document = Document(out)
    portrait, landscape = document.sections
    assert portrait.page_width < portrait.page_height and landscape.page_width > landscape.page_height
    width = sum(cell.width.cm for cell in document.tables[0].rows[0].cells)
    assert abs(width - 27.7) < 0.1


def test_picture_widths_use_their_own_page_s_scale(tmp_path):
    sys.path.insert(0, str(SCRIPTS))
    import scan_to_docx

    Image.new('RGB', (100, 50), 'white').save(tmp_path / 'image4.png')
    spec = {'blocks': [{'type': 'image', 'path': str(tmp_path / 'image4.png')}]}
    scan_to_docx.place_pictures(spec, {'image4'}, tmp_path, {1: 0.01, 2: 0.03}, {'image4': 2})
    assert spec['blocks'][0]['width_cm'] == 3.0


def test_a_straight_table_is_not_tilted():
    sys.path.insert(0, str(SCRIPTS))
    from PIL import ImageOps
    from scan_to_docx import skew_angle

    page = ruled_table([40, 90, 290, 440, 640])
    assert skew_angle(ImageOps.grayscale(page.crop((24, 40, 656, 440)))) == 0


def test_rules_that_cover_only_part_of_the_table_give_no_widths():
    sys.path.insert(0, str(SCRIPTS))
    from scan_to_docx import table_widths

    page = ruled_table([40, 90, 140, 190])
    assert table_widths(page, (40, 40, 640, 440), 3, 0.1) is None


def width_spec(*boxes, margins=(1.0, 1.5, 1.0, 1.5)):
    row = [{'text': 'a'}, {'text': 'b'}, {'text': 'c'}]
    return {'page': {'margins_cm': list(margins)}, 'blocks': [
        {'type': 'table', 'rows': [row], 'box': list(box), 'box_page': 1} for box in boxes
    ]}


def blank_page(tmp_path, width=700):
    page = tmp_path / 'page-1.png'
    Image.new('RGB', (width, 1000), 'white').save(page)
    return page


def test_measured_widths_are_scaled_to_the_table_s_width_on_the_page(tmp_path, monkeypatch):
    sys.path.insert(0, str(SCRIPTS))
    import scan_to_docx

    spec = width_spec((50, 100, 550, 400))
    monkeypatch.setattr(scan_to_docx, 'table_widths', lambda *_args: [1.0, 2.0, 1.0])
    scan_to_docx.apply_table_widths(spec, [blank_page(tmp_path)], 0.03)
    assert spec['blocks'][0]['widths_cm'] == [3.75, 7.5, 3.75]


def test_a_table_is_never_wider_than_the_page_s_text(tmp_path, monkeypatch):
    sys.path.insert(0, str(SCRIPTS))
    import scan_to_docx

    spec = width_spec((0, 100, 700, 400))
    monkeypatch.setattr(scan_to_docx, 'table_widths', lambda *_args: [1.0, 1.0, 1.0])
    scan_to_docx.apply_table_widths(spec, [blank_page(tmp_path)], 0.03)
    assert abs(sum(spec['blocks'][0]['widths_cm']) - 18.0) < 0.02


def test_a_table_with_no_readable_rules_fills_its_width_evenly(tmp_path, monkeypatch):
    sys.path.insert(0, str(SCRIPTS))
    import scan_to_docx

    spec = width_spec((50, 100, 650, 400))
    monkeypatch.setattr(scan_to_docx, 'table_widths', lambda *_args: None)
    scan_to_docx.apply_table_widths(spec, [blank_page(tmp_path)], 0.03)
    assert spec['blocks'][0]['widths_cm'] == [6.0, 6.0, 6.0]


def bangla_font(size):
    from PIL import ImageFont

    found = subprocess.run(['fc-match', '-f', '%{file}', 'Nikosh'], capture_output=True, text=True).stdout
    if 'nikosh' not in found.lower():
        pytest.skip('Nikosh is not installed')
    return ImageFont.truetype(found, size)


BODY_LINE = 'সংশ্লিষ্ট সকলকে জানানো যাচ্ছে যে বিশ্ববিদ্যালয়ের অধীনে পরীক্ষার আবেদন'


def typed_page(lines, size=(1400, 1400)):
    """A white page with each (text, x, y, px, bold) line drawn in Nikosh; bold is a 1 px outline."""
    page = Image.new('RGB', size, 'white')
    draw = ImageDraw.Draw(page)
    for text, x, y, px, bold in lines:
        draw.text((x, y), text, fill='black', font=bangla_font(px), stroke_width=1 if bold else 0, stroke_fill='black')
    return page


def ink_box(page, top, bottom):
    from PIL import ImageOps

    gray = ImageOps.grayscale(page.crop((0, top, page.width, bottom)))
    xs = [x for x in range(gray.width) if any(gray.getpixel((x, y)) < 160 for y in range(gray.height))]
    return [min(xs) - 4, top, max(xs) + 4, bottom]


def test_a_larger_line_measures_taller_and_a_bold_one_heavier():
    sys.path.insert(0, str(SCRIPTS))
    from scan_to_docx import measure_type

    page = typed_page([(BODY_LINE, 40, 40, 30, False), ('সংশোধিত বিজ্ঞপ্তি', 40, 200, 48, False), (BODY_LINE, 40, 400, 30, True)])
    body = measure_type(page, ink_box(page, 30, 100))
    large = measure_type(page, ink_box(page, 190, 290))
    bold = measure_type(page, ink_box(page, 390, 460))
    assert large['height'] / body['height'] > 1.4
    assert abs(bold['height'] / body['height'] - 1) < 0.15
    assert bold['stroke'] / body['stroke'] > 1.25


def test_two_wrapped_lines_measure_as_one_line_high():
    sys.path.insert(0, str(SCRIPTS))
    from scan_to_docx import measure_type

    page = typed_page([(BODY_LINE, 40, 40, 30, False), (BODY_LINE, 40, 90, 30, False), (BODY_LINE, 40, 300, 30, False)])
    two = measure_type(page, ink_box(page, 30, 150))
    one = measure_type(page, ink_box(page, 290, 360))
    assert abs(two['height'] / one['height'] - 1) < 0.15


def test_size_and_bold_follow_the_scan_not_the_block_s_kind(tmp_path):
    sys.path.insert(0, str(SCRIPTS))
    from scan_to_docx import apply_type

    page = typed_page([
        ('সংশোধিত বিজ্ঞপ্তি', 40, 40, 48, True),
        ('একটি সাধারণ শিরোনাম লাইন', 40, 160, 30, False),
        (BODY_LINE, 40, 260, 30, False),
        (BODY_LINE, 40, 310, 30, False),
        ('০৯। বিবিধঃ', 40, 420, 30, True),
        ('১০। সাধারণ তালিকার লাইন', 40, 500, 30, False),
    ])
    path = tmp_path / 'page-1.png'
    page.save(path)
    spec = {'font': {'size': 10.5}, 'blocks': [
        {'type': 'paragraph', 'text': 'সংশোধিত বিজ্ঞপ্তি', 'type_box': ink_box(page, 30, 130), 'type_page': 1},
        {'type': 'title', 'text': 'একটি সাধারণ শিরোনাম লাইন', 'type_box': ink_box(page, 150, 220), 'type_page': 1},
        {'type': 'paragraph', 'text': BODY_LINE * 2, 'type_box': ink_box(page, 250, 370), 'type_page': 1},
        {'type': 'list', 'items': [['০৯।', 'বিবিধঃ'], ['১০।', 'সাধারণ তালিকার লাইন']], 'item_boxes': [
            {'type_box': ink_box(page, 410, 480), 'type_page': 1},
            {'type_box': ink_box(page, 490, 560), 'type_page': 1},
        ]},
    ]}
    apply_type(spec, [path])
    large, title, body, items = spec['blocks']
    assert large['size'] > 14 and large['bold'] is True
    assert title['size'] == 10.5 and title['bold'] is False
    assert 'size' not in body and not body.get('bold')
    assert [style['bold'] for style in items['item_styles']] == [True, False]
    assert not any('type_box' in block or 'item_boxes' in block for block in spec['blocks'])


def test_a_list_item_s_own_style_is_used(tmp_path):
    sys.path.insert(0, str(SCRIPTS))
    from letter import Style, build

    spec = {'blocks': [{'type': 'list', 'items': [['১।', 'এক'], ['২।', 'দুই']], 'item_styles': [{'bold': True}, {}]}]}
    out = tmp_path / 'list.docx'
    build(spec, out, Style(spec))
    first, second = [p for p in Document(out).paragraphs if p.text.strip()]
    assert all(run.bold for run in first.runs if run.text.strip())
    assert not any(run.bold for run in second.runs if run.text.strip())


def test_a_line_that_cannot_be_matched_to_its_band_is_not_measured():
    sys.path.insert(0, str(SCRIPTS))
    from scan_to_docx import measure_type

    page = typed_page([(BODY_LINE, 40, 40, 30, False), (BODY_LINE, 40, 120, 30, False), (BODY_LINE, 40, 200, 30, False)])
    assert measure_type(page, ink_box(page, 30, 260), [1, 3]) is not None
    assert measure_type(page, ink_box(page, 30, 260), [1, 5]) is None


def test_a_logo_crop_keeps_the_emblem_not_its_caption(tmp_path):
    sys.path.insert(0, str(SCRIPTS))
    from scan_to_docx import keep_largest_shape

    page = Image.new('RGB', (400, 300), 'white')
    draw = ImageDraw.Draw(page)
    draw.rectangle((160, 10, 230, 110), outline='black', width=6)
    draw.text((20, 150), 'বাংলাদেশ বিশ্ববিদ্যালয় মঞ্জুরী কমিশন', fill='black', font=bangla_font(30))
    draw.text((20, 200), 'বিশ্ববিদ্যালয় মঞ্জুরী কমিশন বাংলাদেশ', fill='black', font=bangla_font(30))
    path = tmp_path / 'logo.png'
    page.save(path)
    keep_largest_shape(path)
    with Image.open(path) as kept:
        assert kept.height > kept.width * 0.8


SHARED_LINES = [
    ('কর্তৃপক্ষের অনুমোদনক্রমে,', 760, 60),
    ('তাহমিনা রহমান', 800, 110),
    ('যুগ্মসচিব', 830, 150),
    ('প্রকৌ. মোহাম্মদ জিয়াউর রহমান', 60, 190),
    ('অতিরিক্ত পরিচালক', 60, 230),
    ('স্মারক নং- ইউজিসি/প্রশা/৩৩২/০৬', 60, 330),
    ('তারিখ : ০১ আশ্বিন ১৪৩৩', 800, 330),
    ('১। সচিব, ইউজিসি, ঢাকা।', 60, 430),
    ('২। পরিচালক, আইসিটি বিভাগ, ইউজিসি, ঢাকা।', 60, 470),
]


def shared_page(tmp_path):
    page = typed_page([(text, x, y, 28, False) for text, x, y in SHARED_LINES], size=(1200, 600))
    path = tmp_path / 'page-1.png'
    page.save(path)
    element = {
        'type': 'NarrativeText',
        'text': '\n'.join(text for text, _, _ in SHARED_LINES),
        'metadata': {'page_number': 1, 'coordinates': {
            'points': [[40, 40], [40, 520], [1160, 520], [1160, 40]], 'layout_width': 1200, 'layout_height': 600,
        }},
    }
    return element, path


def test_lines_sharing_one_wide_box_get_their_own_place_on_the_page(tmp_path):
    sys.path.insert(0, str(SCRIPTS))
    from scan_to_docx import place_shared_lines

    element, path = shared_page(tmp_path)
    placed = place_shared_lines([element], [path])
    assert [e['text'] for e in placed] == [text for text, _, _ in SHARED_LINES]
    for (text, x, y), found in zip(SHARED_LINES, placed):
        points = found['metadata']['coordinates']['points']
        x0, y0 = min(p[0] for p in points), min(p[1] for p in points)
        assert abs(x0 - x) < 30 and abs(y0 - y) < 30, text


def test_a_shared_box_that_cannot_be_matched_is_left_as_it_was(tmp_path):
    sys.path.insert(0, str(SCRIPTS))
    from scan_to_docx import place_shared_lines

    element, path = shared_page(tmp_path)
    element = {**element, 'text': 'একেবারে অন্য লেখা\nযা পাতায় নেই\nএবং মিলবে না\nকোনোভাবেই না এখানে'}
    assert place_shared_lines([element], [path]) == [element]


def test_handwriting_in_a_shared_box_gets_no_box_and_the_print_is_still_placed(tmp_path):
    sys.path.insert(0, str(SCRIPTS))
    from scan_to_docx import place_shared_lines

    element, path = shared_page(tmp_path)
    lines = [text for text, _, _ in SHARED_LINES]
    element = {**element, 'text': '\n'.join([lines[0], 'Tahmina Rahman', '16.09.26', *lines[1:]])}
    placed = place_shared_lines([element], [path])
    by_text = {e['text']: e for e in placed}
    assert 'coordinates' not in by_text['Tahmina Rahman']['metadata']
    assert 'coordinates' not in by_text['16.09.26']['metadata']
    points = by_text['যুগ্মসচিব']['metadata']['coordinates']['points']
    assert abs(min(p[0] for p in points) - 830) < 30


# Line pieces of a photographed UGC order's signature region, in its pixels, and the lengths of the
# lines Parse read there. The handwriting under the intro comes out as two short pieces.
ORDER_PIECES = [[[382, 0, 390, 9], 0], [[308, 38, 406, 119], 0], [[419, 2, 530, 15], 1], [[429, 29, 553, 48], 1], [[508, 48, 569, 58], 1], [[262, 13, 319, 59], 2], [[362, 10, 381, 23], 3], [[342, 24, 359, 36], 4], [[305, 37, 333, 53], 5], [[389, 35, 394, 37], 6], [[392, 45, 409, 49], 7], [[441, 57, 508, 68], 8], [[456, 74, 492, 87], 8], [[410, 91, 537, 102], 8], [[13, 85, 149, 95], 9], [[13, 102, 92, 111], 9], [[13, 118, 76, 128], 9], [[13, 134, 176, 147], 9], [[7, 159, 304, 180], 9], [[319, 133, 323, 136], 10], [[475, 157, 549, 167], 11], [[430, 168, 556, 177], 11], [[472, 175, 557, 185], 12], [[5, 198, 320, 213], 13], [[47, 215, 137, 228], 13], [[6, 232, 563, 245], 13], [[47, 248, 562, 262], 13], [[47, 266, 562, 279], 13], [[46, 282, 151, 295], 13], [[46, 299, 395, 313], 13], [[46, 316, 312, 328], 13], [[4, 332, 364, 345], 13], [[45, 349, 266, 361], 13], [[4, 366, 125, 377], 13], [[6, 219, 16, 226], 14], [[5, 302, 22, 309], 15], [[5, 319, 15, 326], 16], [[399, 329, 525, 411], 17], [[420, 417, 513, 427], 17], [[4, 353, 15, 359], 18], [[533, 361, 541, 367], 19]]
ORDER_LINE_LENGTHS = [25, 23, 13, 9, 21, 29, 16, 12, 38, 54, 22, 18, 74, 22, 363, 71, 60, 77, 52, 28, 8, 15, 19]
ORDER_HANDWRITTEN = [False, True, False, False, False, False, False, False, False, False, False, False, False, False, False, False, False, False, False, False, True, False, False]


def test_a_handwritten_line_takes_its_pieces_so_the_printed_intro_keeps_one_row():
    """With the handwriting left out of the matching, the intro wrapped over its two pieces, so
    the signature's picture started at the intro and the handwriting had no place of its own."""
    sys.path.insert(0, str(SCRIPTS))
    from scan_to_docx import match_lines

    lines = ['ক' * length for length in ORDER_LINE_LENGTHS]
    ordered = [(piece, block) for piece, block in ORDER_PIECES]
    taken, _ = match_lines(lines, ordered, ORDER_HANDWRITTEN)
    assert taken[:3] == [[2], [3, 4], [11]]


def test_a_handwritten_line_with_no_ink_of_its_own_takes_nothing():
    sys.path.insert(0, str(SCRIPTS))
    from scan_to_docx import match_lines

    pieces = [[0, 0, 111, 13], [22, 20, 89, 31]]
    taken, _ = match_lines(['কর্তৃপক্ষের অনুমোদনক্রমে,', 'Tahmina Rahman', 'তাহমিনা রহমান'], [(p, 0) for p in pieces], [False, True, False])
    assert taken == [[0], [], [1]]


def test_crop_whitens_the_grey_paper_of_a_phone_photo(tmp_path):
    page = Image.new('RGB', (300, 200), (196, 192, 184))
    ImageDraw.Draw(page).line((60, 120, 120, 80, 200, 130), fill=(40, 40, 70), width=4)
    page.save(tmp_path / 'photo.png')
    result = run('crop.py', tmp_path / 'photo.png', tmp_path / 'qa', 'sig=40,60,230,150', cwd=tmp_path)

    assert result.returncode == 0, result.stdout
    sig = Image.open(tmp_path / 'qa' / 'sig.png')
    assert sig.getpixel((0, 0)) == (255, 255, 255)


def test_printed_lines_beside_a_signature_are_painted_out_before_cropping(tmp_path):
    sys.path.insert(0, str(SCRIPTS))
    from scan_to_docx import without_print

    page = Image.new('RGB', (200, 100), 'white')
    ImageDraw.Draw(page).rectangle((20, 60, 120, 70), fill='black')
    page.save(tmp_path / 'page.png')
    masked = without_print(tmp_path / 'page.png', [{'name': 'sig1', 'box': [0, 0, 200, 70], 'mask': [[20, 60, 120, 70]]}], tmp_path)

    assert Image.open(masked).getpixel((70, 65)) == (255, 255, 255)
    assert without_print(tmp_path / 'page.png', [{'name': 'logo', 'box': [0, 0, 50, 50]}], tmp_path) == tmp_path / 'page.png'


def test_a_crop_is_enlarged_smoothly_and_keeps_its_shape(tmp_path):
    sys.path.insert(0, str(SCRIPTS))
    from scan_to_docx import ENLARGE, enlarge

    Image.new('RGB', (40, 20), 'white').save(tmp_path / 'sig.png')
    enlarge(tmp_path / 'sig.png')
    assert Image.open(tmp_path / 'sig.png').size == (40 * ENLARGE, 20 * ENLARGE)


@needs_office
def test_the_words_under_a_logo_print_under_it(scan, tmp_path):
    run('crop.py', scan, tmp_path / 'qa', 'logo=20,20,120,120', 'sig=280,440,440,540', cwd=tmp_path)
    spec = spec_for(tmp_path)
    spec['blocks'][0]['logo_caption'] = ['বাংলাদেশ', 'বিশ্ববিদ্যালয় মঞ্জুরী কমিশন']
    (tmp_path / 'spec.json').write_text(json.dumps(spec, ensure_ascii=False), encoding='utf-8')

    result = run('letter.py', 'spec.json', 'order.docx', '--source', scan, cwd=tmp_path)

    assert result.returncode == 0, result.stdout + result.stderr
    table = Document(str(tmp_path / 'order.docx')).tables[0]
    logo_cell = table.rows[0].cells[0].text
    assert 'বিশ্ববিদ্যালয় মঞ্জুরী কমিশন' in logo_cell
    assert 'বাংলাদেশ বিশ্ববিদ্যালয় মঞ্জুরী কমিশন' in table.rows[0].cells[1].text
