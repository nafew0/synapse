"""Tests for skill/form-filling/scripts (fields.py, fill.py, check.py).

Kept outside skill/ on purpose: every file in a deployment skill directory is uploaded into each
user's code sandbox. Fixtures are built in tmp_path. Rendering needs poppler and LibreOffice, so
those tests skip where they are missing.
"""
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pdfplumber
import pytest
from docx import Document
from docx.oxml import parse_xml
from docx.oxml.ns import nsdecls, qn
from pypdf import PdfReader
from reportlab.pdfgen import canvas

SCRIPTS = Path(__file__).resolve().parents[3] / "skill" / "form-filling" / "scripts"
NAME_BN = "ড. রহিমা খাতুন"


def run(script, *args, cwd):
    return subprocess.run(
        [sys.executable, str(SCRIPTS / script), *map(str, args)], cwd=cwd, capture_output=True, text=True, check=False
    )


def write_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return path


@pytest.fixture
def fillable_pdf(tmp_path):
    path = tmp_path / "form.pdf"
    page = canvas.Canvas(str(path), pagesize=(595, 842))
    form = page.acroForm
    page.drawString(50, 760, "Full name:")
    form.textfield(name="name", x=130, y=750, width=250, height=20, fontSize=10)
    page.drawString(50, 720, "Bangladeshi citizen:")
    form.checkbox(name="citizen", x=180, y=715, size=14)
    page.drawString(50, 680, "Category:")
    form.choice(name="category", x=130, y=670, width=150, height=20, value="Science",
                options=["Science", "Literature", ("Arts & Culture", "arts")])
    page.drawString(50, 640, "Phone:")
    form.textfield(name="phone", x=130, y=630, width=60, height=20, fontSize=10)
    page.drawString(50, 600, "Remarks:")
    form.textfield(name="remarks", x=130, y=590, width=200, height=20, fontSize=10)
    page.save()
    return path


def sdt_xml(kind):
    if kind == "text":
        return (f'<w:sdt {nsdecls("w")}><w:sdtPr><w:alias w:val="Category"/><w:showingPlcHdr/></w:sdtPr>'
                '<w:sdtContent><w:r><w:rPr><w:rStyle w:val="PlaceholderText"/></w:rPr>'
                '<w:t>Click here to enter text.</w:t></w:r></w:sdtContent></w:sdt>')
    return (f'<w:sdt {nsdecls("w")} xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">'
            '<w:sdtPr><w:tag w:val="Consent"/><w14:checkbox><w14:checked w14:val="0"/>'
            '<w14:checkedState w14:val="2612"/><w14:uncheckedState w14:val="2610"/></w14:checkbox></w:sdtPr>'
            '<w:sdtContent><w:r><w:t>☐</w:t></w:r></w:sdtContent></w:sdt>')


@pytest.fixture
def word_form(tmp_path):
    doc = Document()
    doc.add_paragraph("Ekushey Padak Nomination Form")
    table = doc.add_table(rows=4, cols=2)
    for row, label in enumerate(["Name of nominee", "Field of contribution", "Date of birth", "Address"]):
        table.cell(row, 0).text = label
    table.cell(3, 1).text = "__________"
    run = table.cell(0, 1).paragraphs[0].add_run("")
    run.font.size = 152400
    doc.add_paragraph("Nominated by: ______________   Date: ..........")
    doc.add_paragraph("☐ Individual   ☐ Organisation")
    paragraph = doc.add_paragraph("Category: ")
    paragraph._p.append(parse_xml(sdt_xml("text")))
    paragraph = doc.add_paragraph("I agree ")
    paragraph._p.append(parse_xml(sdt_xml("checkbox")))
    grid = doc.add_table(rows=3, cols=3)
    for column, header in enumerate(["SL", "Degree", "Year"]):
        grid.cell(0, column).text = header
    grid.cell(1, 0).text = "1"
    grid.cell(2, 0).text = "2"
    path = tmp_path / "form.docx"
    doc.save(path)
    return path


@pytest.fixture
def flat_pdf(tmp_path):
    path = tmp_path / "flat.pdf"
    page = canvas.Canvas(str(path), pagesize=(595, 842))
    page.drawString(50, 760, "Name of applicant: ______________________________")
    page.drawString(50, 720, "Institution:")
    page.line(130, 718, 400, 718)
    page.drawString(50, 680, "Signature")
    page.save()
    return path


def fields_of(path, tmp_path):
    out = tmp_path / "fields.json"
    result = run("fields.py", path, "--out", out, cwd=tmp_path)
    return result, json.loads(out.read_text(encoding="utf-8"))


# ---------------------------------------------------------------- fields.py


def test_fields_lists_pdf_acroform_with_labels_and_options(fillable_pdf, tmp_path):
    result, info = fields_of(fillable_pdf, tmp_path)

    assert result.returncode == 0, result.stdout
    fields = {f["id"]: f for f in info["fields"]}
    assert info["kind"] == "pdf_form"
    assert fields["name"]["type"] == "text" and fields["name"]["label"] == "Full name"
    assert fields["citizen"]["type"] == "checkbox" and fields["citizen"]["on"] == "/Yes"
    assert fields["category"]["type"] == "choice"
    assert {"value": "arts", "text": "Arts & Culture"} in fields["category"]["options"]
    assert fields["name"]["page"] == 1 and len(fields["name"]["rect"]) == 4


def test_fields_lists_word_cells_blanks_boxes_and_controls(word_form, tmp_path):
    result, info = fields_of(word_form, tmp_path)

    assert result.returncode == 0, result.stdout
    fields = {f["id"]: f for f in info["fields"]}
    assert fields["t0.r0.c1"]["label"] == "Name of nominee"
    assert fields["t0.r3.c1"]["label"] == "Address"
    assert fields["p1.b0"]["label"] == "Nominated by"
    assert fields["p1.b1"]["label"] == "Date"
    assert fields["p2.x1"]["label"] == "Organisation" and fields["p2.x1"]["value"] is False
    assert fields["t1.r1.c1"]["label"] == "Degree (row 1)"
    controls = [f for f in info["fields"] if f["kind"] == "sdt"]
    assert {(c["label"], c["type"]) for c in controls} == {("Category", "text"), ("Consent", "checkbox")}
    assert all(c["value"] in ("", False) for c in controls)
    ids = [f["id"] for f in info["fields"]]
    assert ids.index("t0.r0.c1") < ids.index("p1.b0") < ids.index("t1.r1.c1")


def test_fields_flat_pdf_exits_2_with_candidate_blanks(flat_pdf, tmp_path):
    result, info = fields_of(flat_pdf, tmp_path)

    assert result.returncode == 2
    assert "no fillable fields" in result.stdout
    labels = {b["label"]: b for b in info["blanks"]}
    assert "Name of applicant" in labels and "Institution" in labels
    assert abs(labels["Institution"]["y"] - 720) < 3


def test_fields_bad_input_exits_1(tmp_path):
    bad = tmp_path / "notes.txt"
    bad.write_text("hello")

    assert run("fields.py", bad, cwd=tmp_path).returncode == 1


# ---------------------------------------------------------------- fillable PDF round trip


def test_pdf_round_trip_fills_text_checkbox_and_choice(fillable_pdf, tmp_path):
    mapping = write_json(tmp_path / "mapping.json", {
        "fields": [
            {"id": "name", "value": "Dr. Rahima Khatun", "source": "CV.pdf p1", "required": True},
            {"id": "citizen", "value": True, "source": "NID card"},
            {"id": "category", "value": "Arts & Culture", "source": "user message"},
            {"id": "phone", "value": "", "required": True},
        ],
        "blank_reasons": {"phone": "not in any attached document"},
    })
    out = tmp_path / "filled.pdf"

    filled = run("fill.py", fillable_pdf, mapping, out, cwd=tmp_path)
    checked = run("check.py", fillable_pdf, out, mapping, cwd=tmp_path)

    assert filled.returncode == 0, filled.stdout
    assert "filled 3, blank 1" in filled.stdout
    assert checked.returncode == 0, checked.stdout
    assert checked.stdout.startswith("PASS")
    values = {k: v.get("/V") for k, v in PdfReader(str(out)).get_fields().items()}
    assert values["name"] == "Dr. Rahima Khatun"
    assert values["citizen"] == "/Yes"
    assert values["category"] == "arts"
    assert PdfReader(str(out)).trailer["/Root"]["/AcroForm"]["/NeedAppearances"]


def test_pdf_unknown_id_bad_option_and_overflow_exit_2(fillable_pdf, tmp_path):
    mapping = write_json(tmp_path / "mapping.json", {"fields": [
        {"id": "nope", "value": "x"},
        {"id": "category", "value": "Sports"},
        {"id": "phone", "value": "+880 1711 000000 extension 1234 (office)"},
    ]})
    out = tmp_path / "filled.pdf"

    filled = run("fill.py", fillable_pdf, mapping, out, cwd=tmp_path)
    checked = run("check.py", fillable_pdf, out, mapping, cwd=tmp_path)

    assert filled.returncode == 2
    assert "unknown id: nope" in filled.stdout
    assert "Sports" in filled.stdout and "overflow" in filled.stdout
    assert checked.returncode == 2
    assert "no such field" in checked.stdout and "overflow" in checked.stdout


def test_required_blank_without_reason_fails_gate(fillable_pdf, tmp_path):
    mapping = write_json(tmp_path / "mapping.json", {"fields": [
        {"id": "name", "value": "Dr. Rahima Khatun", "source": "CV"},
        {"id": "phone", "value": "", "required": True},
    ]})
    out = tmp_path / "filled.pdf"
    run("fill.py", fillable_pdf, mapping, out, cwd=tmp_path)

    checked = run("check.py", fillable_pdf, out, mapping, cwd=tmp_path)

    assert checked.returncode == 2
    assert "phone: required but blank" in checked.stdout


def test_gate_catches_a_value_missing_from_the_output(fillable_pdf, tmp_path):
    mapping = write_json(tmp_path / "mapping.json", {"fields": [{"id": "name", "value": "Dr. Rahima Khatun"}]})

    checked = run("check.py", fillable_pdf, fillable_pdf, mapping, cwd=tmp_path)

    assert checked.returncode == 2
    assert "expected 'Dr. Rahima Khatun'" in checked.stdout


# ---------------------------------------------------------------- Word round trip


def word_mapping(tmp_path, **extra):
    data = {
        "fields": [
            {"id": "t0.r0.c1", "value": NAME_BN, "source": "CV.pdf p1", "required": True},
            {"id": "t0.r1.c1", "value": "Literature", "source": "user message"},
            {"id": "t0.r2.c1", "value": "", "required": True},
            {"id": "t0.r3.c1", "value": "Dhaka\nBangladesh", "source": "CV.pdf p1"},
            {"id": "p1.b0", "value": "Bangla Academy", "source": "user message"},
            {"id": "p1.b1", "value": "01/10/2026", "source": "user message"},
            {"id": "p2.x1", "value": True, "source": "user message"},
            {"id": "t1.r1.c1", "value": "PhD", "source": "certificate.pdf"},
        ],
        "blank_reasons": {"t0.r2.c1": "not in any attached document"},
    }
    data.update(extra)
    return write_json(tmp_path / "mapping.json", data)


def test_word_round_trip(word_form, tmp_path):
    _, info = fields_of(word_form, tmp_path)
    controls = {f["label"]: f["id"] for f in info["fields"] if f["kind"] == "sdt"}
    mapping = word_mapping(tmp_path)
    data = json.loads(mapping.read_text(encoding="utf-8"))
    data["fields"] += [{"id": controls["Category"], "value": "Literature"},
                       {"id": controls["Consent"], "value": True}]
    write_json(mapping, data)
    out = tmp_path / "filled.docx"

    filled = run("fill.py", word_form, mapping, out, cwd=tmp_path)
    checked = run("check.py", word_form, out, mapping, cwd=tmp_path)

    assert filled.returncode == 0, filled.stdout
    assert checked.returncode == 0, checked.stdout
    doc = Document(str(out))
    texts = ["".join(t.text for t in p._p.iter(qn("w:t"))) for p in doc.paragraphs]
    assert texts[1] == "Nominated by: Bangla Academy   Date: 01/10/2026"
    assert texts[2] == "☐ Individual   ☒ Organisation"
    assert "Click here" not in texts[3] and texts[3].endswith("Literature")
    assert texts[4] == "I agree ☒"
    assert not list(doc.element.body.iter(qn("w:showingPlcHdr")))
    assert doc.tables[0].cell(0, 1).text == NAME_BN
    assert doc.tables[0].cell(3, 1).text == "Dhaka\nBangladesh"
    assert doc.tables[0].cell(2, 1).text == ""
    assert doc.tables[1].cell(1, 1).text == "PhD"


def test_bangla_value_lands_in_complex_script_font_slot(word_form, tmp_path):
    out = tmp_path / "filled.docx"

    filled = run("fill.py", word_form, word_mapping(tmp_path, bangla_font="SolaimanLipi"), out, cwd=tmp_path)

    assert filled.returncode == 0, filled.stdout
    cell = Document(str(out)).tables[0].cell(0, 1)
    run_el = next(r for r in cell._tc.iter(qn("w:r")) if NAME_BN in "".join(t.text for t in r.iter(qn("w:t"))))
    r_pr = run_el.find(qn("w:rPr"))
    assert r_pr.find(qn("w:rFonts")).get(qn("w:cs")) == "SolaimanLipi"
    assert r_pr.find(qn("w:lang")).get(qn("w:bidi")) == "bn-BD"
    assert r_pr.find(qn("w:szCs")).get(qn("w:val")) == r_pr.find(qn("w:sz")).get(qn("w:val"))


def test_gate_fails_bangla_without_cs_font(word_form, tmp_path):
    mapping = word_mapping(tmp_path)
    out = tmp_path / "filled.docx"
    run("fill.py", word_form, mapping, out, cwd=tmp_path)
    doc = Document(str(out))
    for fonts in doc.tables[0].cell(0, 1)._tc.iter(qn("w:rFonts")):
        del fonts.attrib[qn("w:cs")]
    doc.save(str(out))

    checked = run("check.py", word_form, out, mapping, cwd=tmp_path)

    assert checked.returncode == 2
    assert "complex-script" in checked.stdout


def test_word_unknown_id_and_required_blank_reported(word_form, tmp_path):
    mapping = word_mapping(tmp_path, blank_reasons={})
    data = json.loads(mapping.read_text(encoding="utf-8"))
    data["fields"].append({"id": "t9.r0.c0", "value": "x"})
    write_json(mapping, data)
    out = tmp_path / "filled.docx"

    filled = run("fill.py", word_form, mapping, out, cwd=tmp_path)
    checked = run("check.py", word_form, out, mapping, cwd=tmp_path)

    assert filled.returncode == 2
    assert "unknown id: t9.r0.c0" in filled.stdout
    assert "t0.r2.c1: no reason given" in filled.stdout
    assert checked.returncode == 2
    assert "t0.r2.c1: required but blank" in checked.stdout
    assert "t9.r0.c0: no such field" in checked.stdout


def test_fill_refuses_to_overwrite_the_original(word_form, tmp_path):
    result = run("fill.py", word_form, word_mapping(tmp_path), word_form, cwd=tmp_path)

    assert result.returncode == 1


# ---------------------------------------------------------------- flat PDF overlay


def test_overlay_fills_and_gate_catches_text_over_a_label(flat_pdf, tmp_path):
    mapping = write_json(tmp_path / "mapping.json", {"fields": [
        {"id": "name", "value": "Dr. Rahima Khatun", "page": 1, "x": 160, "y": 762, "size": 10, "width": 230},
        {"id": "institution", "value": "University of Dhaka", "page": 1, "x": 132, "y": 720},
        {"id": "signature", "value": "", "required": True},
    ], "blank_reasons": {"signature": "must be signed by hand"}})
    out = tmp_path / "filled.pdf"

    filled = run("fill.py", flat_pdf, mapping, out, cwd=tmp_path)
    checked = run("check.py", flat_pdf, out, mapping, cwd=tmp_path)

    assert filled.returncode == 0, filled.stdout
    assert checked.returncode == 0, checked.stdout
    assert "University of Dhaka" in PdfReader(str(out)).pages[0].extract_text()

    data = json.loads(mapping.read_text(encoding="utf-8"))
    data["fields"].append({"id": "misplaced", "value": "Over the label", "page": 1, "x": 50, "y": 680})
    write_json(mapping, data)
    run("fill.py", flat_pdf, mapping, out, cwd=tmp_path)
    checked = run("check.py", flat_pdf, out, mapping, cwd=tmp_path)

    assert checked.returncode == 2
    assert "printed word 'Signature'" in checked.stdout


def test_overlay_pixel_units_and_overflow(flat_pdf, tmp_path):
    mapping = write_json(tmp_path / "mapping.json", {"units": "px", "dpi": 100, "fields": [
        {"id": "name", "value": "word " * 60, "page": 1, "x": 222, "y": 113, "width": 300, "height": 20},
    ]})
    out = tmp_path / "filled.pdf"

    filled = run("fill.py", flat_pdf, mapping, out, cwd=tmp_path)

    assert filled.returncode == 2
    assert "overflow" in filled.stdout


# ---------------------------------------------------------------- render


@pytest.mark.skipif(not shutil.which("pdftoppm"), reason="needs poppler")
def test_render_writes_page_image_for_pdf(fillable_pdf, tmp_path):
    mapping = write_json(tmp_path / "mapping.json", {"fields": [{"id": "name", "value": "Dr. Rahima Khatun"}]})
    out = tmp_path / "filled.pdf"
    run("fill.py", fillable_pdf, mapping, out, cwd=tmp_path)

    checked = run("check.py", fillable_pdf, out, mapping, "--render", tmp_path / "qa", cwd=tmp_path)

    assert checked.returncode == 0, checked.stdout
    assert list((tmp_path / "qa").glob("*.png"))


@pytest.mark.skipif(not (shutil.which("pdftoppm") and shutil.which("soffice")), reason="needs poppler and LibreOffice")
def test_render_writes_page_image_for_word(word_form, tmp_path):
    out = tmp_path / "filled.docx"
    mapping = word_mapping(tmp_path)
    run("fill.py", word_form, mapping, out, cwd=tmp_path)

    checked = run("check.py", word_form, out, mapping, "--render", tmp_path / "qa", cwd=tmp_path)

    assert checked.returncode == 0, checked.stdout
    assert list((tmp_path / "qa").glob("*.png"))


def test_render_skips_gracefully_without_tools(fillable_pdf, tmp_path, monkeypatch):
    mapping = write_json(tmp_path / "mapping.json", {"fields": [{"id": "name", "value": "Dr. Rahima Khatun"}]})
    out = tmp_path / "filled.pdf"
    run("fill.py", fillable_pdf, mapping, out, cwd=tmp_path)
    (tmp_path / "empty").mkdir()
    monkeypatch.setenv("PATH", str(tmp_path / "empty"))

    checked = run("check.py", fillable_pdf, out, mapping, "--render", tmp_path / "qa", cwd=tmp_path)

    assert checked.returncode == 0, checked.stdout
    assert "render skipped" in checked.stdout


# ---------------------------------------------------------------- updating a filled Word form


def formatted_cell(cell, *runs):
    paragraph = cell.paragraphs[0]
    for text, size, bold in runs:
        added = paragraph.add_run(text)
        added.font.size = size
        added.bold = bold
        added.font.name = "Georgia"


def filled_sdt_xml(alias, value):
    return (f'<w:sdt {nsdecls("w")}><w:sdtPr><w:alias w:val="{alias}"/></w:sdtPr><w:sdtContent>'
            f'<w:r><w:rPr><w:b/></w:rPr><w:t>{value[:2]}</w:t></w:r><w:r><w:t>{value[2:]}</w:t></w:r>'
            '</w:sdtContent></w:sdt>')


@pytest.fixture
def filled_word(tmp_path):
    doc = Document()
    table = doc.add_table(rows=4, cols=2)
    for row, label in enumerate(["Name", "Department", "Phone", "Date of birth"]):
        table.cell(row, 0).text = label
    formatted_cell(table.cell(0, 1), ("Rahima", 177800, True), (" Khatun", 127000, False))
    table.cell(1, 1).text = "Physics"
    table.cell(2, 1).text = "01711"
    doc.add_paragraph("Institution: University of Dhaka")
    doc.add_paragraph("Signed by: ____________")
    doc.add_paragraph("☒ Individual   ☐ Organisation")
    control = doc.add_paragraph("Category: ")
    control._p.append(parse_xml(filled_sdt_xml("Category", "Literature")))
    grid = doc.add_table(rows=3, cols=3)
    for column, header in enumerate(["SL", "Degree", "Year"]):
        grid.cell(0, column).text = header
    for column, text in enumerate(["1", "PhD", "1999"]):
        grid.cell(1, column).text = text
    grid.cell(2, 0).text = "2"
    path = tmp_path / "filled-form.docx"
    doc.save(path)
    return path


def include_filled(path, tmp_path):
    out = tmp_path / "all.json"
    result = run("fields.py", path, "--include-filled", "--out", out, cwd=tmp_path)
    return result, {f["id"]: f for f in json.loads(out.read_text(encoding="utf-8"))["fields"]}


def update_word(form, tmp_path, entries):
    mapping = write_json(tmp_path / "update.json", {"fields": entries})
    out = tmp_path / "updated.docx"
    filled = run("fill.py", form, mapping, out, cwd=tmp_path)
    assert filled.returncode == 0, filled.stdout
    return out, mapping, run("check.py", form, out, mapping, cwd=tmp_path)


def test_include_filled_lists_values_with_labels(filled_word, tmp_path):
    result, fields = include_filled(filled_word, tmp_path)

    assert result.returncode == 0, result.stdout
    assert (fields["t0.r0.c1"]["label"], fields["t0.r0.c1"]["value"]) == ("Name", "Rahima Khatun")
    assert (fields["t1.r1.c1"]["label"], fields["t1.r1.c1"]["value"]) == ("Degree (row 1)", "PhD")
    assert (fields["t1.r1.c2"]["label"], fields["t1.r1.c2"]["value"]) == ("Year (row 1)", "1999")
    assert (fields["p0.v0"]["label"], fields["p0.v0"]["value"]) == ("Institution", "University of Dhaka")
    assert fields["p2.x0"]["value"] is True
    assert next(f for f in fields.values() if f["kind"] == "sdt")["value"] == "Literature"
    assert "t0.r0.c0" not in fields and "t1.r0.c1" not in fields and "t1.r1.c0" not in fields


def test_empty_field_ids_are_the_same_with_and_without_the_flag(filled_word, word_form, tmp_path):
    for form in (filled_word, word_form):
        _, plain = fields_of(form, tmp_path)
        _, flagged = include_filled(form, tmp_path)
        plain_ids = {f["id"]: f["kind"] for f in plain["fields"]}
        assert plain_ids.items() <= {k: v["kind"] for k, v in flagged.items()}.items()


def test_without_the_flag_a_filled_cell_is_not_listed(filled_word, tmp_path):
    _, info = fields_of(filled_word, tmp_path)

    ids = {f["id"] for f in info["fields"]}
    assert "t0.r0.c1" not in ids and "p0.v0" not in ids and "t0.r3.c1" in ids


def test_update_multi_run_cell_keeps_first_run_format_and_unmapped_cells(filled_word, tmp_path):
    out, _, checked = update_word(filled_word, tmp_path, [
        {"id": "t0.r0.c1", "label": "Name", "value": "Salma Begum", "source": "user message"}])

    assert checked.returncode == 0, checked.stdout
    assert "Name: Rahima Khatun → Salma Begum" in checked.stdout
    doc = Document(str(out))
    cell = doc.tables[0].cell(0, 1)
    assert cell.text == "Salma Begum"
    only = cell.paragraphs[0].runs
    assert len(only) == 1 and only[0].bold and only[0].font.size == 177800 and only[0].font.name == "Georgia"
    assert doc.tables[0].cell(1, 1).text == "Physics" and doc.tables[0].cell(2, 1).text == "01711"
    assert doc.tables[1].cell(1, 2).text == "1999"


def test_update_filled_cell_with_bangla_uses_complex_script_slot(filled_word, tmp_path):
    out, _, checked = update_word(filled_word, tmp_path, [{"id": "t0.r1.c1", "value": NAME_BN, "source": "user"}])

    assert checked.returncode == 0, checked.stdout
    run_el = next(Document(str(out)).tables[0].cell(1, 1)._tc.iter(qn("w:r")))
    assert run_el.find(f"{qn('w:rPr')}/{qn('w:rFonts')}").get(qn("w:cs")) == "Nikosh"


def test_update_filled_control_keeps_first_run_format(filled_word, tmp_path):
    _, fields = include_filled(filled_word, tmp_path)
    sdt_id = next(k for k, f in fields.items() if f["kind"] == "sdt")

    out, _, checked = update_word(filled_word, tmp_path, [{"id": sdt_id, "value": "Science", "source": "user"}])

    assert checked.returncode == 0, checked.stdout
    assert "Category: Literature → Science" in checked.stdout
    sdt = next(Document(str(out)).element.body.iter(qn("w:sdt")))
    runs = list(sdt.iter(qn("w:r")))
    assert len(runs) == 1 and runs[0].find(f"{qn('w:rPr')}/{qn('w:b')}") is not None
    assert "".join(t.text for t in sdt.iter(qn("w:t"))) == "Science"


def test_update_ticked_box(filled_word, tmp_path):
    out, _, checked = update_word(filled_word, tmp_path, [
        {"id": "p2.x0", "value": False, "source": "user"}, {"id": "p2.x1", "value": True, "source": "user"}])

    assert checked.returncode == 0, checked.stdout
    assert Document(str(out)).paragraphs[2].text == "☐ Individual   ☒ Organisation"
    assert "ticked → not ticked" in checked.stdout


def test_update_label_value_paragraph_across_runs(tmp_path):
    doc = Document()
    paragraph = doc.add_paragraph()
    label = paragraph.add_run("Institution: ")
    label.bold = True
    first = paragraph.add_run("University")
    first.italic = True
    paragraph.add_run(" of Dhaka")
    doc.add_paragraph("Time: 12:30")
    form = tmp_path / "para.docx"
    doc.save(form)
    _, fields = include_filled(form, tmp_path)
    assert fields["p0.v0"]["value"] == "University of Dhaka" and fields["p1.v0"]["value"] == "12:30"

    out, _, checked = update_word(form, tmp_path, [{"id": "p0.v0", "label": "Institution", "value": "BUET", "source": "user"}])

    assert checked.returncode == 0, checked.stdout
    runs = Document(str(out)).paragraphs[0].runs
    assert Document(str(out)).paragraphs[0].text == "Institution: BUET"
    assert runs[0].bold and runs[1].text == "BUET" and runs[1].italic


def test_fill_and_update_mixed_in_one_paragraph_and_mapping(tmp_path):
    doc = Document()
    doc.add_paragraph("Name: ________   Dept: Physics   Room: 12")
    table = doc.add_table(rows=2, cols=2)
    table.cell(0, 0).text = "Phone"
    table.cell(1, 0).text = "Email"
    table.cell(1, 1).text = "old@example.org"
    form = tmp_path / "mixed.docx"
    doc.save(form)

    out, _, checked = update_word(form, tmp_path, [
        {"id": "p0.b0", "value": "Rahima", "source": "user"},
        {"id": "p0.v0", "value": "Chemistry", "source": "user"},
        {"id": "t0.r0.c1", "value": "01711", "source": "user"},
        {"id": "t0.r1.c1", "value": "new@example.org", "source": "user"},
    ])

    assert checked.returncode == 0, checked.stdout
    result = Document(str(out))
    assert result.paragraphs[0].text == "Name: Rahima   Dept: Chemistry   Room: 12"
    assert result.tables[0].cell(0, 1).text == "01711" and result.tables[0].cell(1, 1).text == "new@example.org"


def test_gate_fails_when_an_unmapped_filled_cell_changes(filled_word, tmp_path):
    out, mapping, _ = update_word(filled_word, tmp_path, [{"id": "t0.r0.c1", "value": "Salma", "source": "user"}])
    doc = Document(str(out))
    doc.tables[0].cell(1, 1).text = "Chemistry"
    doc.paragraphs[0].runs[0].text = "Institution: BUET"
    doc.save(str(out))

    checked = run("check.py", filled_word, out, mapping, cwd=tmp_path)

    assert checked.returncode == 2
    assert "t0.r1.c1.p0: changed although it is not in the mapping" in checked.stdout
    assert "p0: changed although it is not in the mapping" in checked.stdout


def test_gate_fails_when_old_value_stays_in_the_cell(filled_word, tmp_path):
    out, mapping, _ = update_word(filled_word, tmp_path, [{"id": "t0.r1.c1", "value": "Chemistry", "source": "user"}])
    doc = Document(str(out))
    doc.tables[0].cell(1, 1).text = "Physics Chemistry"
    doc.save(str(out))

    assert run("check.py", filled_word, out, mapping, cwd=tmp_path).returncode == 2


# ---------------------------------------------------------------- updating a flat or scanned PDF


@pytest.fixture
def printed_pdf(tmp_path):
    path = tmp_path / "printed.pdf"
    page = canvas.Canvas(str(path), pagesize=(595, 842))
    page.setFont("Times-Bold", 12)
    page.drawString(50, 760, "Department: Physics")
    page.setFont("Helvetica", 10)
    page.drawString(50, 730, "Paper: Physics and Physics")
    page.drawString(50, 700, "Name: Rahima Khatun   Year: 2025")
    page.drawString(50, 670, "Signature")
    page.save()
    return path


def replace_mapping(tmp_path, value, spec, **extra):
    entry = {"id": "dept", "label": "Department", "value": value, "source": "user message", "replace": spec}
    return write_json(tmp_path / "replace.json", {"fields": [entry], **extra})


def covers_on(path):
    import pdfplumber

    with pdfplumber.open(str(path)) as pdf:
        return [r for r in pdf.pages[0].rects if r.get("fill")]


def new_chars(path, text):
    import pdfplumber

    with pdfplumber.open(str(path)) as pdf:
        words = pdf.pages[0].extract_words(extra_attrs=["size", "fontname"])
    return next(w for w in words if w["text"] == text)


def test_replace_found_text_covers_the_box_and_draws_at_the_same_baseline(printed_pdf, tmp_path):
    mapping = replace_mapping(tmp_path, "Chemistry", {"page": 1, "find": "Physics", "occurrence": 1})
    out = tmp_path / "out.pdf"

    filled = run("fill.py", printed_pdf, mapping, out, cwd=tmp_path)
    checked = run("check.py", printed_pdf, out, mapping, cwd=tmp_path)

    assert filled.returncode == 0, filled.stdout
    assert "covered, not removed" in filled.stdout and "'Physics'" in filled.stdout
    assert checked.returncode == 0, checked.stdout
    assert "Department: Physics → Chemistry" in checked.stdout
    assert "Chemistry" in PdfReader(str(out)).pages[0].extract_text()
    cover = covers_on(out)[0]
    assert cover["non_stroking_color"] in ((1, 1, 1), [1, 1, 1], (1.0, 1.0, 1.0))
    word = new_chars(out, "Chemistry")
    assert "Times-Bold" in word["fontname"]
    assert word["x0"] == pytest.approx(cover["x0"], abs=0.1) and word["size"] == pytest.approx(12)
    assert word["bottom"] == pytest.approx(842 - 760 + 12 * 0.216, abs=1.5)


def test_replace_spans_words_and_cover_colour(printed_pdf, tmp_path):
    mapping = replace_mapping(tmp_path, "Salma Begum", {"page": 1, "find": "Rahima Khatun", "cover": "#eeeeee"})
    out = tmp_path / "out.pdf"

    filled = run("fill.py", printed_pdf, mapping, out, cwd=tmp_path)

    assert filled.returncode == 0, filled.stdout
    cover = covers_on(out)[0]
    assert cover["non_stroking_color"][0] == pytest.approx(0xEE / 255, abs=0.01)
    assert cover["x1"] - cover["x0"] > 50
    assert run("check.py", printed_pdf, out, mapping, cwd=tmp_path).returncode == 0


def test_replace_not_found_and_ambiguous_exit_2(printed_pdf, tmp_path):
    out = tmp_path / "out.pdf"

    missing = run("fill.py", printed_pdf, replace_mapping(tmp_path, "X", {"page": 1, "find": "Biology"}), out, cwd=tmp_path)
    twice = run("fill.py", printed_pdf, replace_mapping(tmp_path, "X", {"page": 1, "find": "Physics"}), out, cwd=tmp_path)

    assert missing.returncode == 2 and "not found on page 1" in missing.stdout
    assert twice.returncode == 2 and "matches 3 times" in twice.stdout and "occurrence" in twice.stdout


def test_replace_occurrence_picks_one(printed_pdf, tmp_path):
    mapping = replace_mapping(tmp_path, "Maths", {"page": 1, "find": "Physics", "occurrence": 3})
    out = tmp_path / "out.pdf"

    assert run("fill.py", printed_pdf, mapping, out, cwd=tmp_path).returncode == 0
    import pdfplumber

    with pdfplumber.open(str(out)) as pdf:
        char = next(c for c in pdf.pages[0].chars if c["text"] == "M")
    assert char["matrix"][5] == pytest.approx(730) and char["x0"] > 130

    bad = replace_mapping(tmp_path, "Maths", {"page": 1, "find": "Physics", "occurrence": 9})
    assert run("fill.py", printed_pdf, bad, out, cwd=tmp_path).returncode == 2


def test_longer_value_uses_free_space_at_full_size(printed_pdf, tmp_path):
    mapping = replace_mapping(tmp_path, "Biochemistry", {"page": 1, "find": "Physics", "occurrence": 1})
    out = tmp_path / "out.pdf"

    assert run("fill.py", printed_pdf, mapping, out, cwd=tmp_path).returncode == 0
    checked = run("check.py", printed_pdf, out, mapping, cwd=tmp_path)

    assert checked.returncode == 0, checked.stdout
    assert new_chars(out, "Biochemistry")["size"] == pytest.approx(12)


def test_longer_value_shrinks_when_a_neighbouring_word_is_in_the_way(printed_pdf, tmp_path):
    mapping = replace_mapping(tmp_path, "Rahima Khatun Begum", {"page": 1, "find": "Rahima Khatun"})
    out = tmp_path / "out.pdf"

    assert run("fill.py", printed_pdf, mapping, out, cwd=tmp_path).returncode == 0
    checked = run("check.py", printed_pdf, out, mapping, cwd=tmp_path)

    assert checked.returncode == 0, checked.stdout
    word = new_chars(out, "Rahima")
    assert word["size"] < 12
    with pdfplumber.open(str(printed_pdf)) as pdf:
        year = next(w for w in pdf.pages[0].extract_words() if w["text"] == "Year:")
    with pdfplumber.open(str(out)) as pdf:
        drawn = [c for c in pdf.pages[0].chars if c["fontname"] == word["fontname"]
                 and abs(c["top"] - word["top"]) < 2 and c["x0"] < year["x0"]]
    assert max(c["x1"] for c in drawn) <= year["x0"] + 0.01


def test_value_too_long_even_at_6_pt_is_a_defect(printed_pdf, tmp_path):
    mapping = replace_mapping(tmp_path, "Department of Applied Mathematics and Statistics, Faculty of Science, University",
                              {"page": 1, "find": "Rahima Khatun"})
    out = tmp_path / "out.pdf"

    filled = run("fill.py", printed_pdf, mapping, out, cwd=tmp_path)
    checked = run("check.py", printed_pdf, out, mapping, cwd=tmp_path)

    assert filled.returncode == 2 and "does not fit" in filled.stdout
    assert checked.returncode == 2 and "below 6 pt" in checked.stdout


def test_overlap_check_passes_own_box_and_fails_another_word(printed_pdf, tmp_path):
    mapping = write_json(tmp_path / "replace.json", {"fields": [
        {"id": "dept", "value": "Chemistry", "source": "user", "replace": {"page": 1, "find": "Physics", "occurrence": 1}},
        {"id": "again", "value": "Lab 2", "source": "user", "page": 1, "x": 124, "y": 760, "size": 9},
        {"id": "misplaced", "value": "Over it", "source": "user", "page": 1, "x": 50, "y": 670},
    ]})
    out = tmp_path / "out.pdf"
    run("fill.py", printed_pdf, mapping, out, cwd=tmp_path)

    checked = run("check.py", printed_pdf, out, mapping, cwd=tmp_path)

    assert checked.returncode == 2
    assert "printed word 'Signature'" in checked.stdout
    assert "'Physics'; move it" not in checked.stdout and "dept" not in checked.stdout.split("change")[0]

    reaching = replace_mapping(tmp_path, "X", {"page": 1, "box": [60, 666, 80, 14]})
    run("fill.py", printed_pdf, reaching, out, cwd=tmp_path)
    assert "printed word" in run("check.py", printed_pdf, out, reaching, cwd=tmp_path).stdout


def test_flat_include_filled_lists_label_value_lines(printed_pdf, tmp_path):
    out = tmp_path / "fields.json"

    result = run("fields.py", printed_pdf, "--include-filled", "--out", out, cwd=tmp_path)

    assert result.returncode == 2
    found = {(f["label"], f["value"]): f for f in json.loads(out.read_text(encoding="utf-8"))["filled"]}
    assert ("Year", "2025") in found and ("Name", "Rahima Khatun") in found
    department = found["Department", "Physics"]
    assert department["page"] == 1 and department["y"] == 760 and department["size"] == 12


def test_replace_works_when_the_media_box_is_offset(printed_pdf, tmp_path):
    from pypdf import PdfWriter
    from pypdf.generic import RectangleObject

    writer = PdfWriter(clone_from=str(printed_pdf))
    writer.pages[0].mediabox = RectangleObject((20, 30, 520, 830))
    writer.pages[0].cropbox = RectangleObject((20, 30, 520, 830))
    form = tmp_path / "offset.pdf"
    writer.write(form)
    mapping = replace_mapping(tmp_path, "Chemistry", {"page": 1, "find": "Physics", "occurrence": 1})
    out = tmp_path / "out.pdf"

    assert run("fill.py", form, mapping, out, cwd=tmp_path).returncode == 0
    assert run("check.py", form, out, mapping, cwd=tmp_path).returncode == 0
    seen = []
    PdfReader(str(out)).pages[0].extract_text(visitor_text=lambda t, _cm, tm, _f, _s: seen.append((t.strip(), tm[4], tm[5])))
    drawn = next(item for item in seen if item[0] == "Chemistry")
    assert drawn[2] == pytest.approx(760, abs=0.5), seen


def scan_pdf(tmp_path):
    from PIL import Image

    path = tmp_path / "scan.pdf"
    Image.new("RGB", (827, 1169), "white").save(path, resolution=100)
    return path


def test_scan_box_replace_in_pixels(tmp_path):
    form = scan_pdf(tmp_path)
    mapping = write_json(tmp_path / "scan.json", {"fields": [{
        "id": "roll", "label": "Roll", "old": "1024", "value": "1042", "source": "user message",
        "replace": {"page": 1, "box": [200, 300, 200, 40], "units": "px", "dpi": 100, "cover": "#f5f5f0"}}]})
    out = tmp_path / "out.pdf"

    filled = run("fill.py", form, mapping, out, cwd=tmp_path)
    checked = run("check.py", form, out, mapping, cwd=tmp_path)

    assert filled.returncode == 0, filled.stdout
    assert "covered, not removed" in filled.stdout
    assert checked.returncode == 0, checked.stdout
    assert "Roll: 1024 → 1042" in checked.stdout
    assert "1042" in PdfReader(str(out)).pages[0].extract_text()
    cover = covers_on(out)[0]
    assert cover["x0"] == pytest.approx(144, abs=0.5) and cover["width"] == pytest.approx(144, abs=0.5)
    assert cover["top"] == pytest.approx(216, abs=0.5) and cover["height"] == pytest.approx(28.8, abs=0.5)


def test_box_off_the_page_is_reported(tmp_path):
    form = scan_pdf(tmp_path)
    mapping = write_json(tmp_path / "scan.json", {"fields": [{
        "id": "roll", "value": "1042", "replace": {"page": 1, "box": [800, 300, 200, 40], "units": "px", "dpi": 100}}]})

    assert run("fill.py", form, mapping, tmp_path / "out.pdf", cwd=tmp_path).returncode == 2


# ---------------------------------------------------------------- flatten_replaced


def stream_text(path):
    reader = PdfReader(str(path))
    found = b""
    for number in range(1, len(reader.xref_objStm) + sum(len(v) for v in reader.xref.values()) + 50):
        try:
            item = reader.get_object(number)
        except Exception:
            continue
        if hasattr(item, "get_data"):
            found += item.get_data()
    return found


def test_flatten_without_poppler_exits_1_and_writes_nothing(printed_pdf, tmp_path):
    mapping = replace_mapping(tmp_path, "Chemistry", {"page": 1, "find": "Physics", "occurrence": 1}, flatten_replaced=True)
    out = tmp_path / "out.pdf"
    env = {"PATH": str(tmp_path)}

    result = subprocess.run([sys.executable, str(SCRIPTS / "fill.py"), printed_pdf, mapping, out], cwd=tmp_path, env=env,
                            capture_output=True, text=True, check=False)

    assert result.returncode == 1
    assert "flatten_replaced needs pdftoppm" in result.stdout
    assert not out.exists()


def test_flatten_removes_old_text_from_the_file_objects(printed_pdf, tmp_path, monkeypatch):
    from PIL import Image

    monkeypatch.syspath_prepend(str(SCRIPTS))
    import fill as fill_script
    import pdf2image

    pages = []

    def rendered(path, dpi, first_page, last_page):
        pages.append((dpi, first_page, last_page))
        return [Image.new("RGB", (1654, 2339), "white")]

    monkeypatch.setattr(pdf2image, "convert_from_path", rendered)
    monkeypatch.setattr(fill_script, "require_flatten_tools", lambda: None)
    mapping = replace_mapping(tmp_path, "Chemistry", {"page": 1, "find": "Physics", "occurrence": 1}, flatten_replaced=True)
    out = tmp_path / "out.pdf"

    _, report = fill_script.fill(printed_pdf, fill_script.load_mapping(mapping), out)

    assert report.code == 0, report.lines()
    assert pages == [(200, 1, 1)]
    assert PdfReader(str(out)).pages[0].extract_text().strip() == ""
    assert b"Physics" not in stream_text(out)
    assert any("rasterised" in note for note in report.notes)
    assert not any("covered, not removed" in note for note in report.notes)
    checked = run("check.py", printed_pdf, out, mapping, cwd=tmp_path)
    assert checked.returncode == 0, checked.stdout


@pytest.mark.skipif(not shutil.which("pdftoppm"), reason="needs poppler")
def test_flatten_with_real_poppler(printed_pdf, tmp_path):
    mapping = replace_mapping(tmp_path, "Chemistry", {"page": 1, "find": "Physics", "occurrence": 1}, flatten_replaced=True)
    out = tmp_path / "out.pdf"

    assert run("fill.py", printed_pdf, mapping, out, cwd=tmp_path).returncode == 0
    assert PdfReader(str(out)).pages[0].extract_text().strip() == ""
    assert run("check.py", printed_pdf, out, mapping, cwd=tmp_path).returncode == 0


# ---------------------------------------------------------------- updating a fillable PDF


def test_fillable_pdf_update_reports_old_to_new_and_guards_unmapped(fillable_pdf, tmp_path):
    first = write_json(tmp_path / "first.json", {"fields": [
        {"id": "name", "value": "Rahima Khatun", "source": "CV"}, {"id": "remarks", "value": "Pending", "source": "CV"}]})
    filled = tmp_path / "filled.pdf"
    run("fill.py", fillable_pdf, first, filled, cwd=tmp_path)
    second = write_json(tmp_path / "second.json", {"fields": [
        {"id": "name", "label": "Full name", "value": "Salma Begum", "source": "user message"}]})
    out = tmp_path / "updated.pdf"

    updated = run("fill.py", filled, second, out, cwd=tmp_path)
    checked = run("check.py", filled, out, second, cwd=tmp_path)

    assert updated.returncode == 0, updated.stdout
    assert checked.returncode == 0, checked.stdout
    assert "Full name: Rahima Khatun → Salma Begum" in checked.stdout
    values = {k: v.get("/V") for k, v in PdfReader(str(out)).get_fields().items()}
    assert values["name"] == "Salma Begum" and values["remarks"] == "Pending"

    changed_other = run("check.py", fillable_pdf, out, second, cwd=tmp_path)
    assert changed_other.returncode == 2
    assert "remarks: changed although it is not in the mapping" in changed_other.stdout


def _ruled_flat_pdf(path):
    from reportlab.pdfgen import canvas

    drawing = canvas.Canvas(str(path))
    drawing.setFont("Helvetica", 12)
    for index, (label, value) in enumerate([("Department:", "Physics"), ("Designation:", "Lecturer")]):
        y = 750 - index * 30
        drawing.drawString(50, y, label)
        drawing.drawString(150, y, value)
        drawing.line(150, y - 3, 400, y - 3)
    drawing.save()
    return path


def test_flat_pdf_lists_a_value_set_apart_from_its_label_and_not_its_rule(tmp_path):
    import fields as fields_module

    info = fields_module.pdf_flat_info(_ruled_flat_pdf(tmp_path / "form.pdf"), include_filled=True)
    assert [(item["label"], item["value"]) for item in info["filled"]] == [
        ("Department", "Physics"), ("Designation", "Lecturer")]
    assert info["blanks"] == []


def test_word_paragraph_lists_a_value_set_apart_from_its_label():
    import fields as fields_module

    text = "Faculty:  Science"
    assert fields_module.label_value_spans(text) == [("Faculty", 10, 17)]


def test_flat_pdf_longer_value_uses_the_free_rule_at_full_size(tmp_path):
    import fill as fill_module
    import pdfplumber

    form = _ruled_flat_pdf(tmp_path / "form.pdf")
    entry = {"id": "d", "replace": {"page": 1, "find": "Lecturer"}, "value": "Senior Lecturer Grade I", "source": "user"}
    with pdfplumber.open(str(form)) as pdf:
        box = [0, 0, float(pdf.pages[0].width), float(pdf.pages[0].height)]
        plan = fill_module.replace_plan(entry, {}, pdf, [box], fill_module.Report(), {})
    assert plan["size"] == pytest.approx(12)
    assert plan["fits"]


def test_flat_pdf_cover_redraws_the_rule_it_paints_over(tmp_path):
    import fill as fill_module
    import pdfplumber

    form = _ruled_flat_pdf(tmp_path / "form.pdf")
    entry = {"id": "d", "replace": {"page": 1, "find": "Physics"}, "value": "Chemistry", "source": "user"}
    with pdfplumber.open(str(form)) as pdf:
        box = [0, 0, float(pdf.pages[0].width), float(pdf.pages[0].height)]
        plan = fill_module.replace_plan(entry, {}, pdf, [box], fill_module.Report(), {})
    assert len(plan["rules"]) == 1
    assert plan["rules"][0][2] == pytest.approx(747, abs=0.5)


def _staff_book(path):
    import datetime

    from openpyxl import Workbook

    book = Workbook()
    sheet = book.active
    sheet.title = "Staff"
    sheet.append(["Name", "Department", "Phone", "Joined", "Salary", "Share"])
    sheet.append(["Nimal Perera", "Physics", "0712345678", datetime.date(2019, 3, 5), 125000, 0.25])
    sheet.append(["Kamala Silva", "Chemistry", "0779876543", datetime.date(2021, 7, 1), 98500.5, 0.1])
    sheet["D2"].number_format = "dd.mm.yyyy"
    sheet["D3"].number_format = "yyyy-mm-dd"
    sheet["E2"].number_format = "#,##0"
    sheet["E3"].number_format = "#,##0.00"
    sheet["F2"].number_format = "0%"
    sheet["F3"].number_format = "0.0%"
    sheet["G2"] = "=E2*2"
    book.save(path)
    return path


def test_read_source_shows_cells_as_displayed_with_addresses(tmp_path):
    result = run("read_source.py", _staff_book(tmp_path / "staff.xlsx"), cwd=tmp_path)
    assert "A2=Nimal Perera" in result.stdout and "C2=0712345678" in result.stdout
    assert "D2=05.03.2019" in result.stdout and "D3=2021-07-01" in result.stdout
    assert "E2=125,000" in result.stdout and "E3=98,500.50" in result.stdout
    assert "F2=25%" in result.stdout and "F3=10.0%" in result.stdout


def test_read_source_warns_about_a_formula_with_no_stored_result(tmp_path):
    result = run("read_source.py", _staff_book(tmp_path / "staff.xlsx"), cwd=tmp_path)
    assert result.returncode == 2 and "G2" in result.stdout


def test_read_source_find_keeps_the_header_and_warns_on_no_or_many_matches(tmp_path):
    book = _staff_book(tmp_path / "staff.xlsx")
    found = run("read_source.py", book, "--find", "kamala", cwd=tmp_path)
    assert "A1=Name" in found.stdout and "A3=Kamala Silva" in found.stdout and "Nimal" not in found.stdout
    assert "matches" not in found.stdout
    assert "matches 0 rows" in run("read_source.py", book, "--find", "nobody", cwd=tmp_path).stdout
    assert "matches 2 rows" in run("read_source.py", book, "--find", "a", "--sheet", "Staff", cwd=tmp_path).stdout


def test_read_source_reads_csv_and_rejects_other_files(tmp_path):
    data = tmp_path / "staff.csv"
    data.write_text("Name,Phone\nNimal,0712345678\n", encoding="utf-8")
    assert "B2=0712345678" in run("read_source.py", data, cwd=tmp_path).stdout
    other = tmp_path / "note.txt"
    other.write_text("x")
    assert run("read_source.py", other, cwd=tmp_path).returncode == 1
