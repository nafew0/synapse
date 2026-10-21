---
name: govdoc
description: "Use this skill whenever the user wants to draft, prepare, format, check or edit a Bangladesh government or institutional office document in Bangla: সরকারি পত্র (official letter), অফিস স্মারক (memo), অফিস আদেশ (office order), পরিপত্র (circular), প্রজ্ঞাপন (notification), বিজ্ঞপ্তি/নোটিশ (notice), সভার নোটিশ (meeting notice), সভার কার্যবিবরণী (minutes), আধা-সরকারি/ডি.ও. পত্র (DO letter), অনাপত্তি সনদ (NOC) or প্রত্যয়নপত্র (certificate), for a ministry, directorate, district office, university, board or other public body. Also use it for the parts these documents share: স্মারক/নথি নম্বর, the বঙ্গাব্দ + খ্রিষ্টাব্দ date line, বিষয়/সূত্র, signature block, বিতরণ and অনুলিপি lists, Bangla numerals, amounts in words (কথায়: … টাকা মাত্র) and প্রমিত spelling. Use it together with the docx skill when the result is a Word or PDF file."
---

# Bangladesh government documents (দাপ্তরিক পত্র)

The formats are the ক্রোড়পত্র templates of **সচিবালয় নির্দেশমালা ২০২৪** (Ministry of Public
Administration, June 2024; it replaced the 2014 edition). Offices outside the Secretariat (field
offices, universities, autonomous bodies) are allowed to use them, and do.

> Script paths below are relative to this skill's directory: `/mnt/data/skills/govdoc/`.

## 1. Pick the type

| The user wants to… | Type | `type` |
|---|---|---|
| convey a sanction, approval or government decision to an agency, field office, court, person | সরকারি পত্র | `letter` |
| write to a higher office or another ministry, send information, reply to a letter or application | অফিস স্মারক | `memo` |
| post, transfer, give leave or duties to staff inside the office; office instructions | অফিস আদেশ | `order` |
| send the same instruction or rule change to many offices | পরিপত্র | `circular` |
| publish a rule, order, or gazetted officer's appointment/transfer in the Gazette | প্রজ্ঞাপন | `notification` |
| announce, invite applications, inform the public or staff | বিজ্ঞপ্তি | `notice` |
| call a meeting | সভার নোটিশ | `meeting` |
| record a meeting's decisions | সভার কার্যবিবরণী | `minutes` |
| a personal letter between officers to get the recipient's personal attention | আধা-সরকারি পত্র | `do` |
| state that the office has no objection (passport, travel, study) | অনাপত্তি সনদ | `noc` |
| certify a person's service, conduct or enrolment | প্রত্যয়নপত্র | `certificate` |

When two fit, read the differences in `formats.md` ("Choosing between types"). A body that is
not a government department (a university, BdREN, a board) never issues a প্রজ্ঞাপন "রাষ্ট্রপতির
আদেশক্রমে"; it uses অফিস আদেশ, বিজ্ঞপ্তি or পরিপত্র under its own authority.

## 2. Get the details — never invent them

Ask with `ask_user_question` (one round, at most three questions) for what you cannot take from
the user's message or files. Essential:
- **Issuing office**: the letterhead lines (office, wing/branch, website).
- **Signer**: name, designation, and phone and e-mail (both are mandatory on official letters).
- **Recipient** (letter, memo, DO) or **distribution** (circular, notice, meeting).

Never make these up: স্মারক/নথি নম্বর codes, পরিচিতি নম্বর, gazette or S.R.O. numbers, names,
phone numbers, e-mail addresses, dates of earlier letters cited in সূত্র. Without a number, leave
`number` out: the document gets a dotted line the office fills in (that is how their own
drafts look before issue). Date: today unless the user gives one.

Do not add campaign logos or slogans (বর্ষ logos, "জয় বাংলা"…) unless the user asks or sends
the logo: which one is required changes by circular, and a wrong one is worse than none.

## 3. Build the file

Invoke the **docx** skill as well (the builder uses its Bangla fix and check scripts), then
write a spec and build:

```bash
mkdir -p /mnt/data/qa && cat > /mnt/data/qa/spec.json <<'EOF'
{ ...spec... }
EOF
python3 /mnt/data/skills/govdoc/scripts/build.py /mnt/data/qa/spec.json /mnt/data/<name>.docx
```

Use `.pdf` as the output name when the user wants a PDF: the checked DOCX stays in qa/ and
the PDF is delivered. The script sets Nikosh 13 pt (letterhead 15 pt bold), A4, the layout of
the type, Bangla digits, the date pair, then runs `fix_bangla.py --new`, `check.py` and
`verify_bangla.py` (render + OCR). It prints JSON; deliver only on `"status": "clean"`. On
`defects_found`, fix the spec (or the text) as each finding says and run it again.

### Spec

```json
{
  "type": "memo",
  "date": "2026-10-21",
  "letterhead": ["গণপ্রজাতন্ত্রী বাংলাদেশ সরকার", "শিক্ষা মন্ত্রণালয়", "মাধ্যমিক ও উচ্চ শিক্ষা বিভাগ",
                 "আইসিটি শাখা", "www.moedu.gov.bd"],
  "number": "37.00.0000.000.071.99.0012.26",
  "issue": 214,
  "subject": "শিক্ষা প্রতিষ্ঠানে সংযোগের তথ্য হালনাগাদ প্রসঙ্গে।",
  "references": ["বিডিআরইএন-এর ১২ অক্টোবর ২০২৬ তারিখের পত্র।"],
  "body": [
    "উপর্যুক্ত বিষয় ও সূত্রের পরিপ্রেক্ষিতে জানানো যাচ্ছে যে, …।",
    {"items": ["প্রথম শর্ত …;", "দ্বিতীয় শর্ত …।"]},
    {"table": [["ক্রমিক", "প্রতিষ্ঠান", "সংযোগ"], ["১", "…", "…"]]},
    "এমতাবস্থায়, … প্রেরণের জন্য নির্দেশক্রমে অনুরোধ করা হলো।"
  ],
  "attachments": ["তথ্য ছক (০১ পাতা)।"],
  "signer": {"name": "…", "id": "15088", "designation": "উপসচিব", "phone": "…", "email": "…"},
  "to": ["নির্বাহী পরিচালক", "বাংলাদেশ রিসার্চ অ্যান্ড এডুকেশন নেটওয়ার্ক", "আগারগাঁও, ঢাকা।"],
  "copies": ["সচিবের একান্ত সচিব, … (সচিব মহোদয়ের সদয় অবগতির জন্য)।", "সংরক্ষণ নথি।"]
}
```

| Key | Meaning |
|---|---|
| `type` | one of the types above (required) |
| `letterhead` | centred header lines; the first is bold. Omit only for `do` |
| `number`, `issue` | the file number and issue number, any digits; a 22-digit number gets `.issue`, an older one `-issue`. Omit both for a dotted placeholder |
| `date` | `YYYY-MM-DD`, default today; `""` for a blank date line; `date_suffix: true` adds বঙ্গাব্দ/খ্রিষ্টাব্দ |
| `priority` | `"জরুরি"`, `"অবিলম্বে"`, `"সর্বোচ্চ অগ্রাধিকার"`: printed top right |
| `to` | recipient lines: top for `letter`, bottom left for `memo` and `do` |
| `subject`, `references` | বিষয় (required for letter, memo, circular, notice, meeting; refused for order, notification, do) and সূত্র lines |
| `salutation`, `closing`, `authority`, `regards` | override the type's defaults (`মহোদয়,`, `আপনার বিশ্বস্ত,`, `রাষ্ট্রপতির আদেশক্রমে,` …). For a university order: `"authority": "উপাচার্য মহোদয়ের অনুমোদনক্রমে,"` |
| `body` | strings are paragraphs (the 2nd onward numbered ২।, ৩।…); `{"items": [...]}` a (ক), (খ) list; `{"table": [[header…], [row…]]}` a ruled table |
| `numbered` | `false` to stop paragraph numbers (default false for noc, certificate, minutes) |
| `meta` | `[["সভাপতি", "…"], ["তারিখ", "…"], ["স্থান", "…"]]` lines under the title (minutes) |
| `attachments` | সংযুক্তি |
| `signer` | `name`, `id` (পরিচিতি নম্বর), `designation`, `office`, `phone`, `email` |
| `sender` | `do` only: the top-right block; defaults to `signer` |
| `distribution`, `distribution_heading` | বিতরণ list (circular, notice, meeting) |
| `copies`, `copies_heading`, `copy_number` | অনুলিপি list, repeated number/date line above it |
| `footer` | footer text (SI-2024 asks for the file name and path) |

Write the text in the spec exactly as it should read: the script does not reword anything.
Latin digits in the text become Bangla, except in e-mail addresses and URLs.

## 4. Editing or checking an existing document

Edit with the docx skill (inside the existing runs; keep the office's fonts and layout), then
check the result against the original:

```bash
python3 /mnt/data/skills/govdoc/scripts/check.py /mnt/data/out.docx --type memo --original /mnt/data/in.docx
python3 /mnt/data/skills/docx/scripts/office/verify_bangla.py /mnt/data/out.docx --original /mnt/data/in.docx
```

`check.py` reports structure (a part the type needs or forbids), date pairs that are not the
same day, a meeting dated before its notice, and non-standard spellings as defects; Latin digits,
mixed সাধু/চলিত, a missing phone/e-mail and `বিষয়ঃ` as notes. Faults the original already had
are notes only: do not "fix" the rest of the user's document unasked. It also reads `.txt`/`.md`.

When asked to review a document, run `check.py` and answer with its findings in plain words,
plus anything from `formats.md` the document gets wrong.

## 5. Text only (no file)

When the user wants the text in chat (to paste into D-Nothi, an e-mail or their own template),
write it in the type's order from `formats.md` and use the helpers for dates and numbers:

```bash
python3 /mnt/data/skills/govdoc/scripts/bn.py 2026-10-21          # ০৫ কার্তিক ১৪৩৩ বঙ্গাব্দ / ২১ অক্টোবর ২০২৬ খ্রিষ্টাব্দ
python3 -c "import sys; sys.path.insert(0, '/mnt/data/skills/govdoc/scripts'); import bn; print(bn.group(1250000), bn.taka(1250000))"
# ১২,৫০,০০০ বারো লক্ষ পঞ্চাশ হাজার টাকা মাত্র
```

Text for D-Nothi needs only বিষয়, সূত্র, body, recipients and অনুলিপি: the system adds the
header, number, date and signature.

## 6. Language

- **Bangla**, as the বাংলা ভাষা প্রচলন আইন ১৯৮৭ requires for all official correspondence except
  with foreign parties. English only when the user asks or the recipient is abroad.
- **চলিত** throughout (করা হলো, জানানো যাচ্ছে, হবে). Never mix with সাধু (করা হইল, হইবে) in
  one document; when editing a সাধু document, keep its সাধু.
- **প্রমিত spelling**: সরকারি, বেসরকারি, জানুয়ারি, ফেব্রুয়ারি, খ্রিষ্টাব্দ, শ্রেণি, উপর্যুক্ত,
  ইতোমধ্যে, উল্লিখিত, চাকরি. More in `formats.md`.
- **Bangla digits** everywhere in Bangla text, including numbers, dates and phone numbers.
- **Money**: `৳` or "টাকা" with lakh grouping, then the words: `১২,৫০,০০০/- (কথায়: বারো লক্ষ
  পঞ্চাশ হাজার টাকা মাত্র)`, from `bn.group` and `bn.taka`.
- **Government decisions are impersonal**: "সরকার … সিদ্ধান্ত গ্রহণ করেছে", never "মাননীয়
  প্রধানমন্ত্রী সিদ্ধান্ত নিয়েছেন".
- Concise, no repetition; the first paragraph states the matter; later paragraphs are numbered.

Tell the user, in one line, what they still have to fill in (number, signature, logo).
