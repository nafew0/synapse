import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from docx import Document
from docx.oxml.ns import qn

SKILL = Path(__file__).resolve().parents[3] / "skill" / "official-correspondence"
BUILD = SKILL / "scripts" / "build.py"
CHECK = SKILL / "scripts" / "check.py"
sys.path.insert(0, str(SKILL / "scripts"))

from build import HOUSES, date_text, ordinal  # noqa: E402


def run(tmp_path, spec, script=BUILD):
    path = tmp_path / "spec.json"
    path.write_text(json.dumps(spec, ensure_ascii=False), encoding="utf-8")
    out = tmp_path / "out.docx"
    args = [sys.executable, str(script), str(path), str(out)]
    args += ["--no-render"] if script == BUILD else []
    result = subprocess.run(args, capture_output=True, text=True)
    return result, out


def texts(out):
    doc = Document(str(out))
    parts = []
    for child in doc.element.body.iterchildren():
        parts += ["".join(t.text or "" for t in child.iter("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t"))]
    return [p for p in parts if p]


def order_ok(lines, *needles):
    positions = [next(i for i, line in enumerate(lines) if needle in line) for needle in needles]
    return positions == sorted(positions)


CIRCULAR = {"kind": "circular", "house": "ugc-lk", "number": "08/2023", "date": "2023-10-03",
            "to": ["Vice-Chancellors of Universities"], "subject": "Portal documents",
            "body": ["First paragraph.", "Second paragraph."], "signer": {"name": "A. Perera", "designation": "Secretary"},
            "copies": ["Chairman"], "file_no": "UGC/HR/10/12"}


@pytest.mark.parametrize("day,text", [(1, "01st"), (2, "02nd"), (3, "03rd"), (4, "04th"), (11, "11th"), (12, "12th"),
                                      (13, "13th"), (21, "21st"), (22, "22nd"), (31, "31st")])
def test_ordinal(day, text):
    assert ordinal(day) == text


@pytest.mark.parametrize("house,text", [("ugc-lk", "03rd October, 2023"), ("pa-lk", "03.10.2023"), ("university-lk", "03.10.2023"),
                                        ("ministry-lk", "2023.10.03"), ("bd", "03.10.2023")])
def test_date_follows_the_house(house, text):
    assert date_text({"date": "2023-10-03"}, HOUSES[house]) == text


def test_date_style_overrides_and_free_text_survives():
    assert date_text({"date": "2023-10-03", "date_style": "dotted"}, HOUSES["ugc-lk"]) == "03.10.2023"
    assert date_text({"date": "July 03rd, 2009"}, HOUSES["ugc-lk"]) == "July 03rd, 2009"


def test_ugc_circular_structure(tmp_path):
    result, out = run(tmp_path, CIRCULAR)
    assert result.returncode == 0, result.stdout
    lines = texts(out)
    assert order_ok(lines, "08/2023", "Vice-Chancellors", "PORTAL DOCUMENTS", "First paragraph", "A. Perera", "Copies:", "File No: UGC/HR/10/12")
    assert not any(line.startswith("02.") for line in lines)
    assert "My No." not in " ".join(lines)
    assert "03rd October, 2023" in " ".join(lines)


def test_pa_circular_numbering_centre_and_size(tmp_path):
    spec = {**CIRCULAR, "house": "pa-lk", "date": "2021-05-04", "issuer_address": ["Ministry of Public Administration"],
            "my_no": "EST/1/2", "body": ["One.", "Two.", {"items": ["alpha", "beta"]}, "Three."],
            "signer": {"name": "B", "designation": "Secretary", "phone": "011", "email": "s@gov.lk"}}
    result, out = run(tmp_path, spec)
    assert result.returncode == 0, result.stdout
    doc = Document(str(out))
    subject = next(p for p in doc.paragraphs if p.text == "Portal documents")
    assert subject.alignment == 1 and subject.runs[0].font.size.pt == 14
    assert [p.text[:3] for p in doc.paragraphs if p.text[:2] in ("02", "03")] == ["02.", "03."]
    assert any(p.text.startswith("I.\talpha") for p in doc.paragraphs)
    assert "Telephone: 011" in " ".join(texts(out))


def test_bd_subject_comes_before_salutation(tmp_path):
    spec = {"kind": "letter", "house": "bd", "my_no": "37.01", "date": "2024-07-31", "to": ["The Registrar"], "salutation": "Dear Sir,",
            "subject": "Training", "body": ["First.", "Second."], "letterhead": ["Government of the People's Republic of Bangladesh"],
            "distribution": ["Registrar"], "copies": ["VC office"], "signer": {"name": "C", "designation": "Senior Assistant Secretary"}}
    result, out = run(tmp_path, spec)
    assert result.returncode == 0, result.stdout
    lines = texts(out)
    assert order_ok(lines, "Ref. No. 37.01", "Subject: Training", "Dear Sir,", "First.", "Distribution:", "Copy for kind information")
    assert "02.Second." in lines


@pytest.mark.parametrize("spec,needle", [
    ({"kind": "notice", "body": ["The public is hereby informed."], "signer": {"designation": "Chairperson"}}, "NOTICE"),
    ({"kind": "memo", "house": "university-lk", "to": ["Deans"], "from": "Registrar", "subject": "Hostel policy", "body": ["Please comment."]}, "MEMORANDUM"),
    ({"kind": "meeting", "to": ["Members"], "subject": "Senate", "body": ["You are invited."], "date_of_meeting": "5 November", "time": "10.00 a.m.", "duration": "1 hour",
      "venue": "Board Room", "agenda": ["Minutes"]}, "NOTICE OF MEETING"),
    ({"kind": "order", "house": "bd", "body": ["This is to notify."], "copies": ["Personal file."]}, "Office Order"),
    ({"kind": "order", "subject": "Acting duties", "body": ["This is to notify."]}, "Office Order"),
])
def test_other_kinds_pass_and_carry_their_title(tmp_path, spec, needle):
    result, out = run(tmp_path, spec)
    assert result.returncode == 0, result.stdout
    assert any(needle in line for line in texts(out))


def test_meeting_details_print(tmp_path):
    spec = {"kind": "meeting", "to": ["Members"], "subject": "Senate", "date_of_meeting": "5 November", "time": "10.00 a.m.", "venue": "Board Room", "body": ["Invited."]}
    _, out = run(tmp_path, spec)
    joined = " ".join(texts(out))
    assert "Date:5 November" in joined and "Venue:Board Room" in joined


def test_missing_values_become_listed_placeholders(tmp_path):
    spec = {"kind": "letter", "to": ["The Secretary"], "salutation": "Dear Sir,", "subject": "S", "body": ["B."]}
    result, out = run(tmp_path, spec)
    assert result.returncode == 0, result.stdout
    assert "[My No.]" in " ".join(texts(out))
    assert "[My No.], [Name], [Designation]" in result.stdout.replace("[Designation], [My No.], [Name]", "[My No.], [Name], [Designation]")


def test_a4_times_and_no_invented_logo(tmp_path):
    _, out = run(tmp_path, CIRCULAR)
    doc = Document(str(out))
    assert round(doc.sections[0].page_width.cm, 1) == 21.0 and round(doc.sections[0].page_height.cm, 1) == 29.7
    assert doc.styles["Normal"].font.name == "Times New Roman"
    assert not doc.inline_shapes
    assert doc.settings.element.find(qn("w:zoom")).get(qn("w:percent")) == "100"


def test_bangla_gets_nikosh_and_its_language(tmp_path):
    _, out = run(tmp_path, {**CIRCULAR, "body": ["বিশ্ববিদ্যালয়", "English only."]})
    xml = Document(str(out)).element.xml
    assert 'w:cs="Nikosh"' in xml and xml.count('w:bidi="bn-BD"') == 1


def test_copies_list_keeps_house_heading_and_ten_copies_do_not_break_numbering(tmp_path):
    spec = {**CIRCULAR, "house": "pa-lk", "copies": [f"Office {n}" for n in range(1, 13)], "body": ["One.", "Two."]}
    result, out = run(tmp_path, spec)
    assert result.returncode == 0, result.stdout
    assert "Copies-" in texts(out)


@pytest.mark.parametrize("change,message", [
    ({"salutation": "Dear Sir,"}, "no salutation"),
    ({"subject": "Subject: X"}, "without a"),
    ({"to": []}, "needs to"),
])
def test_circular_defects(tmp_path, change, message):
    result, _ = run(tmp_path, {**CIRCULAR, **change})
    assert result.returncode == 2 and message in result.stdout


def test_letter_needs_salutation_unless_list_of_posts(tmp_path):
    spec = {"kind": "letter", "to": ["Registrars"], "subject": "S", "body": ["B."]}
    assert run(tmp_path, spec)[0].returncode == 2
    assert run(tmp_path, {**spec, "no_salutation": True})[0].returncode == 0


def test_leave_abroad_requires_code_attachments(tmp_path):
    spec = {"kind": "leave", "leave_type": "abroad", "to": ["The Vice-Chancellor"], "through": ["Head of Department", "Dean"],
            "salutation": "Dear Sir,", "subject": "Overseas leave", "body": ["I request leave."], "address_on_leave": "Kandy",
            "recommenders": ["Head of Department"], "enclosures": ["Approval form"]}
    result, _ = run(tmp_path, spec)
    assert result.returncode == 2 and "invitation" in result.stdout
    spec["enclosures"] += ["Invitation letter", "Statement of past overseas leave", "Total cost and source of funds"]
    result, out = run(tmp_path, spec)
    assert result.returncode == 0, result.stdout
    assert order_ok(texts(out), "Through: Head of Department", "Dean", "OVERSEAS LEAVE", "Address while on leave", "Attached:", "Recommended")


def test_tone_warnings_do_not_fail(tmp_path):
    spec = {"kind": "letter", "to": ["R"], "salutation": "Dear Sir,", "closing": "Yours sincerely,", "subject": "S",
            "body": ["We can't start the program. I am directed to ask ASAP."]}
    result, _ = run(tmp_path, spec)
    assert result.returncode == 0
    for needle in ("contraction", "programme", "directed", "do not pair", "informal"):
        assert needle in result.stdout


def test_check_catches_a_file_that_does_not_match(tmp_path):
    _, out = run(tmp_path, CIRCULAR)
    path = tmp_path / "spec.json"
    path.write_text(json.dumps({**CIRCULAR, "body": ["A paragraph not in the file."]}), encoding="utf-8")
    result = subprocess.run([sys.executable, str(CHECK), str(path), str(out)], capture_output=True, text=True)
    assert result.returncode == 2 and "missing from the file" in result.stdout


def test_bad_inputs_exit_one(tmp_path):
    assert run(tmp_path, {"kind": "poem"})[0].returncode == 1
    assert run(tmp_path, {**CIRCULAR, "house": "mars"})[0].returncode == 1
    assert run(tmp_path, {**CIRCULAR, "date": "2023-13-45"})[0].returncode == 1
    assert subprocess.run([sys.executable, str(BUILD)], capture_output=True).returncode == 1


def test_skill_frontmatter():
    head = (SKILL / "SKILL.md").read_text().split("---")[1]
    keys = [line.split(":")[0] for line in head.strip().splitlines()]
    assert keys == ["name", "description", "user-invocable", "license"]
    description = next(line for line in head.splitlines() if line.startswith("description:"))
    assert len(description.split(": ", 1)[1]) <= 250


def fake_tool(folder, name, body):
    path = folder / name
    path.write_text(f"#!/bin/sh\n{body}\n")
    path.chmod(0o755)


def test_two_page_render_adds_page_numbers_and_names_the_image(tmp_path):
    tools = tmp_path / "tools"
    tools.mkdir()
    fake_tool(tools, "soffice", 'while [ $# -gt 0 ]; do [ "$1" = "--outdir" ] && dir=$2; last=$1; shift; done; '
                                'name=$(basename "$last" .docx); echo pdf > "$dir/$name.pdf"')
    fake_tool(tools, "pdfinfo", 'echo "Pages:           2"')
    fake_tool(tools, "pdftoppm", 'for last; do :; done; : > "$last-1.png"')
    path = tmp_path / "spec.json"
    path.write_text(json.dumps(CIRCULAR), encoding="utf-8")
    out, qa = tmp_path / "out.docx", tmp_path / "qa"
    env = {**os.environ, "PATH": f"{tools}{os.pathsep}{os.environ['PATH']}"}
    result = subprocess.run([sys.executable, str(BUILD), str(path), str(out), "--qa-dir", str(qa)], capture_output=True, text=True, env=env)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "pages: 2" in result.stdout and "out-page-1.png" in result.stdout
    footer = Document(str(out)).sections[0].footer._element.xml
    assert "NUMPAGES" in footer and "Page " in footer
