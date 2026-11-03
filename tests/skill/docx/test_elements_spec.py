"""elements_spec turns read_document's output into a letter.py spec, and the table block builds."""

import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[3] / "skill" / "docx" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from elements_spec import convert, memo_warnings, table_rows  # noqa: E402


def el(kind, text="", **metadata):
    return {"type": kind, "text": text, "metadata": {"page_number": 1, **metadata}}


ORDER = [
    el("Image"),
    el("Title", "বাংলাদেশ বিশ্ববিদ্যালয় মঞ্জুরী কমিশন"),
    el("Header", "আগারগাঁও, শেরে বাংলা নগর, ঢাকা-১২০৭"),
    el("NarrativeText", "স্মারক নং- ৩৭.০০.০০০০.০৭১ তারিখ : ০১ আশ্বিন ১৪৩৩"),
    el("NarrativeText", "১৬ সেপ্টেম্বর ২০২৬"),
    el("Title", "অফিস আদেশ"),
    el("NarrativeText", "বিশ্ববিদ্যালয়ের কর্মকর্তাদের প্রশিক্ষণে অংশগ্রহণের জন্য অনুমতি প্রদান করা হলো। " * 2),
    el("NarrativeText", "কর্তৃপক্ষের অনুমোদনক্রমে,"),
    el("Image"),
    el("NarrativeText", "তাহমিনা রহমান"),
    el("NarrativeText", "যুগ্মসচিব"),
    el("Title", "সদয় অবগতি ও প্রয়োজনীয় কার্যার্থে অনুলিপি"),
    el("ListItem", "১। সচিব, ইউজিসি, ঢাকা।"),
    el("ListItem", "২-১২। পরিচালক, সকল বিভাগ।"),
    el("PageNumber", "১"),
]


def test_office_order_becomes_the_letter_blocks_in_order():
    spec, crops = convert(ORDER)
    assert [b["type"] for b in spec["blocks"]] == [
        "letterhead", "memo", "title", "paragraph", "signature", "heading", "list",
    ]
    head, memo, title, _, signature, _, copies = spec["blocks"]
    assert [line["text"] for line in head["lines"]] == [ORDER[1]["text"], ORDER[2]["text"]]
    assert head["logo"] == "/mnt/data/qa/logo.png"
    assert memo["left"] == "স্মারক নং- ৩৭.০০.০০০০.০৭১"
    assert memo["right"] == ["তারিখ : ০১ আশ্বিন ১৪৩৩", "১৬ সেপ্টেম্বর ২০২৬"]
    assert title["text"] == "অফিস আদেশ"
    assert signature["intro"] == "কর্তৃপক্ষের অনুমোদনক্রমে,"
    assert signature["lines"] == ["তাহমিনা রহমান", "যুগ্মসচিব"]
    assert copies["items"] == [["১।", "সচিব, ইউজিসি, ঢাকা।"], ["২-১২।", "পরিচালক, সকল বিভাগ।"]]
    assert [crop["name"] for crop in crops] == ["logo", "sig1"]


def test_no_word_is_lost():
    spec, _ = convert(ORDER)
    dump = str(spec)
    for element in ORDER:
        if element["type"] != "PageNumber":
            for word in element["text"].split():
                assert word.rstrip("।") in dump


def test_positions_become_crop_boxes_in_scan_pixels():
    picture = el("Image", coordinates={
        "points": [[100, 50], [100, 150], [300, 150], [300, 50]],
        "layout_width": 1000, "layout_height": 2000,
    })
    _, crops = convert([picture, el("Title", "শিরোনাম"), el("NarrativeText", "বিষয়: " * 40)], (2000, 4000))
    assert crops == [{"name": "logo", "box": [200, 100, 600, 300], "page": 1}]


def test_a_picture_without_position_asks_for_a_box():
    _, crops = convert([el("Image"), el("Title", "শিরোনাম"), el("NarrativeText", "x" * 200)])
    assert crops == [{"name": "logo", "box": None, "page": 1}]


def test_a_document_with_no_letterhead_keeps_its_title():
    spec, _ = convert([el("Title", "Annual Report"), el("NarrativeText", "Body text. " * 20)])
    assert [b["type"] for b in spec["blocks"]] == ["title", "paragraph"]


def test_table_html_keeps_spans_and_headers():
    html = "<table><tr><th colspan='2'>খাত</th></tr><tr><td rowspan='2'>ক</td><td>১</td></tr><tr><td>২</td></tr></table>"
    rows = table_rows(html)
    assert rows[0][0] == {"text": "খাত", "rowspan": 1, "colspan": 2, "header": True}
    assert rows[1][0]["rowspan"] == 2
    assert [cell["text"] for cell in rows[2]] == ["২"]


def test_pages_and_running_heads():
    second = {"type": "Header", "text": "গোপনীয়", "metadata": {"page_number": 2}}
    first = el("Header", "গোপনীয়")
    spec, _ = convert([el("Title", "T"), el("NarrativeText", "x" * 200), first, second])
    assert spec["pages"] == 2
    assert sum(block.get("text") == "গোপনীয়" for block in spec["blocks"]) == 1


def box(x0, y0, x1, y1):
    return {"coordinates": {
        "points": [[x0, y0], [x0, y1], [x1, y1], [x1, y0]],
        "system": "PixelSpace", "layout_width": 2000, "layout_height": 3000,
    }}


# The shape Parse with the best profile returned for a real notice: letterhead as one paragraph,
# a whole list in one item, a signature merged with a date, a line returned twice, a speck.
NOTICE = [
    el("Image", **box(200, 60, 230, 90)),
    el("Image", "(১৫৭)", **box(500, 50, 800, 310)),
    el("NarrativeText", "ছাত্রকল্যাণ অধিদপ্তর\nএকটি বিশ্ববিদ্যালয়\nফোন : ০৩১-২৫১", **box(520, 150, 1460, 340)),
    el("NarrativeText", "স্মারক নং-বি/০৩৬৮", **box(300, 370, 740, 410)),
    el("NarrativeText", "তারিখঃ ০১/০৪/২০২৬ খ্রিঃ।", **box(1370, 370, 1680, 410)),
    el("Title", ":বিজ্ঞপ্তি:", **box(930, 430, 1080, 490)),
    el("Title", "প্রবন্ধ প্রতিযোগিতা ২০২৬", **box(380, 500, 1620, 550)),
    el("NarrativeText", ("অবগতির জন্য জানানো যাচ্ছে যে প্রতিযোগিতার আয়োজন করা হয়েছে এবং সকলে অংশ নিতে পারবেন আগামী মাসে\n"
                         "স্মারক নং ৪০.০১.০০০০ মূলে এই আয়োজন।"), **box(300, 580, 1700, 790)),
    el("Table", "x", text_as_html="<table><tr><th>নাম</th><th>পুরস্কার</th></tr><tr><td>ক</td><td>১. প্রথম নগদ ২. দ্বিতীয় নগদ</td></tr></table>", **box(310, 870, 1690, 1120)),
    el("Title", "শর্তাবলীঃ", **box(300, 1170, 410, 1220)),
    el("ListItem", "১। প্রথম শর্ত এখানে লেখা আছে এবং এটি দীর্ঘ একটি বাক্য যা পরের লাইনে চলে গিয়েছে নিশ্চিতভাবে\nপরের লাইন।\n২। দ্বিতীয় শর্ত।", **box(300, 1230, 1700, 1800)),
    el("NarrativeText", "(ড. মোঃ করিম)\nপরিচালক\nচুয়েট।\nতারিখঃ ০১/০৪/২০২৬ খ্রিঃ।", **box(1310, 1780, 1800, 2120)),
    el("NarrativeText", "স্মারক নং-বি/০০৬৮(০৮)", **box(290, 2080, 800, 2130)),
    el("NarrativeText", "স্মারক নং-বি/ ০০৬৮(০৮)\nঅনুলিপি প্রেরিত হইলঃ\n১। পরিচালক।\n২। সংরক্ষণ নথি।", **box(260, 2110, 1490, 2510)),
    el("NarrativeText", "০২/০৪/২৬\n(মোঃ রহিম)\nসেকশন অফিসার", **box(1300, 2490, 1850, 2660)),
    el("Footer", "C:\\Users\\a.docx", **box(330, 2830, 1300, 2900)),
]


def test_real_parse_shape_becomes_the_letter_blocks():
    spec, crops = convert(NOTICE, (2000, 3000))
    kinds = [b["type"] for b in spec["blocks"]]
    assert kinds == [
        "letterhead", "memo", "title", "heading", "paragraph", "table", "heading", "list",
        "signature", "memo", "paragraph", "list", "signature", "paragraph",
    ]
    head, first_memo = spec["blocks"][0], spec["blocks"][1]
    assert [line["text"] for line in head["lines"]] == ["ছাত্রকল্যাণ অধিদপ্তর", "একটি বিশ্ববিদ্যালয়", "ফোন : ০৩১-২৫১"]
    assert first_memo["left"] == "স্মারক নং-বি/০৩৬৮"
    assert first_memo["right"] == ["তারিখঃ ০১/০৪/২০২৬ খ্রিঃ।"]
    assert spec["blocks"][3]["align"] == "center"
    assert "স্মারক নং ৪০.০১.০০০০ মূলে" in spec["blocks"][4]["text"]
    assert spec["blocks"][5]["rows"][1][1]["text"] == "১. প্রথম নগদ\n২. দ্বিতীয় নগদ"
    conditions = spec["blocks"][7]["items"]
    assert [item[0] for item in conditions] == ["১।", "২।"]
    assert conditions[0][1].endswith("নিশ্চিতভাবে পরের লাইন।")
    signature = spec["blocks"][8]
    assert signature["lines"] == ["(ড. মোঃ করিম)", "পরিচালক", "চুয়েট।"]
    assert signature["image"].endswith("sig1.png")
    second_memo = spec["blocks"][9]
    assert second_memo["left"] == "স্মারক নং-বি/০০৬৮(০৮)"
    assert second_memo["right"] == ["তারিখঃ ০১/০৪/২০২৬ খ্রিঃ।"]
    assert str(spec).count("০০৬৮(০৮)") == 1
    assert spec["blocks"][12]["lines"] == ["(মোঃ রহিম)", "সেকশন অফিসার"]
    assert [crop["name"] for crop in crops] == ["logo", "sig1", "sig2"]
    assert crops[0]["box"] == [500, 50, 800, 310]
    # The signature's box stops above its printed lines: 4 lines of the page's 40-60px line height.
    assert crops[1]["box"][:3] == [1310, 1780, 1800]
    assert 1780 < crops[1]["box"][3] < 2000
    assert crops[2]["box"][1] == 2490 and crops[2]["box"][3] < 2660


def test_a_cut_off_second_read_of_the_date_is_dropped():
    elements = [
        {"type": "NarrativeText", "text": "স্মারক নং-চুয়েট/ছাক/২০২৬/০০৬৮ তারিখঃ ০১/০৪/২০২৬ খ্রিঃ।", "metadata": {"page_number": 1}},
        {"type": "NarrativeText", "text": "তারিখঃ ০১/০", "metadata": {"page_number": 1}},
    ]
    spec, _ = convert(elements)
    memo = next(block for block in spec["blocks"] if block["type"] == "memo")
    assert memo["right"] == ["তারিখঃ ০১/০৪/২০২৬ খ্রিঃ।"]


def test_mostly_short_lines_stay_apart_and_a_heading_is_not_repeated():
    long_line = "ফোন : ০৩১-২৫১৬৩০২, পিবিএক্স : ০৩১-৭১৪৯২০-২২এর (৮৫০০), Email: dsw@cuet.example.bd এবং আরও"
    spec, _ = convert([
        el("NarrativeText", f"অধিদপ্তর\nবিশ্ববিদ্যালয়\nশহর\n{long_line}"),
        el("NarrativeText", "স্মারক ১"),
        el("Title", "শর্তাবলীঃ"),
        el("ListItem", "শর্তাবলীঃ\n১। প্রথম শর্ত।\n২। দ্বিতীয় শর্ত।"),
    ])
    assert [line["text"] for line in spec["blocks"][0]["lines"]][-1] == long_line
    assert len(spec["blocks"][0]["lines"]) == 4
    assert str(spec).count("শর্তাবলীঃ") == 1


def test_a_real_repeat_elsewhere_on_the_page_is_kept():
    spec, _ = convert([
        el("NarrativeText", "স্মারক ১", **box(100, 100, 400, 140)),
        el("NarrativeText", "তারিখঃ ১", **box(1400, 100, 1700, 140)),
        el("NarrativeText", "নাম\nতারিখঃ ১", **box(1300, 2000, 1800, 2200)),
    ])
    assert str(spec).count("তারিখঃ ১") == 2


@pytest.fixture
def letter():
    pytest.importorskip("docx")
    import letter as module

    return module


def test_table_block_builds_with_merged_cells(letter, tmp_path):
    from docx import Document

    spec = {"blocks": [{"type": "table", "rows": table_rows(
        "<table><tr><th colspan='2'>খাত</th></tr><tr><td rowspan='2'>ক</td><td>১</td></tr><tr><td>২</td></tr></table>"
    )}]}
    out = tmp_path / "t.docx"
    letter.build(spec, out, letter.Style(spec))
    table = Document(str(out)).tables[0]
    assert (len(table.rows), len(table.columns)) == (3, 2)
    assert table.cell(0, 0).text == table.cell(0, 1).text == "খাত"
    assert table.cell(1, 0).text == table.cell(2, 0).text == "ক"
    assert table.cell(2, 1).text == "২"
    assert table.cell(0, 0).paragraphs[0].runs[0].font.bold is True


def test_tight_style_sets_the_leading_from_the_type_size(letter, tmp_path):
    from docx import Document
    from docx.enum.text import WD_LINE_SPACING

    spec = {"font": {"size": 10}, "blocks": [{"type": "paragraph", "text": "বিজ্ঞপ্তি"}]}
    out = tmp_path / "t.docx"
    letter.build(spec, out, letter.Style(spec, tight=True))
    fmt = Document(str(out)).paragraphs[0].paragraph_format
    assert fmt.line_spacing_rule == WD_LINE_SPACING.EXACTLY
    assert fmt.line_spacing.pt == pytest.approx(12.5)


def test_memo_numbers_that_disagree_are_reported():
    spec, _ = convert(NOTICE, (2000, 3000))
    warnings = memo_warnings(spec)
    assert len(warnings) == 1 and "০৩৬৮" in warnings[0] and "০০৬৮" in warnings[0]


def test_memo_numbers_that_agree_are_not_reported():
    blocks = [{"type": "memo", "left": "স্মারক/০০৬৮"}, {"type": "memo", "left": "স্মারক/ ০০৬৮(০৮)"}]
    assert memo_warnings({"blocks": blocks}) == []


def test_side_margins_come_from_the_page():
    spec, _ = convert([el("NarrativeText", "x" * 200, **box(300, 100, 1700, 300))])
    top, right, bottom, left = spec["page"]["margins_cm"]
    assert (left, right) == (3.15, 3.15)
    assert top == 1.0
    assert bottom == 2.0


def test_table_columns_are_measured_from_the_scan_and_pictures_keep_their_size(tmp_path):
    pytest.importorskip("PIL")
    from PIL import Image, ImageDraw

    import scan_to_docx

    page = Image.new("RGB", (1000, 1000), "white")
    draw = ImageDraw.Draw(page)
    for x in (100, 400, 900):
        draw.line([(x, 200), (x, 500)], fill="black", width=2)
    assert scan_to_docx.table_widths(page, (100, 200, 900, 500), 2, 0.02) == [6.0, 10.0]
    assert scan_to_docx.table_widths(page, (100, 200, 900, 500), 3, 0.02) is None

    Image.new("RGB", (100, 50), "white").save(tmp_path / "logo.png")
    spec = {"blocks": [
        {"type": "letterhead", "logo": str(tmp_path / "logo.png")},
        {"type": "signature", "image": str(tmp_path / "sig1.png"), "lines": ["নাম"]},
        {"type": "image", "path": str(tmp_path / "image3.png")},
    ]}
    missing = scan_to_docx.place_pictures(spec, {"logo"}, tmp_path, 0.02)
    assert spec["blocks"][0]["logo_width_cm"] == 2.0
    assert "image" not in spec["blocks"][1]
    assert [b["type"] for b in spec["blocks"]] == ["letterhead", "signature"]
    assert set(missing) == {"sig1", "image3"}


def test_blocks_take_their_spacing_indent_and_alignment_from_the_page():
    elements = [
        el("Title", "শিরোনাম", **box(850, 100, 1150, 200)),
        el("NarrativeText", "প্রথম অনুচ্ছেদ। " * 12, **box(300, 400, 1700, 450)),
        el("NarrativeText", "ডানে সরানো অনুচ্ছেদ। " * 12, **box(500, 650, 1700, 700)),
    ]
    spec, _ = convert(elements)
    title, first, second = spec["blocks"]
    assert first.get("align") != "center"
    assert title["align"] == "center"
    assert title["size"] > 10.5
    # 200 px at 2000 px wide is 2.1 cm of page, about 59.5 pt.
    assert first["space_before"] == pytest.approx(59.5, abs=0.5)
    assert "left_indent_cm" not in first
    assert second["left_indent_cm"] == pytest.approx(2.1)
    assert all(block["space_after"] == 0 for block in spec["blocks"])
    assert not any(key.startswith("_") for block in spec["blocks"] for key in block)


def test_signature_and_date_sit_where_the_page_has_them():
    spec, _ = convert([
        el("Title", "ক", **box(300, 100, 600, 150)),
        el("NarrativeText", "স্মারক ১", **box(300, 300, 700, 340)),
        el("NarrativeText", "তারিখঃ ১", **box(1300, 300, 1700, 340)),
        el("NarrativeText", "অনুচ্ছেদ " * 40, **box(300, 400, 1700, 900)),
        el("NarrativeText", "(নাম)\nপদবি", **box(1200, 1000, 1700, 1300)),
    ])
    memo = next(b for b in spec["blocks"] if b["type"] == "memo")
    signature = next(b for b in spec["blocks"] if b["type"] == "signature")
    assert memo["right_width_cm"] == pytest.approx(4.2, abs=0.1)
    assert signature["left_cm"] == pytest.approx(9.45, abs=0.1)
    assert signature["width_cm"] == pytest.approx(5.25, abs=0.1)


def test_a_loose_logo_box_keeps_only_the_logo(tmp_path):
    pytest.importorskip("PIL")
    from PIL import Image, ImageDraw

    import scan_to_docx

    page = Image.new("RGB", (300, 200), "white")
    draw = ImageDraw.Draw(page)
    draw.ellipse([10, 40, 130, 160], outline="black", width=8)
    draw.line([(10, 100), (130, 100)], fill="black", width=8)
    draw.text((220, 20), "note", fill="black")
    path = tmp_path / "logo.png"
    page.save(path)
    scan_to_docx.keep_largest_shape(path)
    with Image.open(path) as kept:
        assert kept.width < 150 and kept.height < 150


def test_a_skewed_table_rule_is_still_found():
    pytest.importorskip("PIL")
    from PIL import Image, ImageDraw

    import scan_to_docx

    page = Image.new("RGB", (1000, 1000), "white")
    draw = ImageDraw.Draw(page)
    for x in (100, 400, 900):
        draw.line([(x, 200), (x + 4, 500)], fill="black", width=2)
    assert scan_to_docx.table_widths(page, (100, 200, 900, 500), 2, 0.02) == [6.0, 10.0]


def test_list_indent_adds_to_the_hanging_number(letter, tmp_path):
    from docx import Document

    spec = {"blocks": [{"type": "list", "hanging_cm": 0.7, "left_indent_cm": 1, "items": [["১।", "শর্ত"]]}]}
    out = tmp_path / "t.docx"
    letter.build(spec, out, letter.Style(spec))
    assert Document(str(out)).paragraphs[0].paragraph_format.left_indent.cm == pytest.approx(1.7, abs=0.01)
