"""Tests for skill/govdoc/scripts/bn.py: digits, grouping, number words, dates, file numbers.

Pure Python, run anywhere:
    python -m pytest tests/skill/govdoc
"""
import sys
from datetime import date
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'skill' / 'govdoc' / 'scripts'))
import bn  # noqa: E402

# Dates printed on real documents: the SI-2024 samples, a 2024 Gazette, 2026 newspaper mastheads.
PRINTED = [
    ((2021, 5, 27), '২৭ মে ২০২১', '১৩ জ্যৈষ্ঠ ১৪২৮'),
    ((2023, 4, 30), '৩০ এপ্রিল ২০২৩', '১৭ বৈশাখ ১৪৩০'),
    ((2023, 6, 19), '১৯ জুন ২০২৩', '০৫ আষাঢ় ১৪৩০'),
    ((2024, 6, 6), '০৬ জুন ২০২৪', '২৩ জ্যৈষ্ঠ ১৪৩১'),
    ((2024, 8, 1), '০১ আগস্ট ২০২৪', '১৭ শ্রাবণ ১৪৩১'),
    ((2026, 8, 4), '০৪ আগস্ট ২০২৬', '২০ শ্রাবণ ১৪৩৩'),
    ((2026, 9, 9), '০৯ সেপ্টেম্বর ২০২৬', '২৫ ভাদ্র ১৪৩৩'),
]


@pytest.mark.parametrize('ymd, english, bangla', PRINTED)
def test_dates_printed_on_real_documents(ymd, english, bangla):
    day = date(*ymd)
    assert bn.english_date(day) == english
    assert bn.bangla_date(day) == bangla


@pytest.mark.parametrize('ymd, bangla', [
    ((2026, 4, 14), '০১ বৈশাখ ১৪৩৩'),
    ((2026, 4, 13), '৩০ চৈত্র ১৪৩২'),
    ((2025, 12, 16), '০১ পৌষ ১৪৩২'),
    ((2026, 1, 5), '২১ পৌষ ১৪৩২'),
    ((2026, 2, 21), '০৮ ফাল্গুন ১৪৩২'),
    ((2026, 3, 26), '১২ চৈত্র ১৪৩২'),
    ((2024, 3, 14), '৩০ ফাল্গুন ১৪৩০'),
    ((2025, 3, 14), '২৯ ফাল্গুন ১৪৩১'),
    ((2026, 10, 21), '০৫ কার্তিক ১৪৩৩'),
])
def test_fixed_days_and_leap_year(ymd, bangla):
    assert bn.bangla_date(date(*ymd)) == bangla


def test_every_day_of_two_years_advances_by_one():
    day = date(2024, 1, 1)
    previous = bn.bangla_parts(day)
    while day < date(2026, 1, 1):
        day = date.fromordinal(day.toordinal() + 1)
        current = bn.bangla_parts(day)
        assert current[0] == previous[0] + 1 or (current[0] == 1 and current[1] == (previous[1] + 1) % 12)
        previous = current


def test_suffixes():
    day = date(2026, 10, 21)
    assert bn.bangla_date(day, suffix=True) == '০৫ কার্তিক ১৪৩৩ বঙ্গাব্দ'
    assert bn.english_date(day, suffix=True) == '২১ অক্টোবর ২০২৬ খ্রিষ্টাব্দ'
    assert bn.parse_date('২০২৬-১০-২১') == day


@pytest.mark.parametrize('number, text', [
    (0, '০'), (500, '৫০০'), (1000, '১,০০০'), (100000, '১,০০,০০০'), (1234567, '১২,৩৪,৫৬৭'),
    (123456789, '১২,৩৪,৫৬,৭৮৯'), (-12345, '-১২,৩৪৫'),
])
def test_lakh_grouping(number, text):
    assert bn.group(number) == text


def test_grouping_with_decimals():
    assert bn.group(1250000.5, 2) == '১২,৫০,০০০.৫০'


@pytest.mark.parametrize('number, text', [
    (0, 'শূন্য'), (19, 'উনিশ'), (29, 'ঊনত্রিশ'), (99, 'নিরানব্বই'), (100, 'একশত'),
    (500, 'পাঁচশত'), (105, 'একশত পাঁচ'), (12500, 'বারো হাজার পাঁচশত'), (100000, 'এক লক্ষ'),
    (1234567, 'বারো লক্ষ চৌত্রিশ হাজার পাঁচশত সাতষট্টি'), (10000000, 'এক কোটি'),
    (250000000, 'পঁচিশ কোটি'), (1000000000, 'একশত কোটি'),
])
def test_words(number, text):
    assert bn.words(number) == text


def test_units_table_is_complete():
    assert len(bn.UNITS) == 100 and len(set(bn.UNITS)) == 100


def test_taka():
    assert bn.taka(12500) == 'বারো হাজার পাঁচশত টাকা মাত্র'
    assert bn.taka(12500.5) == 'বারো হাজার পাঁচশত টাকা পঞ্চাশ পয়সা মাত্র'


def test_digits_round_trip():
    assert bn.digits('02-9549621') == '০২-৯৫৪৯৬২১'
    assert bn.latin('০৫.৪৩') == '05.43'


def test_file_number_digital():
    assert bn.file_number('04.00.0000.000.416.99.0007.26', 465) == '০৪.০০.০০০০.০০০.৪১৬.৯৯.০০০৭.২৬.৪৬৫'
    assert bn.check_file_number('০৪.০০.০০০০.০০০.৪১৬.৯৯.০০০৭.২৬.৪৬৫') == []


def test_file_number_keeps_an_existing_issue_number():
    assert bn.file_number('০৪.০০.০০০০.০০০.৪১৬.৯৯.০০০৭.২৬.৪৬৫', 1) == '০৪.০০.০০০০.০০০.৪১৬.৯৯.০০০৭.২৬.৪৬৫'
    assert bn.file_number('০৫.০০.০০০০.১২৩.০২.০৪৮.২১-১৩৭', 1) == '০৫.০০.০০০০.১২৩.০২.০৪৮.২১-১৩৭'


def test_file_number_older_format_gets_a_hyphen():
    assert bn.file_number('05.00.0000.123.02.048.21', 137) == '০৫.০০.০০০০.১২৩.০২.০৪৮.২১-১৩৭'
    assert bn.check_file_number('০৫.০০.০০০০.১২৩.০২.০৪৮.২১-১৩৭') == ['not a digital file number']


def test_file_number_segment_widths():
    assert bn.check_file_number('4.00.0000.000.416.99.0007.26') == [
        'segment 1 (মন্ত্রণালয়/বিভাগ) has 1 digits, expected 2']


def test_file_number_placeholder():
    assert bn.file_number(None) == bn.PLACEHOLDER
