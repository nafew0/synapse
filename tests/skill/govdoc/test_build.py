"""Tests for skill/govdoc/scripts/build.py: every type builds, reads back clean, and keeps its rules.

Needs python-docx and lxml; skipped without them. The full pipeline (fix_bangla, verify_bangla
render + OCR) runs only where the sandbox tools are installed (bangla-skill-test image):
    python -m pytest tests/skill/govdoc
"""
import importlib.util
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(importlib.util.find_spec('docx') is None, reason='python-docx is not installed')

SKILLS = Path(__file__).resolve().parents[3] / 'skill'
SCRIPTS = SKILLS / 'govdoc' / 'scripts'
sys.path.insert(0, str(SCRIPTS))

if importlib.util.find_spec('docx') is not None:
    import build  # noqa: E402
    import check  # noqa: E402

HAS_RENDER = all(shutil.which(tool) for tool in ('soffice', 'pdftoppm', 'tesseract', 'fc-list'))

HEAD = ['গণপ্রজাতন্ত্রী বাংলাদেশ সরকার', 'জনপ্রশাসন মন্ত্রণালয়', 'কল্যাণ শাখা', 'www.mopa.gov.bd']
SIGNER = {'name': 'আলেয়া আক্তার', 'id': '5614', 'designation': 'উপসচিব', 'phone': '02-9549621',
          'email': 'welfare@mopa.gov.bd'}
BODY = ['উপর্যুক্ত বিষয়ের পরিপ্রেক্ষিতে জানানো যাচ্ছে যে, তথ্য হালনাগাদ করা প্রয়োজন।',
        'এমতাবস্থায়, 15 দিনের মধ্যে তথ্য প্রেরণের জন্য নির্দেশক্রমে অনুরোধ করা হলো।']
TO = ['নির্বাহী পরিচালক', 'বাংলাদেশ রিসার্চ অ্যান্ড এডুকেশন নেটওয়ার্ক', 'আগারগাঁও, ঢাকা।']
COPIES = ['সচিবের একান্ত সচিব, জনপ্রশাসন মন্ত্রণালয় (সচিব মহোদয়ের সদয় অবগতির জন্য)।', 'সংরক্ষণ নথি।']


def spec(kind, **extra):
    base = {'type': kind, 'date': '2026-10-21', 'letterhead': HEAD, 'number': '05.00.0000.123.02.048.26',
            'issue': 310, 'body': BODY, 'signer': SIGNER, 'copies': COPIES}
    if kind in ('letter', 'memo', 'circular', 'notice', 'meeting'):
        base['subject'] = 'তথ্য হালনাগাদ প্রসঙ্গে।'
    if kind in ('letter', 'memo', 'do'):
        base['to'] = TO
    if kind in ('circular', 'notice', 'meeting'):
        base['distribution'] = ['যুগ্মসচিব (প্রশাসন), জনপ্রশাসন মন্ত্রণালয়।']
    if kind == 'do':
        base['salutation'] = 'প্রিয় জেলা প্রশাসক,'
    base.update(extra)
    return base


def texts(path):
    return check.paragraphs(path)


@pytest.mark.parametrize('kind', sorted(build.TYPES) if importlib.util.find_spec('docx') else [])
def test_every_type_builds_and_checks_clean(tmp_path, kind):
    path = tmp_path / f'{kind}.docx'
    build.build(spec(kind), path)
    result = check.check(path, kind)
    assert result['status'] == 'clean', result['defects']


def test_memo_layout_order(tmp_path):
    path = tmp_path / 'memo.docx'
    build.build(spec('memo'), path)
    lines = texts(path)
    order = [next(i for i, t in enumerate(lines) if t.startswith(prefix)) for prefix in
             ('গণপ্রজাতন্ত্রী', 'স্মারক নম্বর', 'বিষয়:', 'উপর্যুক্ত', '২। এমতাবস্থায়', '(আলেয়া আক্তার)',
              'নির্বাহী পরিচালক', 'অবগতি ও প্রয়োজনীয়', '১। সচিবের')]
    assert order == sorted(order)
    assert 'মহোদয়,' not in lines and not any(t.startswith('প্রাপক') for t in lines)


def test_letter_puts_the_recipient_on_top_with_salutation(tmp_path):
    path = tmp_path / 'letter.docx'
    build.build(spec('letter'), path)
    lines = texts(path)
    assert lines.index('প্রাপক: নির্বাহী পরিচালক') < lines.index('মহোদয়,') < lines.index('আপনার বিশ্বস্ত,')


def test_numbers_dates_and_digits(tmp_path):
    path = tmp_path / 'memo.docx'
    build.build(spec('memo'), path)
    lines = texts(path)
    assert 'স্মারক নম্বর: ০৫.০০.০০০০.১২৩.০২.০৪৮.২৬-৩১০' in lines
    assert lines[lines.index('তারিখ:') + 1:][:2] == ['০৫ কার্তিক ১৪৩৩', '২১ অক্টোবর ২০২৬']
    assert any('১৫ দিনের মধ্যে' in t for t in lines)
    assert 'ই-মেইল: welfare@mopa.gov.bd' in lines and 'ফোন: ০২-৯৫৪৯৬২১' in lines


def test_placeholder_number_and_blank_date(tmp_path):
    path = tmp_path / 'memo.docx'
    build.build(spec('memo', number=None, date=''), path)
    assert any(t.startswith('স্মারক নম্বর: ……') for t in texts(path))


def test_notification_is_signed_by_order_of_the_president(tmp_path):
    path = tmp_path / 'notification.docx'
    build.build(spec('notification'), path)
    lines = texts(path)
    assert lines.index('প্রজ্ঞাপন') < lines.index('রাষ্ট্রপতির আদেশক্রমে,') < lines.index('(আলেয়া আক্তার)')


def test_university_order_overrides_authority(tmp_path):
    path = tmp_path / 'order.docx'
    build.build(spec('order', authority='উপাচার্য মহোদয়ের অনুমোদনক্রমে,'), path)
    assert 'উপাচার্য মহোদয়ের অনুমোদনক্রমে,' in texts(path)


def test_do_letter_has_sender_on_top_and_no_letterhead(tmp_path):
    path = tmp_path / 'do.docx'
    build.build(spec('do', letterhead=None), path)
    lines = texts(path)
    assert lines[0] == 'আলেয়া আক্তার' and 'গণপ্রজাতন্ত্রী বাংলাদেশ সরকার' not in lines
    assert lines.index('শুভেচ্ছান্তে,') < lines.index('আন্তরিকভাবে আপনার,')


def test_body_items_and_tables(tmp_path):
    body = BODY[:1] + [{'items': ['প্রথম শর্ত;', '(খ) দ্বিতীয় শর্ত।']},
                       {'table': [['ক্রমিক', 'নাম'], ['1', 'ঢাকা']]}] + BODY[1:]
    path = tmp_path / 'circular.docx'
    build.build(spec('circular', body=body), path)
    lines = texts(path)
    assert '(ক) প্রথম শর্ত;' in lines and '(খ) দ্বিতীয় শর্ত।' in lines
    assert lines.index('ক্রমিক') < lines.index('১') < lines.index('ঢাকা')
    assert any(t.startswith('২। এমতাবস্থায়') for t in lines)


@pytest.mark.parametrize('bad, message', [
    ({'type': 'gazette'}, 'type must be one of'),
    ({'subject': None}, 'subject (বিষয়) is required'),
    ({'letterhead': []}, 'letterhead is required'),
])
def test_spec_errors(tmp_path, bad, message):
    with pytest.raises(build.SpecError, match=message.replace('(', r'\(').replace(')', r'\)')):
        build.build({**spec('memo'), **bad}, tmp_path / 'x.docx')


def test_order_refuses_a_subject(tmp_path):
    with pytest.raises(build.SpecError, match='no বিষয় line'):
        build.build(spec('order', subject='কিছু'), tmp_path / 'x.docx')


def test_complex_script_fonts_and_rpr_order(tmp_path):
    path = tmp_path / 'memo.docx'
    build.build(spec('memo'), path)
    with zipfile.ZipFile(path) as package:
        styles = package.read('word/styles.xml').decode()
        document = package.read('word/document.xml').decode()
    assert 'w:cs="Nikosh"' in styles and 'w:szCs w:val="26"' in styles and 'w:bidi="bn-BD"' in styles
    assert '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="Nikosh" w:cs="Nikosh"/><w:b/><w:bCs/>' in document


def test_bangla_digits_skip_addresses():
    assert build.bangla_digits('ফোন 02-9549621, a1@b.gov.bd, www.x2.gov.bd') == 'ফোন ০২-৯৫৪৯৬২১, a1@b.gov.bd, www.x2.gov.bd'


@pytest.mark.skipif(not HAS_RENDER or not (SKILLS / 'docx' / 'scripts' / 'office' / 'fix_bangla.py').is_file(),
                    reason='needs LibreOffice, Poppler, Tesseract ben and the docx skill Bangla scripts')
def test_full_pipeline_renders_clean(tmp_path):
    import json
    spec_path = tmp_path / 'spec.json'
    spec_path.write_text(json.dumps(spec('memo'), ensure_ascii=False), encoding='utf-8')
    done = subprocess.run([sys.executable, str(SCRIPTS / 'build.py'), str(spec_path), str(tmp_path / 'memo.docx')],
                          capture_output=True, text=True)
    result = json.loads(done.stdout)
    assert done.returncode == 0, result
    assert result['fix']['embedded'] and result['verify']['render']['status'] == 'clean'
