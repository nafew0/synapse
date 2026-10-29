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
    monkeypatch.setenv("PATH", str(Path(sys.executable).parent))

    checked = run("check.py", fillable_pdf, out, mapping, "--render", tmp_path / "qa", cwd=tmp_path)

    assert checked.returncode == 0, checked.stdout
    assert "render skipped" in checked.stdout
