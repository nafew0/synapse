#!/usr/bin/env python3
"""Check a Bangla government document (DOCX, or a .txt/.md draft) against the formats.

Defects (exit 2, fix them before delivering):
  structure  a part the type requires is missing, or a part it forbids is present
             (a salutation on an অফিস স্মারক, a বিষয় line on an অফিস আদেশ…)
  date       the বঙ্গাব্দ date beside a খ্রিষ্টাব্দ date is not the same day, or a meeting is
             dated before its own notice
  spelling   a non-standard spelling with a certain প্রমিত form (সরকারী → সরকারি)
Notes (report them, fix them when you wrote the text):
  digits     Latin digits inside Bangla text (e-mail addresses and URLs are skipped)
  register   সাধু and চলিত verb forms mixed in one document
  contact    no ফোন or ই-মেইল in the signature block (mandatory under SI-2024)
  visarga    a label ended with ঃ instead of a colon (বিষয়ঃ)

With --original, a finding the original already had is only a note: an edit never has to fix
the rest of the user's document.

Usage:
    python3 check.py FILE [--type letter|memo|order|circular|notification|notice|meeting|do|noc|
                                  certificate|minutes] [--original INPUT]
Prints JSON and exits 0 when clean, 2 when defects are found, 1 on bad input.
"""
import argparse
import json
import re
import sys
import unicodedata
import zipfile
from datetime import date
from pathlib import Path

from lxml import etree

sys.path.insert(0, str(Path(__file__).resolve().parent))

import bn  # noqa: E402

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
B = 'ঀ-৿‌‍'
BANGLA = re.compile(f'[{B}]')
NUM = '[0-9০-৯]'

SPELLING = {
    'সরকারী': 'সরকারি', 'বেসরকারী': 'বেসরকারি', 'আধাসরকারী': 'আধা-সরকারি',
    'জানুয়ারী': 'জানুয়ারি', 'ফেব্রুয়ারী': 'ফেব্রুয়ারি',
    'খ্রীষ্টাব্দ': 'খ্রিষ্টাব্দ', 'খৃষ্টাব্দ': 'খ্রিষ্টাব্দ', 'খ্রীস্টাব্দ': 'খ্রিষ্টাব্দ',
    'উপরোক্ত': 'উপর্যুক্ত', 'শ্রেণী': 'শ্রেণি', 'ইতিমধ্যে': 'ইতোমধ্যে', 'স্বত্ত্বেও': 'সত্ত্বেও',
    'সুষ্ঠ': 'সুষ্ঠু', 'মুহুর্ত': 'মুহূর্ত', 'পুরষ্কার': 'পুরস্কার', 'ইদানিং': 'ইদানীং',
    'নির্দেশাবলী': 'নির্দেশাবলি', 'তথ্যাবলী': 'তথ্যাবলি', 'নিয়মাবলী': 'নিয়মাবলি',
    'চাকুরী': 'চাকরি', 'চাকুরি': 'চাকরি', 'বিদেশী': 'বিদেশি', 'দেশী': 'দেশি',
    'আবশ্যকীয়': 'আবশ্যক', 'উল্লেখিত': 'উল্লিখিত', 'সমীচিন': 'সমীচীন', 'দূরাবস্থা': 'দুরবস্থা',
    'ভৌগলিক': 'ভৌগোলিক', 'অত্যাধিক': 'অত্যধিক', 'আকাংখা': 'আকাঙ্ক্ষা',
}
SPELLING_WORD = re.compile(
    f'(?<![{B}])(' + '|'.join(sorted(map(re.escape, SPELLING), key=len, reverse=True)) + f')(?![{B}])')

SADHU = ('হইল', 'হইবে', 'হইয়াছে', 'হইতেছে', 'করিয়া', 'করিতে', 'করিবেন', 'করিল', 'জানাইতেছি',
         'যাইতেছে', 'হইলে', 'দিয়াছে', 'করিয়াছে', 'গিয়াছে', 'হইবেন', 'থাকিবে')
CHALIT = ('হলো', 'হবে', 'হয়েছে', 'হচ্ছে', 'করে', 'করতে', 'করবেন', 'করল', 'জানাচ্ছি',
          'যাচ্ছে', 'হলে', 'দিয়েছে', 'করেছে', 'গেছে', 'হবেন', 'থাকবে')


def words_pattern(words):
    return re.compile(f'(?<![{B}])(' + '|'.join(map(re.escape, words)) + f')(?![{B}])')


SADHU_WORD, CHALIT_WORD = words_pattern(SADHU), words_pattern(CHALIT)
BANGLA_DATE = re.compile(f'({NUM}{{1,2}})\\s+({"|".join(bn.BANGLA_MONTHS)})\\s*,?\\s+({NUM}{{4}})')
ENGLISH_DATE = re.compile(f'({NUM}{{1,2}})\\s+({"|".join(bn.ENGLISH_MONTHS)})\\s*,?\\s+({NUM}{{4}})')
DOTTED_DATE = re.compile(f'(?<![0-9০-৯.])({NUM}{{1,2}})[./-]({NUM}{{1,2}})[./-]({NUM}{{4}})(?![0-9০-৯]|\\.[0-9০-৯])')
LATIN_DIGITS = re.compile(r'\S*[0-9]\S*')
SKIP_TOKEN = re.compile(r'[A-Za-z@/\\]')
VISARGA_LABEL = re.compile(r'^(বিষয়|তারিখ|সূত্র|প্রাপক|স্মারক নং|নং)ঃ')

TITLES = {
    'order': 'অফিস আদেশ', 'circular': 'পরিপত্র', 'notification': 'প্রজ্ঞাপন', 'notice': 'বিজ্ঞপ্তি',
    'meeting': 'সভার নোটিশ', 'noc': 'অনাপত্তি', 'certificate': 'প্রত্যয়ন', 'minutes': 'কার্যবিবরণী',
}
NEEDS_SUBJECT = {'letter', 'memo', 'circular', 'notice', 'meeting'}
NO_SUBJECT = {'order', 'notification', 'do'}
NO_SALUTATION = {'memo', 'order', 'circular', 'notification', 'notice', 'meeting'}
TYPES = set(TITLES) | {'letter', 'memo', 'do'}


def paragraphs(path):
    """The document's paragraphs (tables included, in order) as NFC text, no-break spaces as spaces."""
    path = Path(path)
    if path.suffix.lower() == '.docx':
        with zipfile.ZipFile(path) as package:
            root = etree.fromstring(package.read('word/document.xml'))
        texts = [''.join(t.text or '' for t in p.iter(f'{W}t')) for p in root.iter(f'{W}p')]
    elif path.suffix.lower() in ('.txt', '.md'):
        texts = path.read_text(encoding='utf-8').splitlines()
    else:
        raise ValueError(f'unsupported file type: {path.suffix} (use .docx, .txt or .md)')
    return [unicodedata.normalize('NFC', text).replace('\u00a0', ' ').strip() for text in texts]


def as_date(match, months):
    day, month, year = match.groups()
    try:
        return date(int(bn.latin(year)), months.index(month) + 1, int(bn.latin(day)))
    except ValueError:
        return None


def bangla_matches(match, day):
    number, month, year = bn.bangla_parts(day)
    return (int(bn.latin(match.group(1))), match.group(2), int(bn.latin(match.group(3)))) == (
        number, bn.BANGLA_MONTHS[month], year)


def date_findings(texts):
    english = [(i, m) for i, t in enumerate(texts) for m in ENGLISH_DATE.finditer(t)]
    findings = []
    for i, text in enumerate(texts):
        for match in BANGLA_DATE.finditer(text):
            near = [(abs(j - i), m) for j, m in english if abs(j - i) <= 2]
            if not near:
                continue
            day = as_date(min(near, key=lambda pair: pair[0])[1], bn.ENGLISH_MONTHS)
            if day and not bangla_matches(match, day):
                findings.append(finding('date', match.group(0),
                                        f'{bn.english_date(day)} is {bn.bangla_date(day)}'))
    return findings


def meeting_findings(texts):
    issued = next((as_date(m, bn.ENGLISH_MONTHS) for t in texts for m in ENGLISH_DATE.finditer(t)), None)
    if issued is None:
        return []
    start = next((i for i, t in enumerate(texts) if 'সভার নোটিশ' in t), 0)
    findings = []
    for text in texts[start + 1:]:
        for match in DOTTED_DATE.finditer(text):
            day, month, year = (int(bn.latin(g)) for g in match.groups())
            try:
                held = date(year, month, day)
            except ValueError:
                continue
            if held < issued:
                findings.append(finding('date', match.group(0),
                                        f'the meeting is dated before the notice ({bn.english_date(issued)})'))
    return findings


def structure_findings(texts, kind):
    starts = lambda *prefixes: any(t.startswith(prefixes) for t in texts)  # noqa: E731
    contains = lambda word: any(word in t for t in texts)  # noqa: E731
    missing = []
    if kind in TITLES and not contains(TITLES[kind]):
        missing.append(f'the title "{TITLES[kind]}"')
    if kind not in ('certificate', 'minutes') and not starts('নম্বর', 'স্মারক', 'নং', 'আধা-সরকারি পত্র নম্বর'):
        missing.append('the number line (নম্বর:)')
    if not contains('তারিখ'):
        missing.append('the date line (তারিখ:)')
    if kind in NEEDS_SUBJECT and not starts('বিষয়'):
        missing.append('the বিষয় line')
    if kind == 'letter' and not contains('বিশ্বস্ত'):
        missing.append('the closing "আপনার বিশ্বস্ত,"')
    if kind == 'do' and not contains('আন্তরিকভাবে আপনার'):
        missing.append('the closing "আন্তরিকভাবে আপনার,"')
    findings = [finding('structure', item, f'add {item}') for item in missing]
    if kind in NO_SUBJECT and starts('বিষয়'):
        findings.append(finding('structure', 'বিষয়', f'a {kind} has no বিষয় line: move it into the body'))
    if kind in NO_SALUTATION:
        for text in texts:
            if re.fullmatch(r'(প্রিয় )?(মহোদয়|জনাব|মহোদয়গণ)\s*,?', text) or text.startswith('আপনার বিশ্বস্ত'):
                findings.append(finding('structure', text, f'a {kind} has no salutation or courtesy close'))
    if kind == 'notification' and not contains('আদেশক্রমে'):
        findings.append(note('structure', 'আদেশক্রমে',
                             'a government প্রজ্ঞাপন is signed "রাষ্ট্রপতির আদেশক্রমে,"'))
    if not (contains('ফোন') and contains('ই-মেইল')):
        findings.append(note('contact', 'ফোন / ই-মেইল', 'SI-2024 requires phone and e-mail under the signature'))
    return findings


def text_findings(texts):
    findings, sadhu, chalit = [], [], []
    for text in texts:
        for match in SPELLING_WORD.finditer(text):
            findings.append(finding('spelling', match.group(1), SPELLING[match.group(1)]))
        if VISARGA_LABEL.match(text):
            findings.append(note('visarga', text[:20], 'use a colon after the label'))
        if BANGLA.search(text):
            for token in LATIN_DIGITS.findall(text):
                if not SKIP_TOKEN.search(token):
                    findings.append(note('digits', token, bn.digits(token)))
        sadhu += SADHU_WORD.findall(text)
        chalit += CHALIT_WORD.findall(text)
    if sadhu and chalit:
        findings.append(note('register', f'{", ".join(sorted(set(sadhu))[:5])} / {", ".join(sorted(set(chalit))[:5])}',
                             'use চলিত throughout (হলো, হবে, করা হলো)'))
    return findings


def finding(check, text, fix):
    return {'check': check, 'text': text, 'fix': fix, 'level': 'defect'}


def note(check, text, fix):
    return {'check': check, 'text': text, 'fix': fix, 'level': 'note'}


def findings_for(texts, kind):
    found = text_findings(texts) + date_findings(texts)
    if kind:
        found += structure_findings(texts, kind)
    if kind == 'meeting':
        found += meeting_findings(texts)
    return found


def check(path, kind=None, original=None):
    if kind and kind not in TYPES:
        raise ValueError(f'type must be one of {", ".join(sorted(TYPES))}')
    found = findings_for(paragraphs(path), kind)
    if original:
        before = {(f['check'], f['text']) for f in findings_for(paragraphs(original), kind)}
        for item in found:
            if (item['check'], item['text']) in before:
                item['level'] = 'note'
                item['fix'] += ' (already in the original)'
    defects = [f for f in found if f['level'] == 'defect']
    notes = [f for f in found if f['level'] == 'note']
    return {'status': 'defects_found' if defects else 'clean', 'defects': defects, 'notes': notes}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('file', type=Path)
    parser.add_argument('--type', choices=sorted(TYPES))
    parser.add_argument('--original', type=Path)
    args = parser.parse_args()
    try:
        for path in (args.file, args.original):
            if path is not None and not path.is_file():
                raise ValueError(f'File not found: {path}')
        result = check(args.file, args.type, args.original)
    except (ValueError, KeyError, zipfile.BadZipFile, etree.XMLSyntaxError) as error:
        print(json.dumps({'error': str(error)}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result['status'] == 'clean' else 2


if __name__ == '__main__':
    sys.exit(main())
