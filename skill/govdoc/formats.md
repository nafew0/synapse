# Formats reference

Source: সচিবালয় নির্দেশমালা ২০২৪ (SI-2024), নির্দেশ ১৩৩–১৫০ and ক্রোড়পত্র ১৬–২৬(খ), read from the
official PDF. Items marked *(practice)* have no official template; they follow what offices
commonly issue.

## Shared parts

**Letterhead** (centred): `গণপ্রজাতন্ত্রী বাংলাদেশ সরকার` / মন্ত্রণালয় বা বিভাগ / অনুবিভাগ, অধিশাখা বা
শাখা / `www.---.gov.bd`. A field office puts its office and district instead of the ministry. A
university or autonomous body uses its own name (and logo), with no "গণপ্রজাতন্ত্রী…" line
unless it is a government department.

**Number line**: label on the left, date on the right of the same line.
- Labels: `নম্বর:` (পত্র, আদেশ, পরিপত্র, প্রজ্ঞাপন, বিজ্ঞপ্তি), `স্মারক নম্বর:` (অফিস স্মারক and
  the copy line of a প্রজ্ঞাপন), `আধা-সরকারি পত্র নম্বর:` (DO). Offices often write `নং`/`স্মারক নং`.
- **22-digit digital file number** (নির্দেশ ৪২): `মন্ত্রণালয়(২).দপ্তর(২).জিও(৪).অধস্তন প্রতিষ্ঠান(৩).শাখা(৩).বিষয়(২).নথি ক্রমিক(৪).সন(২)`
  then `.জারি নম্বর`. Unused codes are zeros, no position is dropped; the file serial restarts at
  ০০০১ each 1 January. Example (Cabinet Division, 2026): `০৪.০০.০০০০.০০০.৪১৬.৯৯.০০০৭.২৬.৪৬৫`.
  Older numbers look like `০৫.০০.০০০০.১২৩.০২.০৪৮.২১-১৩৭`. Copies take a sub-number:
  `…২১-১৩৭(১/৯)` = copy 1 of 9.
- Nobody outside the office knows its codes: take the number from the user or leave it blank.

**Date** (every ক্রোড়পত্র): "তারিখ লিখিবার ক্ষেত্রে উপরে বাংলা সন এবং নিচে খ্রিষ্টীয় সন". In letters
the two are stacked beside `তারিখ:` (`০৫ কার্তিক ১৪৩৩` over `২১ অক্টোবর ২০২৬`); a Gazette prints
one line: `তারিখ : ১৭ শ্রাবণ ১৪৩১ বঙ্গাব্দ/০১ আগস্ট ২০২৪ খ্রিষ্টাব্দ`. Revised calendar (Bangla
Academy, 2019): বৈশাখ–আশ্বিন 31 days, কার্তিক–মাঘ and চৈত্র 30, ফাল্গুন 29 (30 in a leap year);
১ বৈশাখ = 14 April, ১ পৌষ = 16 December, ৮ ফাল্গুন = 21 February, ১২ চৈত্র = 26 March. Use `bn.py`.

**Priority** (নির্দেশ ২৫): `জরুরি`, `অবিলম্বে`, `সর্বোচ্চ অগ্রাধিকার`, top of the letter.

**বিষয়**: one short noun phrase ending in `।`, often `… প্রসঙ্গে।` or `… সংক্রান্ত।`.
**সূত্র**: `সূত্র: <দপ্তর>-এর <তারিখ> তারিখের <নম্বর> সংখ্যক স্মারক।` Several: `(১) … (২) …`.
A reply always cites the number and date of the letter it answers (নির্দেশ ১৩৪(৩)).

**Body**: the first paragraph states the matter and is not numbered; then `২।`, `৩।` (`০২।` is also
seen). Sub-points `(ক)`, `(খ)`. Plain, short sentences, no repetition (নির্দেশ ১৩৩).

**Signature block** (right): `(নাম)` / `পরিচিতি নম্বর: …` (if any) / পদনাম / `ফোন: …` / `ই-মেইল: …`.
Name, designation, phone and e-mail are mandatory. An officer signing for the government writes
`নির্দেশক্রমে` in the text; a প্রজ্ঞাপন has `রাষ্ট্রপতির আদেশক্রমে,` above the signature.

**সংযুক্তি**: bottom left of the body, with the count: `সংযুক্তি: বর্ণনামতে (০৩ পাতা)।`

**বিতরণ / অনুলিপি**: after the signature the number and date line is repeated, then
`অবগতি ও প্রয়োজনীয় ব্যবস্থা গ্রহণের জন্য অনুলিপি প্রেরণ করা হলো:` (or `অবগতির জন্য…`) and a
numbered list, seniority first, each with its purpose in brackets where needed:
- `সচিবের একান্ত সচিব, <মন্ত্রণালয়> (সচিব মহোদয়ের সদয় অবগতির জন্য)।`
- `মন্ত্রীর একান্ত সচিব, <মন্ত্রণালয়> (মাননীয় মন্ত্রী মহোদয়ের সদয় অবগতির জন্য)।`
- `সিনিয়র সিস্টেম এনালিস্ট, <মন্ত্রণালয়> (ওয়েবসাইটে প্রকাশের অনুরোধসহ)।`
- `উপপরিচালক, বাংলাদেশ সরকারি মুদ্রণালয়, তেজগাঁও, ঢাকা (পরবর্তী গেজেটে প্রকাশের অনুরোধসহ)।`
- last: `সংরক্ষণ নথি।` / `অফিস কপি।`
A list not in order of seniority is headed `(জ্যেষ্ঠতার ক্রমানুসারে নয়)` *(practice)*.

## Types

### সরকারি পত্র — `letter` (নির্দেশ ১৩৭, ক্রোড়পত্র-১৭)
Government views, orders and formal sanctions to the Supreme Court, PSC, agencies, persons,
attached and subordinate offices. **Never between ministries** (use a স্মারক). First person.
```
<letterhead>
নম্বর: …                                    তারিখ: <বাংলা>/<ইংরেজি>
প্রাপক: <পদনাম>
        <অফিস ও ঠিকানা>
বিষয়: …।
সূত্র: …।
মহোদয়,
    উপর্যুক্ত বিষয় ও সূত্রের বরাতে নির্দেশক্রমে জানানো যাচ্ছে যে, …।
    ২। …।
                                             আপনার বিশ্বস্ত,
                                             (নাম) / পদনাম / ফোন / ই-মেইল
নম্বর: …                                    তারিখ: …
অবগতি ও প্রয়োজনীয় ব্যবস্থা গ্রহণের জন্য অনুলিপি প্রেরণ করা হলো:
১। …
```
Salutation `জনাব/মহোদয়,` and close `আপনার বিশ্বস্ত,`; to a private person or company
`প্রিয় মহোদয়/মহোদয়গণ,` and `আপনার/আপনাদের বিশ্বস্ত,`. Sanction openers: `উপর্যুক্ত বিষয় ও
সূত্রের বরাতে আদিষ্ট হয়ে … মঞ্জুরি জ্ঞাপন করছি।`

### অফিস স্মারক — `memo` (নির্দেশ ১৩৮, ক্রোড়পত্র-১৮)
Lower office to higher; between ministries; information (not orders) to field offices; replies to
letters and applications. **Third person, no salutation, no courtesy close.** Recipient at the
**bottom left**, after the signature. Closes with `… নির্দেশক্রমে অনুরোধ করা হলো।`
```
<letterhead>
স্মারক নম্বর: …                              তারিখ: …
বিষয়: …।
সূত্র: …।
    <বিষয়বস্তু>।
    ২। <নির্দেশনা/উদ্দেশ্য> … নির্দেশক্রমে অনুরোধ করা হলো।
সংযুক্তি: …
                                             (নাম) / পদনাম / ফোন / ই-মেইল
<প্রাপকের পদনাম>
<অফিস ও ঠিকানা>
স্মারক নম্বর: …                              তারিখ: …
অনুলিপি …
```
A memo issued in error is re-issued marked `একই নম্বর ও তারিখে প্রতিস্থাপিত`, signed with the
current date.

### অফিস আদেশ — `order` (নির্দেশ ১৩৯, ক্রোড়পত্র-১৯)
Office instructions, internal posting, appointment, promotion and leave of non-gazetted staff.
Centred title `অফিস আদেশ`; **no বিষয়, no addressee, no salutation**. Typical text:
`<দপ্তর>-এর <তারিখ> তারিখের <নম্বর> সংখ্যক স্মারকের পরিপ্রেক্ষিতে <নাম, পদবি>-কে <তারিখ> তারিখে
এ বিভাগ থেকে অবমুক্ত করা হলো।` / `২। … অতিরিক্ত দায়িত্ব প্রদান করা হলো।` and the closing
`৩। যথাযথ কর্তৃপক্ষের অনুমোদনক্রমে জনস্বার্থে জারিকৃত এ আদেশ অবিলম্বে কার্যকর হবে।`
University: `উপাচার্য মহোদয়ের অনুমোদনক্রমে এ আদেশ জারি করা হলো এবং তা অবিলম্বে কার্যকর হবে।`,
signed by the রেজিস্ট্রার *(practice)*.

### পরিপত্র — `circular` (নির্দেশ ১৪০, ক্রোড়পত্র-২০)
One instruction to several offices or persons, usually policy or rule changes. Centred title
`পরিপত্র`, then `বিষয়:`, body (`সরকার … নিম্নরূপভাবে সংশোধন করেছে:` (ক) (খ) …), `২। এটি অবিলম্বে
কার্যকর হবে।`, signature, `বিতরণ:` list (add the Government Press entry when it is to be gazetted).

### প্রজ্ঞাপন — `notification` (নির্দেশ ১৪৪, ক্রোড়পত্র-২৪)
Acts, ordinances, rules, orders, and gazetted officers' appointment, leave and transfer — anything
published in the **Bangladesh Gazette**. Centred title `প্রজ্ঞাপন`; **no বিষয়, no addressee**.
Signed under `রাষ্ট্রপতির আদেশক্রমে,`. The copy list must include the Government Press "(পরবর্তী
গেজেটে প্রকাশের অনুরোধসহ)". Effective date paragraph: `<তারিখ> তারিখ হতে এ প্রজ্ঞাপন কার্যকর হবে।`
Wording rules (নির্দেশ ১৫০): `সরকার … সিদ্ধান্ত গ্রহণ করেছে`; appointments `রাষ্ট্রপতি
অনুগ্রহপূর্বক নিয়োগ করেছেন`; never that the President or Prime Minister decided personally.

### বিজ্ঞপ্তি / নোটিশ — `notice` (নির্দেশ ১৪৮, ক্রোড়পত্র-২৬, ২৬(ক))
Calls for applications, announcements, information, legal-process notices; may also go by SMS or
e-mail. Centred title `বিজ্ঞপ্তি`, `বিষয়:`, body opening `উপর্যুক্ত বিষয়ের পরিপ্রেক্ষিতে জানানো
যাচ্ছে যে, …`, `সংযুক্তি:`, signature, `বিতরণ (জ্ঞাতার্থে ও কার্যার্থে):`.

### সভার নোটিশ — `meeting` (ক্রোড়পত্র-২৬(খ))
Centred `সভার নোটিশ`, `বিষয়: <কমিটির নাম>-এর সভা।`, then:
`<কমিটি>-এর <ক্রম> সভা <সভাপতির পদবি>-এর সভাপতিত্বে আগামী <তারিখ> তারিখ <সকাল/বিকাল> <সময়> টায়
<স্থান>-এ অনুষ্ঠিত হবে।` / `২। উক্ত সভায় … উপস্থিত থাকার জন্য নির্দেশক্রমে অনুরোধ করা হলো।`
Then `বিতরণ:` (members) and অনুলিপি (the office arranging refreshments, the secretary's PS). The
meeting date must come **after** the notice date (the official sample gets this wrong; `check.py`
catches it). Add `আলোচ্যসূচি:` as items when the user gives an agenda.

### সভার কার্যবিবরণী — `minutes` *(practice: SI-2024 requires minutes but gives no template)*
Title `<কমিটি>-এর <ক্রম> সভার কার্যবিবরণী`; `meta`: সভাপতি, তারিখ, সময়, স্থান; `সভায় উপস্থিত
সদস্যবৃন্দের তালিকা পরিশিষ্ট ‘ক’-তে দেখানো হলো।`; the chair's opening; then each agenda item as a
table row `আলোচ্য বিষয় | আলোচনা | সিদ্ধান্ত | বাস্তবায়নে`; closing `সভায় আর কোনো আলোচ্য বিষয় না
থাকায় সভাপতি উপস্থিত সকলকে ধন্যবাদ জানিয়ে সভার সমাপ্তি ঘোষণা করেন।`; signed by the chair.

### আধা-সরকারি পত্র — `do` (নির্দেশ ১৪১, ক্রোড়পত্র-২১)
Officer to officer, to get personal attention; may be on the officer's own pad. **No letterhead
and no বিষয়.** Sender's name, designation, phone, e-mail at the **top right**. First person
singular. Salutation by rank: same rank or junior `প্রিয় <নাম/পদবি>,`; one or two steps senior
`প্রিয় জনাব/মহোদয়,`; three or more steps senior `প্রিয় মহোদয়,` (written by hand on the signed
copy). Body opens `আপনি নিশ্চয় অবগত রয়েছেন যে, …` and asks `… বিশেষভাবে অনুরোধ করছি।`.
Close: `শুভেচ্ছান্তে,`/`শ্রদ্ধান্তে,` on the left, `আন্তরিকভাবে আপনার,` on the right; the
recipient's **name**, designation and address at the bottom left. Copies are discouraged.

### অনাপত্তি সনদ — `noc` *(practice)*
Centred `অনাপত্তি সনদ`: `এই মর্মে অনাপত্তি প্রদান করা যাচ্ছে যে, জনাব/বেগম <নাম>, <পদবি>, <দপ্তর>
<উদ্দেশ্য: সাধারণ/অফিসিয়াল পাসপোর্ট প্রাপ্তি, বিদেশ ভ্রমণ, উচ্চশিক্ষা> বিষয়ে এ দপ্তরের কোনো আপত্তি
নেই।` Add the person's details the purpose needs (জন্ম তারিখ, পিতার নাম, NID) as items. For a
passport, the issuing office also posts the NOC on its website.

### প্রত্যয়নপত্র — `certificate` *(practice)*
Centred `প্রত্যয়নপত্র`: `এই মর্মে প্রত্যয়ন করা যাচ্ছে যে, <নাম>, পিতা: …, মাতা: …, <পদবি/শিক্ষার্থী
আইডি> … । আমার জানামতে তিনি রাষ্ট্রবিরোধী কোনো কাজে জড়িত নন। আমি তাঁর সর্বাঙ্গীণ মঙ্গল কামনা করি।`
Signed by the head with seal.

### Others in SI-2024 (write as text when asked)
- **অনানুষ্ঠানিক নোট (UO note)**, ক্রোড়পত্র-২২: inside a file, between ministries; office name top
  right, বিষয়, সূত্র, body, signature with intercom, recipient bottom left, and the
  `ইউ ও নোট নম্বর:` with date **at the bottom**, under a rule.
- **পৃষ্ঠাঙ্কন (endorsement)**, ক্রোড়পত্র-২৩: forwards another office's order: `এ আদেশ পৃষ্ঠাঙ্কন
  করে … প্রেরণের প্রয়োজনীয় ব্যবস্থা গ্রহণের জন্য অনুরোধ করা হলো।`
- **নোট (note sheet)**, নির্দেশ ১১৪–১২৬: A4 with a one-fifth margin; one numbered series of
  paragraphs: facts, procedure, applicable rules, other data, precedents, a specific proposal.
  Neutral, no personal remarks; refer to papers by page (`পত্রপৃষ্ঠা ১৩-১৪`), do not quote them.
  The writer signs on the left with name, designation and date and marks the next officer's
  designation on the right of the same line.
- **সারসংক্ষেপ** for the President/Prime Minister, ক্রোড়পত্র-১৬: brief description; laws, rules
  and precedents; justification; specific proposal; `৫। অনুচ্ছেদ-৪ এর প্রস্তাব মাননীয়
  প্রধানমন্ত্রীর সদয় বিবেচনা ও সানুগ্রহ অনুমোদনের জন্য উপস্থাপন করা হলো।`

## Choosing between types

| | সরকারি পত্র | অফিস স্মারক | প্রজ্ঞাপন | অফিস আদেশ |
|---|---|---|---|---|
| Goes to | agencies, persons, field offices (not ministries) | higher offices, other ministries, replies | the public, via the Gazette | inside the office |
| Person | first | third | impersonal | impersonal |
| Title | — | — | প্রজ্ঞাপন | অফিস আদেশ |
| বিষয় | yes | yes | no | no |
| Addressee | top, `প্রাপক:` | bottom left | none | none |
| Salutation / close | মহোদয় … আপনার বিশ্বস্ত | none; `নির্দেশক্রমে` | `রাষ্ট্রপতির আদেশক্রমে` | none |

Personnel matters: gazetted officers get a প্রজ্ঞাপন, non-gazetted staff an অফিস আদেশ. One letter
to many offices is a পরিপত্র; an announcement or call is a বিজ্ঞপ্তি.

## Language

Stock phrases: `উপর্যুক্ত বিষয় ও সূত্রের পরিপ্রেক্ষিতে জানানো যাচ্ছে যে,` · `এমতাবস্থায়,` ·
`… গ্রহণের জন্য নির্দেশক্রমে অনুরোধ করা হলো।` · `… সদয় অবগতি ও প্রয়োজনীয় ব্যবস্থা গ্রহণের জন্য` ·
`বিধি মোতাবেক` · `যথাযথ কর্তৃপক্ষের অনুমোদনক্রমে` · `জনস্বার্থে` · `অবিলম্বে কার্যকর হবে।`

`জনাব` before any officer's name (used for all genders in current practice); `মহোদয়` as the
salutation and in purposes (`সচিব মহোদয়ের সদয় অবগতির জন্য`).

প্রমিত spellings (`check.py` flags the left column):

| Not | Write |
|---|---|
| সরকারী, বেসরকারী, আধাসরকারী | সরকারি, বেসরকারি, আধা-সরকারি |
| জানুয়ারী, ফেব্রুয়ারী | জানুয়ারি, ফেব্রুয়ারি |
| খ্রীষ্টাব্দ, খৃষ্টাব্দ | খ্রিষ্টাব্দ |
| উপরোক্ত, উল্লেখিত | উপর্যুক্ত, উল্লিখিত |
| শ্রেণী, চাকুরী/চাকুরি | শ্রেণি, চাকরি |
| ইতিমধ্যে, স্বত্ত্বেও, ইদানিং | ইতোমধ্যে, সত্ত্বেও, ইদানীং |
| নির্দেশাবলী, তথ্যাবলী, নিয়মাবলী | নির্দেশাবলি, তথ্যাবলি, নিয়মাবলি |
| বিদেশী, দেশী | বিদেশি, দেশি |
| মুহুর্ত, পুরষ্কার, সুষ্ঠ, ভৌগলিক | মুহূর্ত, পুরস্কার, সুষ্ঠু, ভৌগোলিক |

Rule of thumb: non-তৎসম words (দেশি, বিদেশি, ইংরেজি loans) take ি, not ী; তৎসম words keep
their ী (মন্ত্রী, কর্মচারী, শ্রেণিবিন্যাস but সমীচীন). Use a colon after labels (`বিষয়:`), not ঃ.

Other digits rules: Bangla digits in Bangla text; Latin only in e-mail addresses, URLs and
English text. Lakh grouping (`১২,৩৪,৫৬৭`), never `1,234,567`.
