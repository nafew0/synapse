#!/usr/bin/env python3
"""Bangla numbers, dates and file numbers for Bangladesh government documents.

    digits('2026')                 -> '২০২৬'
    latin('০৫.৪৩')                 -> '05.43'
    group(1234567)                 -> '১২,৩৪,৫৬৭'
    words(12500)                   -> 'বারো হাজার পাঁচশত'
    taka(12500.5)                  -> 'বারো হাজার পাঁচশত টাকা পঞ্চাশ পয়সা মাত্র'
    bangla_date(date(2026,10,21))  -> '০৫ কার্তিক ১৪৩৩'
    english_date(date(2026,10,21)) -> '২১ অক্টোবর ২০২৬'
    file_number('04.00.0000.000.416.99.0007.26', 465) -> '০৪.০০.০০০০.০০০.৪১৬.৯৯.০০০৭.২৬.৪৬৫'

The Bangla calendar is the 2019 Bangla Academy revision: বৈশাখ to আশ্বিন have 31 days, ফাল্গুন
29 (30 in a Gregorian leap year), the rest 30, and ১ বৈশাখ is always 14 April. Every Bangla
month therefore starts on the same Gregorian day each year.

Run it to print today's date line, or a given date's:
    python3 bn.py [YYYY-MM-DD]
"""
import re
import sys
from datetime import date

BANGLA_DIGITS = '০১২৩৪৫৬৭৮৯'
TO_BANGLA = str.maketrans('0123456789', BANGLA_DIGITS)
TO_LATIN = str.maketrans(BANGLA_DIGITS, '0123456789')

BANGLA_MONTHS = ('বৈশাখ', 'জ্যৈষ্ঠ', 'আষাঢ়', 'শ্রাবণ', 'ভাদ্র', 'আশ্বিন',
                 'কার্তিক', 'অগ্রহায়ণ', 'পৌষ', 'মাঘ', 'ফাল্গুন', 'চৈত্র')
ENGLISH_MONTHS = ('জানুয়ারি', 'ফেব্রুয়ারি', 'মার্চ', 'এপ্রিল', 'মে', 'জুন',
                  'জুলাই', 'আগস্ট', 'সেপ্টেম্বর', 'অক্টোবর', 'নভেম্বর', 'ডিসেম্বর')

# (Gregorian month, day) on which each Bangla month starts, in Bangla month order.
MONTH_STARTS = ((4, 14), (5, 15), (6, 15), (7, 16), (8, 16), (9, 16),
                (10, 17), (11, 16), (12, 16), (1, 15), (2, 14), (3, 15))

UNITS = (
    'শূন্য', 'এক', 'দুই', 'তিন', 'চার', 'পাঁচ', 'ছয়', 'সাত', 'আট', 'নয়',
    'দশ', 'এগারো', 'বারো', 'তেরো', 'চৌদ্দ', 'পনেরো', 'ষোলো', 'সতেরো', 'আঠারো', 'উনিশ',
    'বিশ', 'একুশ', 'বাইশ', 'তেইশ', 'চব্বিশ', 'পঁচিশ', 'ছাব্বিশ', 'সাতাশ', 'আটাশ', 'ঊনত্রিশ',
    'ত্রিশ', 'একত্রিশ', 'বত্রিশ', 'তেত্রিশ', 'চৌত্রিশ', 'পঁয়ত্রিশ', 'ছত্রিশ', 'সাঁইত্রিশ', 'আটত্রিশ', 'ঊনচল্লিশ',
    'চল্লিশ', 'একচল্লিশ', 'বিয়াল্লিশ', 'তেতাল্লিশ', 'চুয়াল্লিশ', 'পঁয়তাল্লিশ', 'ছেচল্লিশ', 'সাতচল্লিশ', 'আটচল্লিশ', 'ঊনপঞ্চাশ',
    'পঞ্চাশ', 'একান্ন', 'বাহান্ন', 'তিপ্পান্ন', 'চুয়ান্ন', 'পঞ্চান্ন', 'ছাপ্পান্ন', 'সাতান্ন', 'আটান্ন', 'ঊনষাট',
    'ষাট', 'একষট্টি', 'বাষট্টি', 'তেষট্টি', 'চৌষট্টি', 'পঁয়ষট্টি', 'ছেষট্টি', 'সাতষট্টি', 'আটষট্টি', 'ঊনসত্তর',
    'সত্তর', 'একাত্তর', 'বাহাত্তর', 'তিয়াত্তর', 'চুয়াত্তর', 'পঁচাত্তর', 'ছিয়াত্তর', 'সাতাত্তর', 'আটাত্তর', 'ঊনআশি',
    'আশি', 'একাশি', 'বিরাশি', 'তিরাশি', 'চুরাশি', 'পঁচাশি', 'ছিয়াশি', 'সাতাশি', 'আটাশি', 'ঊননব্বই',
    'নব্বই', 'একানব্বই', 'বিরানব্বই', 'তিরানব্বই', 'চুরানব্বই', 'পঁচানব্বই', 'ছিয়ানব্বই', 'সাতানব্বই', 'আটানব্বই', 'নিরানব্বই',
)
SCALES = ((10_000_000, 'কোটি'), (100_000, 'লক্ষ'), (1_000, 'হাজার'))

# Segment widths of the 22-digit digital file number (সচিবালয় নির্দেশমালা ২০২৪, নির্দেশ ৪২).
FILE_SEGMENTS = (2, 2, 4, 3, 3, 2, 4, 2)
FILE_SEGMENT_NAMES = ('মন্ত্রণালয়/বিভাগ', 'দপ্তর/অধিদপ্তর', 'জিও', 'অধস্তন প্রতিষ্ঠান',
                      'শাখা', 'বিষয়', 'নথির ক্রমিক', 'নথি খোলার সন')
FILE_NUMBER = re.compile(r'^([0-9০-৯]+(?:\.[0-9০-৯]+){7})(?:[.\-]([0-9০-৯]+(?:\([0-9০-৯/]+\))?))?$')
PLACEHOLDER = '…' * 24


def digits(value):
    """Latin digits in `value` (any type) as Bangla digits."""
    return str(value).translate(TO_BANGLA)


def latin(text):
    """Bangla digits in `text` as Latin digits."""
    return str(text).translate(TO_LATIN)


def group(number, decimals=None):
    """Indian grouping in Bangla digits: 1234567.5 -> '১২,৩৪,৫৬৭.৫০' with decimals=2."""
    sign = '-' if number < 0 else ''
    text = f'{abs(number):.{decimals}f}' if decimals is not None else str(abs(number))
    whole, _, fraction = text.partition('.')
    head, tail = whole[:-3], whole[-3:]
    pairs = []
    while head:
        pairs.insert(0, head[-2:])
        head = head[:-2]
    grouped = ','.join(pairs + [tail])
    return digits(sign + grouped + ('.' + fraction if fraction else ''))


def _below_thousand(n):
    hundreds, rest = divmod(n, 100)
    parts = [UNITS[hundreds] + 'শত'] if hundreds else []
    if rest:
        parts.append(UNITS[rest])
    return ' '.join(parts)


def words(number):
    """A whole number in Bangla words, with শত, হাজার, লক্ষ and কোটি: 12500 -> 'বারো হাজার পাঁচশত'."""
    number = int(number)
    if number < 0:
        return 'ঋণাত্মক ' + words(-number)
    if number == 0:
        return UNITS[0]
    parts = []
    crores, number = divmod(number, 10_000_000)
    if crores:
        parts.append(words(crores) + ' কোটি')
    for size, name in SCALES[1:]:
        count, number = divmod(number, size)
        if count:
            parts.append(UNITS[count] + ' ' + name)
    if number:
        parts.append(_below_thousand(number))
    return ' '.join(parts)


def taka(amount):
    """An amount of money in words, ending in 'মাত্র': 12500.5 -> '... টাকা পঞ্চাশ পয়সা মাত্র'."""
    paisa_total = round(float(amount) * 100)
    whole, paisa = divmod(paisa_total, 100)
    text = words(whole) + ' টাকা'
    if paisa:
        text += ' ' + words(paisa) + ' পয়সা'
    return text + ' মাত্র'


def bangla_year(day):
    return day.year - 593 if (day.month, day.day) >= (4, 14) else day.year - 594


def bangla_parts(day):
    """(day, month index 0-11, year) of `day` in the revised Bangla calendar."""
    first, index = max(
        (date(year, month, start), i)
        for year in (day.year - 1, day.year)
        for i, (month, start) in enumerate(MONTH_STARTS)
        if date(year, month, start) <= day
    )
    return (day - first).days + 1, index, bangla_year(day)


def bangla_date(day, suffix=False):
    """'০৫ কার্তিক ১৪৩৩', or with suffix '০৫ কার্তিক ১৪৩৩ বঙ্গাব্দ'."""
    number, month, year = bangla_parts(day)
    text = f'{digits(f"{number:02d}")} {BANGLA_MONTHS[month]} {digits(year)}'
    return text + ' বঙ্গাব্দ' if suffix else text


def english_date(day, suffix=False):
    """'২১ অক্টোবর ২০২৬', or with suffix '২১ অক্টোবর ২০২৬ খ্রিষ্টাব্দ'."""
    text = f'{digits(f"{day.day:02d}")} {ENGLISH_MONTHS[day.month - 1]} {digits(day.year)}'
    return text + ' খ্রিষ্টাব্দ' if suffix else text


def parse_date(text):
    """A date from 'YYYY-MM-DD' in Latin or Bangla digits."""
    return date.fromisoformat(latin(text.strip()))


def file_number(number=None, issue=None):
    """A memo number in Bangla digits; a dotted placeholder when `number` is empty.

    `number` is the file number as given, in any digits. A 22-digit digital file number gets the
    issue number after a dot, an older format after a hyphen (…২১-১৩৭), unless it already ends
    in one.
    """
    if not number:
        return PLACEHOLDER
    text = digits(number.strip())
    match = FILE_NUMBER.match(text)
    if issue is None or (match and match.group(2)) or re.search(r'-[০-৯]+$', text):
        return text
    return text + ('.' if check_file_number(text) == [] else '-') + digits(issue)


def check_file_number(text):
    """Problems with a 22-digit digital file number; [] when it is well formed.

    Returns ['not a digital file number'] for older formats, which are allowed but not checked.
    """
    match = FILE_NUMBER.match(text.strip())
    if not match:
        return ['not a digital file number']
    segments = match.group(1).split('.')
    return [
        f'segment {i + 1} ({FILE_SEGMENT_NAMES[i]}) has {len(seg)} digits, expected {width}'
        for i, (seg, width) in enumerate(zip(segments, FILE_SEGMENTS))
        if len(seg) != width
    ]


def main():
    day = parse_date(sys.argv[1]) if len(sys.argv) > 1 else date.today()
    print(bangla_date(day, suffix=True))
    print(english_date(day, suffix=True))
    return 0


if __name__ == '__main__':
    sys.exit(main())
