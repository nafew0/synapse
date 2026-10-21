# Drafting Bangladesh government documents under SI-2024

Bangladesh government correspondence is governed by the **সচিবালয় নির্দেশমালা, ২০২৪** (Secretariat Instructions 2024), approved on 2 June 2024 and published on 12 June 2024. It supersedes the 2014 edition, lists **12 communication types** in নির্দেশ ১৩৬, and for the first time ships a ফরম্যাট plus a filled নমুনা for each main type in its appendices (ক্রোড়পত্র-১৭ to ২৬(খ)) ([SI-2024][si]; [দেশ রূপান্তর][dr]). Every type shares one skeleton. A centred header reads "গণপ্রজাতন্ত্রী বাংলাদেশ সরকার / মন্ত্রণালয় / শাখা / www.---.gov.bd". The নম্বর goes on the left, now a **22-digit digital nothi number in 8 dot-separated codes** plus a জারি নম্বর. The তারিখ goes on the right, with বাংলা সন **above** and খ্রিষ্টীয় সন **below**. A right-aligned signature block carries name, পরিচিতি নম্বর, পদনাম, ফোন and ই-মেইল, and a second নম্বর/তারিখ line with sub-numbers like "(১/৯)" sits above the অনুলিপি list. The types differ in grammatical person, whether there is a salutation, where the addressee sits, and the closing formula (for example "নির্দেশক্রমে" or "রাষ্ট্রপতির আদেশক্রমে"). The Bangla Language Act 1987 requires all non-foreign official correspondence to be in Bangla. A government directive tells offices to use Unicode, reportedly naming **Nikosh**, so legacy Bijoy/SutonnyMJ text has to be converted. Nikosh's reported CC BY-NC-ND license makes Noto Bengali the safe font to redistribute. On the tooling side, Bangla renders correctly only when every engine is told about it. DOCX needs the `w:cs`/`w:szCs`/`w:bCs` complex-script slots, PPTX needs `a:cs`, PDFs need HarfBuzz shaping (ReportLab ≥4.4 `shaping=1`, fpdf2 `set_text_shaping`, or LibreOffice), charts need matplotlib ≥3.11, and Pillow needs Raqm. Verification has to rasterize pages and inspect them, because correctly shaped Bangla PDFs extract to garbled text. The rest of this report gives the verbatim templates, the date and file-number algorithms (tested against real dated documents) and working code, with sourced rules kept separate from inferred conventions.

**How to read provenance in this report.** **[SI-2024]** marks text transcribed from the official 177-page PDF of the Secretariat Instructions 2024. Its text layer is non-Unicode, so the researcher read and transcribed it from the page images; quotations keep the PDF's সাধু spelling. **[sourced]** marks other cited primary or secondary sources. **[VERIFIED]** marks code a researcher ran: library recipes were run on macOS on 2026-10-21, and the date and nothi-number code was run again for this report. **[convention]** marks widely observed practice with no primary text behind it. **[inferred]** marks reasoning from the property model or by analogy. A SKILL.md should treat **[convention]** and **[inferred]** items as overridable defaults.

## SI-2024 replaced 2014 and lists twelve communication types

The Secretariat Instructions began in English in 1976, were translated into Bangla in 1978, and were revised in 2008, 2014 and 2024. The 2024 edition was prepared by the Reforms and Research Wing of the জনপ্রশাসন মন্ত্রণালয় under Rules of Business 1996 ([দেশ রূপান্তর, 19 Jun 2024][dr]). Its foreword lists the changes: "০৮টি নির্দেশ, ৩০টি উপনির্দেশ ও ৩১টি ক্রোড়পত্র নূতন সংযোজন, ৮৮টি নির্দেশ, ৯৪টি উপনির্দেশ ও ১৩টি ক্রোড়পত্রের আংশিক সংশোধন". It adds that "ক্রোড়পত্র অংশে সারসংক্ষেপ লিখন ও অধিক ব্যবহৃত কতিপয় পত্রের ফরম্যাটের পাশাপাশি নমুনা সংযোজন করা হইয়াছে।" Critically for universities and agencies, it states "**সচিবালয়ের বাহিরে অন্যান্য অফিসের জন্য প্রযোজ্য ক্ষেত্রে এই নির্দেশমালা ব্যবহার করা যাইবে।**" ([SI-2024 foreword][si]). The 2024 edition calls its appendices **ক্রোড়পত্র**, not পরিশিষ্ট. Training material that cites "পরিশিষ্ট-…" numbers from 2014 will not match. Secondary sites such as bdservicerules.info still describe "11 types per the 2008 and 2014 Instructions" ([bdservicerules.info][bdsr-memo]). The 2024 list has 12: it adds বিজ্ঞপ্তি/নোটিশ and widens the digital-media item.

**নির্দেশ ১৩৬ [SI-2024], verbatim:** "যোগাযোগের মাধ্যম অথবা পত্রসমূহ নিম্নবর্ণিত কোনো না কোনো প্রকারের হইবে যাহা ডিজিটাল পদ্ধতির ক্ষেত্রেও সমানভাবে প্রযোজ্য হইবে:" (১) সরকারি পত্র (Official Letter); (২) অফিস স্মারক (Office Memorandum); (৩) অফিস আদেশ (Office Order); (৪) পরিপত্র (Circular); (৫) আধা-সরকারিপত্র (Demi-Official Letter); (৬) অনানুষ্ঠানিক নোট (Unofficial Note); (৭) অনুলিপি প্রেরণ/পৃষ্ঠাঙ্কন (Copy Circulated/Endorsement); (৮) প্রজ্ঞাপন (Notification); (৯) সিদ্ধান্ত প্রস্তাব (Resolution); (১০) প্রেস ইশতেহার/প্রেস নোট (Press Communique/Press Note); (১১) ফ্যাক্স, ই-মেইল, জিইপি, এসএমএস, সাইফার বার্তা, অ্যাপস ও অন্যান্য ডিজিটাল মাধ্যম; এবং (১২) বিজ্ঞপ্তি/নোটিশ (Notice)। ([SI-2024 p.42][si])

The appendix map below is the index a drafting agent needs [SI-2024]. In the PDF, page number = printed page + 19.

| ক্রোড়পত্র | Content | নির্দেশ | Printed page |
|---|---|---|---|
| ১৬ / ১৬(ক) / ১৬(খ) | সারসংক্ষেপ format / sample for President / sample for PM | ১১৬ | 102–104 |
| ১৭ / ১৭(ক) | সরকারি পত্র format / sample | ১৩৭(৩) | 105–106 |
| ১৮ / ১৮(ক) | অফিস স্মারক format / sample | ১৩৮(২) | 107–108 |
| ১৯ / ১৯(ক) | অফিস আদেশ format / sample | ১৩৯ | 109–110 |
| ২০ / ২০(ক) | পরিপত্র format / sample | ১৪০ | 111–112 |
| ২১ / ২১(ক) | আধা-সরকারি পত্র format / sample | ১৪১(২) | 113–114 |
| ২২ / ২২(ক) | অনানুষ্ঠানিক নোট format / sample | ১৪২ | 115–116 |
| ২৩ | পৃষ্ঠাঙ্কন format | ১৪৩(২) | 117–118 |
| ২৪ / ২৪(ক) | প্রজ্ঞাপন format / sample | ১৪৪ | 119–120 |
| ২৫(ক) / ২৫(খ) | ফ্যাক্স বার্তা (Bangla / English) | ১৪৭(১) | 121–122 |
| ২৬ / ২৬(ক) / ২৬(খ) | বিজ্ঞপ্তি format / বিজ্ঞপ্তি sample / **সভার নোটিশ sample** | ১৪৮ | 123–125 |
| ৬(ক) | ডিজিটাল নথি নম্বরের নমুনা | ৪২ | 90–92 |
| ৯ | পত্র জারি নিবন্ধনবহি | ৬৭ | 95 |
| ৫০ | fire-equipment প্রত্যয়নপত্র (the only প্রত্যয়নপত্র in the book) | — | 149 |

SI-2024 has **no ক্রোড়পত্র for meeting minutes (কার্যবিবরণী), NOC (অনাপত্তি) or general প্রত্যয়নপত্র**. Those templates below come from field practice and are marked accordingly. The researchers did not read ক্রোড়পত্র-৬(ক) or ৯, or the text of নির্দেশ ১৯. The appendix টীকা cite ১৯ for priority marking, but the table of contents titles ১৯ "বরাতসূত্র নির্দেশ", so that cross-reference is unverified.

## Every format shares one skeleton built on five fixed rules

### Header, contact details, priority, footer and impersonal framing

The format appendices repeat the same header block, centred: **গণপ্রজাতন্ত্রী বাংলাদেশ সরকার** (bold), then "………… মন্ত্রণালয়/বিভাগ", then "………….শাখা", then "www.-------.gov.bd" [SI-2024]. Contact details are mandatory. "চিঠিপত্রে (হার্ডকপি) স্বাক্ষরকারী কর্মকর্তা কর্তৃক স্বীয় স্বাক্ষরের নিম্নে নাম, পদবি, ফোন নম্বরের সহিত ই-মেইল ঠিকানাও উল্লেখ করিতে হইবে।" ([SI-2024 p.10][si]). Drafts must name the signer: "যে কর্মকর্তার স্বাক্ষরে পত্র প্রেরিত হইবে তাঁহার নাম, পরিচিতি নম্বর (যদি থাকে), পদনাম ও টেলিফোন নম্বর, ই-মেইল, ফ্যাক্স নম্বর খসড়াতে উল্লেখ করিতে হইবে।" (নির্দেশ ১৩৫(৪)). Attachments are counted at the bottom left: "খসড়ার শেষ পৃষ্ঠার বাম কোণে সংলগ্নীসমূহের সংখ্যাও নির্দেশ করিতে হইবে" (১৩৫(৩)). Drafts use double spacing (১৩৫(১)), and multiple drafts are labelled "খসড়া-১, খসড়া-২" under an "‘অনুমোদনের জন্য খসড়া’" slip (১৩৫(৫)) ([SI-2024 pp.40–41][si]). Typed notes and letters carry the **file name and path in the footer**: "নথির নোটশিট ও চিঠিপত্র ইত্যাদি কম্পিউটারে টাইপের সময় নোটাংশ ও চিঠিপত্রের নিম্নভাগ (footer)-এ file name and path লিখিতে হইবে।" (নির্দেশ ৬২(৯), [SI-2024 p.25][si]).

Priority labels come from নির্দেশ ২৫, "‘সর্বোচ্চ অগ্রাধিকার’ (top priority), ‘অবিলম্বে’ (immediate) অথবা ‘জরুরি’ (urgent)", and from ১৩৫(৬): "‘জরুরি’, ‘অবিলম্বে’, ‘অগ্রাধিকার’, ‘সর্বোচ্চ অগ্রাধিকার’". The appendices say "পত্রের গুরুত্ব অনুযায়ী প্রয়োজনবোধে … ধরন চিহ্নিত করা যাইবে।" ([SI-2024 pp.14, 41][si]). Drafting must be terse and paragraph-numbered. নির্দেশ ১৩৩: "খসড়ার বাক্য সুস্পষ্ট ও সংক্ষিপ্ত হইবে ... শব্দ বা বাক্যের বাহুল্য ও পুনরুক্তি পরিহার করিতে হইবে।" ১৩৪(১): "খসড়ার প্রথম অনুচ্ছেদে বিষয়বস্তু বর্ণিত হইবে। সকল পৃথক পৃথক অনুচ্ছেদের ক্রমিক সংখ্যা প্রদান করিতে হইবে।" ১৩৪(২) asks for "সহজ, প্রত্যক্ষ ও সৌহার্দপূর্ণ শব্দাবলি" with the public, and ১৩৪(৩) requires citing the number and date of the letter being answered ([SI-2024 pp.40–41][si]). Decisions are always the government's, never a person's. নির্দেশ ১২৯: "সরকারের সকল নির্বাহী কার্যব্যবস্থা রাষ্ট্রপতির নামে গ্রহণ করা হইয়াছে বলিয়া প্রকাশ করিতে হইবে।" ১৫০(১): "রাষ্ট্রপতি, প্রধানমন্ত্রী ব্যক্তিগতভাবে সিদ্ধান্ত গ্রহণ করিয়াছেন এইরূপ কোনো বিষয় উল্লেখ থাকিবে না। সরকার সিদ্ধান্ত গ্রহণ করিয়াছে এইরূপ উল্লেখ করিতে হইবে।" Formal orders end "‘রাষ্ট্রপতির আদেশক্রমে’". Constitutional-power orders use "‘রাষ্ট্রপতি অনুগ্রহপূর্বক নির্দেশ প্রদান করিয়াছেন’", appointments use "‘রাষ্ট্রপতি অনুগ্রহপূর্বক নিয়োগ করিয়াছেন’", and routine cases may use "‘রাষ্ট্রপতি অনুগ্রহপূর্বক মঞ্জুর করিয়াছেন’" or "‘রাষ্ট্রপতি হস্তক্ষেপ করিতে অস্বীকৃতি জ্ঞাপন করিয়াছেন’" ([SI-2024 pp.40, 46][si]).

Campaign logos are time-limited and currently active. A Cabinet Division memo dated 26 July 2026 (০৪.০০.০০০০.০০০.৪১৬.৯৯.০০০৭.২৬.৪৬৫) requires the **নজরুল বর্ষ logo** on all official letters "আগামী ২৫ মে ২০২৭ পর্যন্ত" ([bdservicerules.info][bdsr-nazrul]; [দেশ রূপান্তর, 26 Jul 2026][dr-nazrul]). An earlier January 2026 গণভোট logo was ordered "পত্রের উপরে ডান পাশে" until the election ([ঢাকা টাইমস][dt-referendum]). **[inferred]** Place the নজরুল বর্ষ logo top-right as a "[নজরুল বর্ষ লোগো]" placeholder only for letters dated 26 Jul 2026 to 25 May 2027. Treat the referendum logo as lapsed. Never emit Mujib Borsho or centenary logos (those campaigns ran 2020–2022). Put the government monogram top-left or top-centre.

### The 22-digit নথি নম্বর and how letters are numbered

নির্দেশ ৪২(৫) defines the memo and letter number as the **digital nothi number: 22 digits in 8 codes separated by dots**. The letter's জারি নম্বর follows after a dot or hyphen, and "জারি নম্বর ডিজিটাল নথি নম্বরের অংশ নহে". Unused positions are zero-filled: "কোনো অবস্থানকেই বাদ দেওয়া যাইবে না।" The pattern is `০০.০০.০০০০.০০০.০০০.০০.০০০০.০০` ([SI-2024 pp.19–21][si]; [bdservicerules.info 22-digit][bdsr-22]). The file serial "প্রতিবছর ১ জানুয়ারি থেকে বিষয়ভিত্তিক নতুনভাবে ০০০১ থেকে শুরু হবে।", and old numbers cannot be reused ([bdservicerules.info][bdsr-22]).

| Pos | Code | Digits | Meaning |
|---|---|---|---|
| 1 | সচিবালয় (মন্ত্রণালয়/বিভাগ) কোড | 2 | assigned by জনপ্রশাসন মন্ত্রণালয় |
| 2 | সংযুক্ত দপ্তর/অধিদপ্তর কোড | 2 | assigned by the administrative ministry (০১–৯৯) |
| 3 | জিওগ্রাফিক (জিও) কোড | 4 | district (2) + upazila (2), BBS codes |
| 4 | অধস্তন প্রতিষ্ঠান কোড | 3 | subordinate institution |
| 5 | শাখা কোড | 3 | originating branch |
| 6 | বিষয়ভিত্তিক শ্রেণিবিন্যাস কোড | 2 | permanent subject classification |
| 7 | নথির ক্রমিক সংখ্যা কোড | 4 | file serial, restarts at ০০০১ each 1 January per subject |
| 8 | নথি খোলার সন কোড | 2 | last two digits of the year the file was opened |

A real current example parses cleanly. The Cabinet Division's "০৪.০০.০০০০.০০০.৪১৬.৯৯.০০০৭.২৬.৪৬৫" (26 Jul 2026) breaks down as ০৪ (মন্ত্রিপরিষদ বিভাগ) . ০০ . ০০০০ . ০০০ . ৪১৬ (branch) . ৯৯ (subject) . ০০০৭ (file) . ২৬ (opened 2026), followed by জারি ৪৬৫ ([bdservicerules.info][bdsr-nazrul]). Two cautions apply. First, **the SI-2024 filled samples themselves carry older 18-digit numbers** (for example "০৫.০০.০০০০.১২৩.০২.০৪৮.২১-১৩৭", with the issue number after a hyphen). A 31 Aug 2024 gazette also used an 18-digit number with a dot before the issue number ("নং ৪৮.০০.০০০০.০০৪.৪০.০৩১.২৪.৩১০৯") ([Bangladesh Gazette PDF][gazette]). Copy the shape of the 22-digit rule, not the samples. Second, no source lists ministry codes. **Never invent real-looking codes**. Emit zero-filled or bracketed placeholders.

Copies take sub-numbers. নির্দেশ ৬৮ keeps one serial per issue, and copies get "তির্যক (/) চিহ্নের পরে উপসংখ্যা (sub-number)". The samples write copy 1 of 9 as "…২১-১৩৭(১/৯)" ([SI-2024 pp.26, 106][si]). Labels by type [inferred from the formats]: "নম্বর:" for সরকারি পত্র, অফিস আদেশ, পরিপত্র, প্রজ্ঞাপন and বিজ্ঞপ্তি; "স্মারক নম্বর:" for অফিস স্মারক and the copy line of প্রজ্ঞাপন; "আধা-সরকারি পত্র নম্বর:" for DO letters; "ইউ ও নোট নম্বর:" at the bottom for UO notes. Real documents often abbreviate to "নং" or "স্মারক নং-". The document type is decided by its structure, not by this label.

```python
# [VERIFIED] reproduces the Cabinet Division 2026 number exactly
BN_DIGITS = str.maketrans("0123456789", "০১২৩৪৫৬৭৮৯")
def to_bn_digits(x) -> str:
    return str(x).translate(BN_DIGITS)

NOTHI_WIDTHS = (2, 2, 4, 3, 3, 2, 4, 2)

def nothi_number(ministry, office=0, geo=0, subordinate=0, branch=0,
                 subject=0, serial=0, year=0, issue=None) -> str:
    """22-digit digital nothi number (SI-2024 নির্দেশ ৪২(৫)) + optional জারি নম্বর."""
    codes = (ministry, office, geo, subordinate, branch, subject, serial, year % 100)
    parts = []
    for code, width in zip(codes, NOTHI_WIDTHS):
        s = str(int(code)).zfill(width)
        if len(s) != width:
            raise ValueError(f"code {code} exceeds {width} digits")
        parts.append(s)
    num = ".".join(parts)
    if issue is not None:
        num += f".{int(issue)}"
    return to_bn_digits(num)

assert nothi_number(4, 0, 0, 0, 416, 99, 7, 2026, issue=465) == "০৪.০০.০০০০.০০০.৪১৬.৯৯.০০০৭.২৬.৪৬৫"
# copy line: f"{nothi_number(...)}({to_bn_digits(i)}/{to_bn_digits(n)})"
# placeholder when codes unknown:
# "[মন্ত্রণালয় কোড].[দপ্তর কোড].[জিও কোড].[অধস্তন প্রতিষ্ঠান কোড].[শাখা কোড].[বিষয় কোড].[নথি ক্রমিক].[সন].[জারি নং]"
```

Autonomous bodies and universities use their own numbering. **[convention]** The shape is roughly `<inst-code>/<section>/<file>/<year>/<serial>`. No source documents BDREN's scheme.

### Dual dates on the 2019 revised Bangla calendar

Every format appendix carries the টীকা "তারিখ লিখিবার ক্ষেত্রে **উপরে বাংলা সন এবং নিচে খ্রিষ্টীয় সন** লিখিতে হইবে।" The samples stack the pair to the right of "তারিখ:", for example "১৩ জ্যৈষ্ঠ ১৪২৮" above "২৭ মে ২০২১" ([SI-2024 ক্রোড়পত্র-১৭(ক) p.106][si]). Gazettes put the date on one line with suffixes, for example "তারিখ : ১৭ শ্রাবণ ১৪৩১ বঙ্গাব্দ/০১ আগস্ট ২০২৪ খ্রিষ্টাব্দ" ([Bangladesh Gazette][gazette]). The calendar is the Bangla Academy revision applied from 2019 (Ajoy Roy committee, formed 2015). "বৈশাখ থেকে আশ্বিন- বছরের প্রথম ছয় মাস গণনা করা হবে ৩১ দিনে।" "কার্তিক, অগ্রহায়ণ, পৌষ, মাঘ ও চৈত্র- এই পাঁচ মাস গণনা করা হবে ৩০ দিনে।" "ফাল্গুন মাস গণনা করা হবে ২৯ দিনে।" "লিপইয়ারে ফাল্গুন মাস পূর্ণ হবে ৩০ দিনে।" Pohela Boishakh is fixed on 14 April, 21 February = ৮ ফাল্গুন, 26 March = ১২ চৈত্র and 16 December = ১ পৌষ ([teachers.gov.bd, 2019][cal]). The pre-2019 rule (Falgun 31 days in leap years) is obsolete ([plugin description][oldcal]).

Because 1 বৈশাখ is pinned to 14 April and the leap day falls inside ফাল্গুন, **the month start dates are the same every year**: বৈশাখ 14 Apr, জ্যৈষ্ঠ 15 May, আষাঢ় 15 Jun, শ্রাবণ 16 Jul, ভাদ্র 16 Aug, আশ্বিন 16 Sep, কার্তিক 17 Oct, অগ্রহায়ণ 16 Nov, পৌষ 16 Dec, মাঘ 15 Jan, ফাল্গুন 14 Feb (29 days, or 30 in a Gregorian leap year), চৈত্র 15 Mar. The Bangla year is the Gregorian year − 593 on or after 14 April, and − 594 before it. These start dates are derived from the cited month lengths. The code below was run against **18 checks: 11 dates printed in real documents or mastheads and 7 derived ones**. The real ones are SI-2024 samples (১৩ জ্যৈষ্ঠ ১৪২৮ = 27 May 2021; ১৭ বৈশাখ ১৪৩০ = 30 Apr 2023; ৫ আষাঢ় ১৪৩০ = 19 Jun 2023; foreword ২৩ জ্যৈষ্ঠ ১৪৩১ = 06 Jun 2024), the 2024 gazette (১৭ শ্রাবণ ১৪৩১ = 01 Aug 2024), Chattogram letters (২৬ অগ্রহায়ণ ১৪৩০ = 11 Dec 2023; ১০ আশ্বিন ১৪৩০ = 25 Sep 2023, from search snippets of [portal PDF 1][ctg1] and [PDF 2][ctg2]) and 2026 mastheads (২৫ ভাদ্র ১৪৩৩ = 9 Sep 2026 per [risingbd][rbd]; ২০ শ্রাবণ ১৪৩৩ = 4 Aug 2026 per [Inqilab][inq]). The derived checks are the cited anchors (১ পৌষ, ৮ ফাল্গুন, ১২ চৈত্র) and the leap-year, year-boundary and New Year edges. All 18 passed. Today, 21 October 2026, is **০৫ কার্তিক ১৪৩৩**. One research note wrote "০৬ কার্তিক" for this date; that is an off-by-one error.

```python
# [VERIFIED] 18/18 checks incl. 11 dates printed in real documents/mastheads
from datetime import date

BN_DIGITS = str.maketrans("0123456789", "০১২৩৪৫৬৭৮৯")
BN_MONTHS = ["বৈশাখ", "জ্যৈষ্ঠ", "আষাঢ়", "শ্রাবণ", "ভাদ্র", "আশ্বিন",
             "কার্তিক", "অগ্রহায়ণ", "পৌষ", "মাঘ", "ফাল্গুন", "চৈত্র"]
EN_MONTHS_BN = ["জানুয়ারি", "ফেব্রুয়ারি", "মার্চ", "এপ্রিল", "মে", "জুন", "জুলাই",
                "আগস্ট", "সেপ্টেম্বর", "অক্টোবর", "নভেম্বর", "ডিসেম্বর"]

def _is_leap(y):
    return y % 4 == 0 and (y % 100 != 0 or y % 400 == 0)

def to_bn_digits(x) -> str:
    return str(x).translate(BN_DIGITS)

def gregorian_to_bangla(d: date):
    """Return (day, month_index 0-11, bangla_year) under the 2019 revised calendar."""
    start_year = d.year if d >= date(d.year, 4, 14) else d.year - 1
    bn_year = start_year - 593
    lengths = [31] * 6 + [30] * 4 + [30 if _is_leap(start_year + 1) else 29, 30]
    offset = (d - date(start_year, 4, 14)).days
    for m, n in enumerate(lengths):
        if offset < n:
            return offset + 1, m, bn_year
        offset -= n
    raise AssertionError("unreachable")

def dual_date(d: date, pad=True):
    day, m, y = gregorian_to_bangla(d)
    f = (lambda n: to_bn_digits(f"{n:02d}")) if pad else to_bn_digits
    bn = f"{f(day)} {BN_MONTHS[m]} {to_bn_digits(y)} বঙ্গাব্দ"
    en = f"{f(d.day)} {EN_MONTHS_BN[d.month - 1]} {to_bn_digits(d.year)} খ্রিষ্টাব্দ"
    return bn, en

# dual_date(date(2026, 10, 21)) -> ("০৫ কার্তিক ১৪৩৩ বঙ্গাব্দ", "২১ অক্টোবর ২০২৬ খ্রিষ্টাব্দ")
```

The rendering conventions are **[convention]**. Use the stacked form (Bangla line above, Gregorian below, right-aligned after "তারিখ:") in letters and the single-line "…বঙ্গাব্দ/…খ্রিষ্টাব্দ" form in gazettes. e-Nothi output zero-pads the day (০৫). The SI samples do not ("৫ আষাঢ়"), and the "বঙ্গাব্দ/খ্রিষ্টাব্দ" suffixes are optional in practice. Spell it **খ্রিষ্টাব্দ** (not খ্রীষ্টাব্দ/খৃষ্টাব্দ) and use প্রমিত month spellings ending in -ি (জানুয়ারি, ফেব্রুয়ারি). In-body dates often use the compact Bangla-digit form "০৭.০২.২০২৩ তারিখের" ([SI-2024 p.110][si]).

```
                                                    ০৫ কার্তিক ১৪৩৩ বঙ্গাব্দ
নম্বর: ০০.০০.০০০০.০০০.০০০.০০.০০০০.২৬.[জারি নং]          তারিখ: ─────────────────────
                                                    ২১ অক্টোবর ২০২৬ খ্রিষ্টাব্দ
```

## Twelve formats differ in voice, addressee position and closing

The four most-confused types separate on a handful of structural features, all explicit in SI-2024 ([SI-2024 pp.42–45, 105–120][si]):

| Feature | সরকারি পত্র | অফিস স্মারক | প্রজ্ঞাপন | অফিস আদেশ | পরিপত্র | বিজ্ঞপ্তি | আধা-সরকারি | UO নোট |
|---|---|---|---|---|---|---|---|---|
| নির্দেশ / ক্রোড়পত্র | ১৩৭ / ১৭ | ১৩৮ / ১৮ | ১৪৪ / ২৪ | ১৩৯ / ১৯ | ১৪০ / ২০ | ১৪৮ / ২৬ | ১৪১ / ২১ | ১৪২ / ২২ |
| Person | উত্তম পুরুষ | নাম পুরুষ | impersonal | impersonal | impersonal | impersonal | উত্তম পুরুষ একবচন | — |
| Centred title | none | none | **প্রজ্ঞাপন** | **অফিস আদেশ** | **পরিপত্র** | **বিজ্ঞপ্তি** | none | none |
| বিষয় line | yes | yes | **no** | **no** | yes | yes | **no** | yes |
| Addressee | top-left "প্রাপক :" | **bottom-left** | none | none | "বিতরণ :" list | "বিতরণ (জ্ঞাতার্থে/…)" | bottom-left, by name | bottom-left |
| Salutation | জনাব/মহোদয়, | none | none | none | none | none | প্রিয়…/জনাব/মহোদয় (handwritten) | none |
| Closing | আপনার বিশ্বস্ত, | "…নির্দেশক্রমে অনুরোধ করা হইল।" | "রাষ্ট্রপতির আদেশক্রমে," | effectiveness line | "ইহা অবিলম্বে কার্যকর হইবে।" | — | শুভেচ্ছান্তে/শ্রদ্ধান্তে + আন্তরিকভাবে আপনার, | — |
| Gazette | no | no | **must** | no | may | no | no | no |
| Number position | top | top | top | top | top | top | top | **bottom** |

Use **প্রজ্ঞাপন** for laws, rules and gazetted officers' appointment, leave and transfer, and **অফিস আদেশ** for internal posting and non-gazetted staff. **[inferred]** For personnel matters, gazetted versus non-gazetted status is the deciding test. **সরকারি পত্র** is never used between ministries ("ইহা সরকারের বিভিন্ন মন্ত্রণালয়/বিভাগসমূহের মধ্যে পত্র বিনিময়ের ক্ষেত্রে ব্যবহৃত হইবে না।"); inter-ministry mail is an **অফিস স্মারক**. Use **পরিপত্র** when one instruction goes to "একাধিক অফিস অথবা ব্যক্তি", and **বিজ্ঞপ্তি** for calls, announcements and legal-process notices. A বিজ্ঞপ্তি may go by SMS or email. **সিদ্ধান্ত প্রস্তাব** (১৪৫) gazettes major policy decisions and the formation of committees or commissions ([SI-2024 pp.42–45][si]). The templates below are transcribed from the ক্রোড়পত্র page images [SI-2024]. Where the format's সাধু phrasing (করা হইল) differs from the filled sample's চলিত phrasing (করা হলো), both are shown.

### সরকারি পত্র (নির্দেশ ১৩৭, ক্রোড়পত্র-১৭)

Purpose (১৩৭(১)): "যে পত্রে সরকারের মতামত অথবা আদেশাবলি জ্ঞাপন করা হইতেছে বলিয়া বুঝায় তাহা অবশ্যই সরকারের নির্দেশে লিখিত হইয়াছে বলিয়া সুস্পষ্টভাবে প্রকাশ করা হইবে। সুপ্রীম কোর্ট, বাংলাদেশ সরকারী কর্ম কমিশন, সরকারি সংস্থাসমূহ এবং ব্যক্তি বিশেষকে সকল আনুষ্ঠানিক মঞ্জুরির বিষয় ও বার্তা জ্ঞাপনের জন্য সরকারি পত্র ব্যবহার করা হইবে। সংযুক্ত দপ্তর ও অধস্তন অফিসগুলিকে সরকারের আনুষ্ঠানিক মঞ্জুরিসমূহের বিষয় জানাইবার জন্যও এই পত্র ব্যবহার করা যাইতে পারে।" Mandatory parts in order (১৩৭(২)): (ক) ‘গণপ্রজাতন্ত্রী বাংলাদেশ সরকার’ এবং মন্ত্রণালয়/বিভাগের নামযুক্ত পত্র শিরোনাম; (খ) পত্রসংখ্যা ও তারিখ; (গ) প্রাপকের পদনাম ও ঠিকানা; (ঘ) বিষয়; (ঙ) সম্ভাষণ; (চ) পত্রের প্রধান বক্তব্য; (ছ) সৌজন্য উক্তি; এবং (জ) প্রেরকের স্বাক্ষর, নাম, পরিচিতি নম্বর (যদি থাকে), পদনাম, টেলিফোন ও ই-মেইল ঠিকানা। Voice (১৩৭(৩)): "সরকারি পত্র উত্তম পুরুষের ভাষ্যে লিখিত হইবে। সরকারি কর্মকর্তাগণের নামে প্রেরিত পত্রাদির শুরুতে ‘জনাব/মহোদয়’ সম্ভাষণ এবং শেষে ‘আপনার বিশ্বস্ত’ সূচক সৌজন্য উক্তি উল্লিখিত থাকিবে। বেসরকারি কর্মকর্তা অথবা ব্যক্তিবর্গের নামে প্রেরিত পত্রাদির শুরুতে ‘প্রিয় মহোদয়/মহোদয়গণ’ সম্ভাষণ এবং উহাদের শেষে ‘আপনার/আপনাদের বিশ্বস্ত’ সৌজন্য উক্তি উল্লিখিত থাকিবে" ([SI-2024 pp.42–43][si]).

```
                       গণপ্রজাতন্ত্রী বাংলাদেশ সরকার              [centre, bold]
                         ………… মন্ত্রণালয়/বিভাগ                [centre]
                           ………….শাখা                         [centre]
                         www.-------.gov.bd                  [centre]
                                                        ……… (বাংলা সন)
নম্বর: ……………………………………                         তারিখ:-----------
                                                        ……… (খ্রিষ্টীয় সন)
প্রাপক :  পদনাম…………………
          অফিসের নাম ও ঠিকানা…………………
বিষয় : ……………………………………………………
সূত্র : (যদি থাকে) ……………………………………………
জনাব/মহোদয়,
        উপর্যুক্ত বিষয় ও সূত্রের বরাতে নির্দেশক্রমে জানাইতেছি যে, ---------------- ।
        ২। ------------------------------------------------ ।
                                                   আপনার বিশ্বস্ত,
                                                   স্বাক্ষর……………
                                                   নাম……………
                                                   পরিচিতি নম্বর (যদি থাকে)……
                                                   পদনাম……………
                                                   ফোন……………
                                                   ই-মেইল……………
নম্বর: ……………………………                                 তারিখ: (stacked)
অবগতি/অবগতি ও প্রয়োজনীয় ব্যবস্থা গ্রহণের জন্য অনুলিপি প্রেরণ করা হইল :
১। ……………… মন্ত্রণালয়/বিভাগ
২। ………
                                                   স্বাক্ষর / নাম / পদনাম
টীকা: (১) বেসরকারি ব্যক্তি অথবা প্রতিষ্ঠানের বরাবর লিখিত পত্রের ক্ষেত্রে সম্ভাষণে ‘প্রিয় মহোদয়/মহোদয়গণ’; সমাপনান্তে ‘আপনার/আপনাদের বিশ্বস্ত’ সৌজন্য উক্তি লিখিতে হইবে।
```

The filled sample (ক্রোড়পত্র-১৭(ক), MoPA কল্যাণ শাখা, 2021) has these lines: "নং ০৫.০০.০০০০.১২৩.০২.০৪৮.২১-০০০" / "প্রাপক: জেলা প্রশাসক / জেলা প্রশাসকের কার্যালয়, খুলনা।" / "বিষয়: বেসামরিক প্রশাসনে চাকরিরত অবস্থায় কোনো সরকারি কর্মচারীর মৃত্যুবরণ এবং গুরুতর আহত হয়ে স্থায়ী অক্ষমতাজনিত আর্থিক অনুদান মঞ্জুরি।" / "সূত্র: জেলা প্রশাসকের কার্যালয়, খুলনা-এর ২০-১২-২০২১ তারিখের ০৫.৪৪.৪৭০০.০২২.১৮.০৩১.২১-১১২০ সংখ্যক স্মারক।" / "মহোদয়," / "উপর্যুক্ত বিষয় ও সূত্রের বরাতে আদিষ্ট হয়ে ... মঞ্জুরি জ্ঞাপন করছি।" The signature block reads "(মোহাম্মদ রফিকুল করিম) / পরিচিতি নম্বর: ১৫০৮৮ / উপসচিব / ফোন: ৯৫৪৯৬২১ / E-mail: adminwelf@mopa.gov.bd". Then comes "নং ০৫.০০.০০০০.১২৩.০২.০৪৮.২১-১৩৭(১/৯)" and the underlined heading "অবগতি/অবগতি ও প্রয়োজনীয় ব্যবস্থা গ্রহণের জন্য অনুলিপি প্রেরণ করা হলো:" ([SI-2024 p.106][si]). The sample's সূত্র form, "<দপ্তর>-এর <তারিখ> তারিখের <নম্বর> সংখ্যক স্মারক।", is the sourced way to write a reference.

### অফিস স্মারক (নির্দেশ ১৩৮, ক্রোড়পত্র-১৮)

When (১৩৮(১)): "সাধারণত অধস্তন অফিস হইতে উর্ধ্বতন অফিসে অফিস স্মারকে পত্র লিখিতে হইবে। এতদ্‌ব্যতীত নিম্নলিখিত ক্ষেত্রে অফিস স্মারক ব্যবহৃত হইবে: (ক) বিভিন্ন মন্ত্রণালয়/বিভাগের মধ্যে পত্র বিনিময়; (খ) সরকারি আদেশের সমতুল্য নহে এমন কোনো তথ্য সংযুক্ত দপ্তর, অধস্তন অফিস/কর্তৃপক্ষ, বিভাগীয় কমিশনার, জেলা ও উপজেলা কর্মকর্তা এবং সরকারের অধীন অন্যান্য কর্মকর্তার নিকট প্রেরণ; এবং (গ) চিঠিপত্র ও আবেদনপত্র ইত্যাদির উত্তর প্রদান।" Form (১৩৮(২)): "অফিস স্মারক নাম পুরুষের ভাষ্যে লিখিত হইবে এবং ইহাতে প্রেরণকারী কর্মকর্তার স্বাক্ষর, নাম, পরিচিতি নম্বর (যদি থাকে), পদনাম ও ই-মেইল ঠিকানা ব্যতীত কোনো সম্ভাষণ অথবা উপসংহারে সৌজন্য উক্তি থাকিবে না। পৃষ্ঠার নিম্ন বামকোণে প্রাপকের পদনাম ও ঠিকানা লিখিতে হইবে। সরকারের নির্দেশে জারি হইতেছে বুঝাইবার জন্য, এইরূপ স্মারকে ‘নির্দেশক্রমে’ এই শব্দ ব্যবহৃত হইবে". To replace a memo issued in error (১৩৮(৩)), mark it "‘একই নম্বর ও তারিখে প্রতিস্থাপিত’". It keeps the same number and date, but "কর্মকর্তার স্বাক্ষর বর্তমান তারিখে হইবে।" ([SI-2024 p.43][si]).

```
          গণপ্রজাতন্ত্রী বাংলাদেশ সরকার / ………মন্ত্রণালয়/বিভাগ / ……শাখা / www.---.gov.bd   [centre]
স্মারক নম্বর : ……………………                              তারিখ : (বাংলা সন / খ্রিষ্টীয় সন)
বিষয় : -----------------------
সূত্র : (যদি থাকে) ------------
        পত্রের বিষয়বস্তু ---------------------------------- ।
        ০২। নির্দেশনা/উদ্দেশ্য/বর্ণনা ---------------------------- নির্দেশক্রমে অনুরোধ করা হইল।
সংযুক্তি (যদি থাকে) :
                                  স্বাক্ষর / নাম / পরিচিতি নম্বর (যদি থাকে) / পদনাম / ফোন / ই-মেইল   [right]
পদনাম : ………………                         [recipient, bottom-LEFT]
অফিসের নাম ও ঠিকানা : ………………
স্মারক নম্বর: ……………                              তারিখ : …
অবগতি/অবগতি ও প্রয়োজনীয় ব্যবস্থা গ্রহণের জন্য অনুলিপি প্রেরণ করা হইল :
১। ……  ২। ……                            স্বাক্ষর / নাম / পদনাম
```

The filled sample (ক্রোড়পত্র-১৮(ক), 2023) reads: "স্মারক নং-০৫.০০.০০০০.২০৬.২২.০০৩.২১-১২৩", dated "১৭ বৈশাখ ১৪৩০ / ৩০ এপ্রিল ২০২৩"; "বিষয়ঃ ‘সচিবালয় নির্দেশমালা ২০১৪’ হালনাগাদকরণের লক্ষ্যে প্রস্তুতকৃত প্রাথমিক খসড়ার উপর মতামত প্রদান।"; it ends "...মতামত প্রদানের জন্য নির্দেশক্রমে অনুরোধ করা হলো।"; then "সংযুক্তি: বর্ণনামোতাবেক তুলনামূলক বিবরণী ও ক্রোড়পত্রসমূহ।"; signed "(রোকসানা রহমান) / পরিচিতি নম্বর: ১৬০২১ / উপসচিব"; recipient bottom-left "সিনিয়র সচিব/সচিব / ………… মন্ত্রণালয়/বিভাগ"; then "অবগতির জন্য অনুলিপি প্রেরণ করা হলো :" with entries like "সিনিয়র সচিবের একান্ত সচিব, জনপ্রশাসন মন্ত্রণালয় (সিনিয়র সচিব মহোদয়ের সদয় অবগতির জন্য)।" ([SI-2024 p.108][si]). The 2014 rules, as quoted secondarily, also required distribution to list কার্যার্থে and জ্ঞাতার্থে recipients separately ([bdservicerules.info][bdsr-memo]).

### আধা-সরকারি পত্র / ডি.ও. (নির্দেশ ১৪১, ক্রোড়পত্র-২১)

Rule (১৪১, verbatim): "(১) কোনো বিষয়ে প্রাপকের ব্যক্তিগত মনোযোগ আকর্ষণ প্রয়োজনীয় বিবেচিত হইলে সরকারি কর্মকর্তাগণের মধ্যে পত্র বিনিময়ের ক্ষেত্রে আধাসরকারি পত্র ব্যবহার করা হইবে। এই পত্র কর্মকর্তার স্বীয় প্যাডে লিখা যাইতে পারে। (২) এই পত্র প্রাপক কর্মকর্তার নাম উল্লেখপূর্বক তাঁহার নিকট প্রেরিত হইবে। ইহা ‘প্রিয়-------,’ ‘জনাব/মহোদয়-------,’ সম্ভাষণসহ উত্তম পুরুষ একবচনে লিখিত হইবে এবং ইহার শেষে ‘আন্তরিকভাবে আপনার’ সৌজন্যসূচক উক্তি থাকিবে। প্রাপক কর্মকর্তা একই পদমর্যাদাসম্পন্ন অথবা কনিষ্ঠ হইলে সাধারণত ‘প্রিয় …….’ সম্ভাষণ এবং যদি প্রাপক কর্মকর্তা পদমর্যাদায় পত্র প্রেরক অপেক্ষা এক অথবা দুই ধাপ উচ্চতর পর্যায়ের হন, তাহা হইলে ‘প্রিয় জনাব/মহোদয়’ সম্ভাষণ ব্যবহার করিতে হইবে। যদি প্রাপক কর্মকর্তা পত্র লেখক অপেক্ষা তিন অথবা ততোধিক ধাপ উচ্চ পর্যায়ের হন, তাহা হইলে ‘প্রিয় মহোদয়’ অভিবাদন ব্যবহার করা হইবে। পত্র প্রেরকের নাম ও পদনাম পত্রের প্রথম পৃষ্ঠায় শীর্ষস্থানের ডানদিকে থাকিবে। প্রেরকের টেলিফোন নম্বর ও ই-মেইল ঠিকানা অবশ্যই পত্রে উল্লেখ করিতে হইবে। পত্রের শেষে বাম দিকে শুভেচ্ছান্তে/শ্রদ্ধান্তে (স্বহস্তে) লিখিতে হইবে" ([SI-2024 p.44][si]).

```
(অফিসিয়াল প্যাড)
                                              পত্র প্রেরকের নাম ----------   [TOP-RIGHT block]
                                              পদনাম ----------
                                              ফোন ----------
                                              মোবাইল নম্বর ……
                                              ই-মেইল ----------
আধা-সরকারি পত্র নম্বর : ………………                    তারিখ: (বাংলা / খ্রিষ্টীয়)
প্রিয়……/জনাব/মহোদয়, (সম্ভাষণ স্বহস্তে লিখনীয়)
     পূর্বাপর উল্লেখপূর্বক পত্রের বিষয়বস্তু ------------------------ ।
     ২। সুনির্দিষ্ট প্রস্তাবনা ------------------------- ।
শুভেচ্ছান্তে/শ্রদ্ধান্তে, (স্বহস্তে লিখনীয়)                       [LEFT]
                                              আন্তরিকভাবে আপনার,          [RIGHT]
                                              স্বাক্ষর ----------
                                              পত্র প্রেরকের নাম ------
প্রাপকের নাম ------                                            [bottom-LEFT]
পদনাম ------
ঠিকানা ------
টীকা: (১) আধা-সরকারি পত্র আবশ্যিকভাবে ব্যক্তি নামে প্রেরণ করিতে হইবে। ইহা উত্তম পুরুষ একবচনে লিখিত হইবে।
      (২) প্রযোজ্য ক্ষেত্রে আধা-সরকারি পত্রের অনুলিপি দেওয়া যাইবে। তবে মূলপত্রে অনুলিপি না লিখাই শ্রেয়।
```

There is **no বিষয় line**. Salutation and closing are handwritten, so a generator should leave the salutation blank or fill it in a script-like style and flag it for hand completion. The sample (২১(ক)) uses "প্রিয় জেলা প্রশাসক,", opens "আপনি নিশ্চয় অবগত রয়েছেন যে, ...", continues "২। আপনি আরও অবগত রয়েছেন যে, ...", and ends "...সার্বিক সহযোগিতা প্রদানের জন্য আপনাকে বিশেষভাবে অনুরোধ করছি।", with "জনাব…………… / জেলা প্রশাসক……" at the bottom left ([SI-2024 p.114][si]).

### প্রজ্ঞাপন, including the gazette layout (নির্দেশ ১৪৪, ক্রোড়পত্র-২৪)

Rule (১৪৪): "আইন, অধ্যাদেশ, বিধি, প্রবিধান, আদেশ, গেজেটেড কর্মকর্তাগণের নিয়োগ আদেশ, ছুটি ও বদলি এবং অন্যান্য বিষয়াদি যেগুলি বাংলাদেশ গেজেটে প্রজ্ঞাপিত করা প্রয়োজন সেইগুলির জন্য এই রীতি অনুসরণ করা হইবে। উহা মহামান্য রাষ্ট্রপতির আদেশে জারি হইতেছে বুঝাইবার জন্য, এইরূপ প্রজ্ঞাপন ‘রাষ্ট্রপতির আদেশক্রমে’ লিখিয়া স্বাক্ষর করিতে হইবে" ([SI-2024 p.45][si]).

```
       গণপ্রজাতন্ত্রী বাংলাদেশ সরকার / ……মন্ত্রণালয়/বিভাগ / ……শাখা / www.---.gov.bd      [centre]
নম্বর : ……………………                              তারিখ : (বাংলা / খ্রিষ্টীয়)
                              প্রজ্ঞাপন                                           [centre, bold]
     ------------------------------------------------------------- ।
     ২। -------------------------------------------------------- ।
                                         রাষ্ট্রপতির আদেশক্রমে,                  [right]
                                         প্রেরণকারীর স্বাক্ষর ------
                                         পদনাম / পরিচিতি নম্বর (যদি থাকে) / ফোন / ই-মেইল
স্মারক নম্বর : ……………                        তারিখ: …
অবগতি/অবগতি ও প্রয়োজনীয় ব্যবস্থা গ্রহণের জন্য অনুলিপি প্রেরণ করা হইল :
১। ……  ২। ……
৩। উপনিয়ন্ত্রক, বাংলাদেশ সরকারী মুদ্রণালয়, মুদ্রণ ও প্রকাশনা অধিদপ্তর, তেজগাঁও, ঢাকা, (বিজ্ঞপ্তিটি বাংলাদেশ গেজেটে প্রকাশের অনুরোধসহ)।
টীকা: (১) প্রজ্ঞাপন রাষ্ট্রপতির আদেশে জারি হইতেছে বুঝাইবার জন্য ‘রাষ্ট্রপতির আদেশক্রমে’ লিখিয়া জারি করিতে হইবে। (২) প্রজ্ঞাপন গেজেটে প্রকাশ করিতে হইবে।
```

There is no বিষয়, no salutation and no addressee. The copy list must include the Government Press. The 2016 sample (২৪(ক)) opens "সরকার … সিদ্ধান্ত গ্রহণ করেছে।" Its effective-date paragraph is "৩। ১ জুলাই ২০১৬ তারিখ হতে মৃত্যু/স্থায়ী অক্ষম হওয়ার ক্ষেত্রে প্রজ্ঞাপনটি কার্যকর হবে।" It is signed "রাষ্ট্রপতির আদেশক্রমে, / স্বাক্ষর / (আলেয়া আক্তার) / পরিচিতি নম্বর: ৫৬১৪ / উপসচিব". Its copy list includes "উপ-পরিচালক, বাংলাদেশ ফরমস্ ও প্রকাশনা অফিস, তেজগাঁও, ঢাকা (পরবর্তী গেজেটে প্রকাশ এবং গেজেটের ১০০ (একশত) কপি প্রেরণের অনুরোধসহ)।" and "সিনিয়র সিস্টেম এনালিস্ট, জনপ্রশাসন মন্ত্রণালয় (ওয়েবসাইটে প্রকাশের অনুরোধসহ)।" ([SI-2024 p.120][si]). As printed in an extraordinary gazette (31 Aug 2024), the number runs into the first sentence with "।—" and the date is on a single line ([Bangladesh Gazette][gazette]):

```
রেজিস্টার্ড নং ডি এ-১                                        [top-left]
          বাংলাদেশ   [state emblem]   গেজেট                    [masthead]
                    অতিরিক্ত সংখ্যা
                 কর্তৃপক্ষ কর্তৃক প্রকাশিত
               শনিবার, আগস্ট ৩১, ২০২৪                         [between double rules]
              গণপ্রজাতন্ত্রী বাংলাদেশ সরকার
               মুক্তিযুদ্ধ বিষয়ক মন্ত্রণালয়
                      গেজেট শাখা
                       প্রজ্ঞাপন
     তারিখ : ১৭ শ্রাবণ ১৪৩১ বঙ্গাব্দ/০১ আগস্ট ২০২৪ খ্রিষ্টাব্দ
নং ৪৮.০০.০০০০.০০৪.৪০.০৩১.২৪.৩১০৯।—জাতীয় মুক্তিযোদ্ধা কাউন্সিল আইন, ২০২২ (২০২২ সনের ১৫ নং আইন) এর ৬ (খ) ধারা এবং Rules of Business 1996 এর Schedule-1 ... এ প্রদত্ত ক্ষমতাবলে ... নিম্নোক্তভাবে প্রকাশ করা হলো :
   [table]
০২। যথাযথ কর্তৃপক্ষের অনুমোদনক্রমে এ আদেশ জারি করা হলো।
                                                রাষ্ট্রপতির আদেশক্রমে
                                                হরিদাস ঠাকুর
                                                উপসচিব।
[footer: … বাংলাদেশ সরকারী মুদ্রণালয়, তেজগাঁও … www.bgpress.gov.bd / (page) / মূল্য : টাকা ৪.০০]
```

Statutory rules additionally carry an "এস.আর.ও. নং …-আইন/২০২৪" number ([DPP listing][dpp]; [Legislative Division S.R.O. list][srolist]). Non-government bodies (universities, trusts, companies) **never** issue a "প্রজ্ঞাপন … রাষ্ট্রপতির আদেশক্রমে" **[inferred]**.

### পরিপত্র (নির্দেশ ১৪০, ক্রোড়পত্র-২০)

Rule: "একাধিক অফিস অথবা ব্যক্তির নামে পত্রজারি করিবার প্রয়োজন হইলে পরিপত্র আকারে জারি করিতে হইবে। ক্ষেত্রবিশেষে প্রয়োজন অনুযায়ী অনুলিপির আকারে ইহা জারি করা যাইতে পারে" ([SI-2024 p.43][si]). Layout: header block, নম্বর and stacked তারিখ, centred bold **পরিপত্র**, "বিষয় : ------", an unnumbered first paragraph, then "২।", "৩।", a right-aligned signature block (স্বাক্ষর / নাম / পরিচিতি নম্বর (যদি থাকে) / পদনাম / ফোন / ই-মেইল), and "বিতরণ :" with a numbered list ([SI-2024 p.111][si]). The 2018 quota sample (২০(ক)) reads "নম্বর: ০৫.০০.০০০০.১৭০.১১.০০৭.১৮-২৭৬" / "পরিপত্র" / "বিষয়: সরকারি দপ্তর, স্বায়ত্তশাসিত/আধা-স্বায়ত্তশাসিত প্রতিষ্ঠান এবং বিভিন্ন কর্পোরেশনের চাকরিতে সরাসরি নিয়োগের ক্ষেত্রে সরকারের বিদ্যমান কোটা পদ্ধতি সংশোধন।" Its body runs "সরকার … নিম্নরূপভাবে সংশোধন করিল:-" with sub-items (ক), (খ), then "২। ইহা অবিলম্বে কার্যকর হইবে।" The distribution includes "উপপরিচালক, বাংলাদেশ সরকারী মুদ্রণালয়, তেজগাঁও, ঢাকা [পরবর্তী গেজেটে প্রকাশের জন্য এবং গেজেটের ৫০০ (পাঁচশত) কপি প্রেরণের অনুরোধসহ]।" and "সিনিয়র সিস্টেম এনালিস্ট ... (পরিপত্রটি ওয়েবসাইটে প্রকাশের অনুরোধসহ)।" ([SI-2024 p.112][si]).

### অফিস আদেশ (নির্দেশ ১৩৯, ক্রোড়পত্র-১৯)

Rule: "অফিসে অনুসরণীয় নির্দেশাবলি জ্ঞাপন, অভ্যন্তরীণ পদায়ন ও নন-গেজেটেড কর্মচারীগণের নিয়োগ, পদোন্নতি, ছুটি ইত্যাদি বিজ্ঞাপিত করিবার জন্য অফিস আদেশ ব্যবহার করা হইবে" ([SI-2024 p.43][si]). Layout: header, নম্বর and stacked তারিখ, centred bold **অফিস আদেশ**, then the body with **no বিষয়, addressee or salutation** and numbered "২।" paragraphs. The signature (স্বাক্ষর / নাম / পদনাম / ফোন / ই-মেইল) is right-aligned, followed by a second নম্বর/তারিখ line, "অবগতি/অবগতি ও প্রয়োজনীয় ব্যবস্থা গ্রহণের জন্য অনুলিপি প্রেরণ করা হইল :" with a list, and a second signature ([SI-2024 p.109][si]). The 2023 Cabinet Division sample (১৯(ক)) reads "নম্বর: ০৪.০০.০০০০.৪১১.২৫.০০১.২৩-৯৭" / "অফিস আদেশ" / "জনপ্রশাসন মন্ত্রণালয়ের ০৭.০২.২০২৩ তারিখের ০৫.০০.০০০০.২০০.২৫.০০১.১৯-২৫ সংখ্যক স্মারকের পরিপ্রেক্ষিতে ... ১৩.০২.২০২৩ তারিখে এ বিভাগ থেকে অবমুক্ত করা হলো।" / "২। ... অতিরিক্ত দায়িত্ব প্রদান করা হলো। এ জন্য তিনি বিধি মোতাবেক দায়িত্বভাতা প্রাপ্য হবেন।" Its stock closing is **"৩। যথাযথ কর্তৃপক্ষের অনুমোদনক্রমে জনস্বার্থে জারিকৃত এ আদেশ অবিলম্বে কার্যকর হবে।"** It is signed "(লুবনা সিদ্দিকী) / পরিচিতি নম্বর: ১৫৩০৪ / উপসচিব", with copy number "…২৩-৯৭(১/৮)" ([SI-2024 p.110][si]).

### বিজ্ঞপ্তি/নোটিশ and সভার নোটিশ (নির্দেশ ১৪৮, ক্রোড়পত্র-২৬, ২৬(ক), ২৬(খ))

Rule: "কোনো বিষয়ের আহ্বান, ঘোষণা অথবা তথ্য প্রদান অথবা বাধ্যবাধকতা কিংবা আইনি প্রক্রিয়াকে কার্যকর করিবার লক্ষ্যে অথবা কোনো বিষয় জ্ঞাতকরণের নিমিত্ত বিজ্ঞপ্তি/নোটিশ ব্যবহার করা যাইবে ... এসএমএস, ই-মেইল অথবা অপর কোনো ডিজিটাল পদ্ধতিতেও বিজ্ঞপ্তি জারি করা যাইবে।" ([SI-2024 p.45][si]). Layout: header, নম্বর/তারিখ, centred **বিজ্ঞপ্তি**, "বিষয় : ----", body, "২।", "সংযুক্তি : (যদি থাকে)", right-aligned signature, then "বিতরণ (জ্ঞাতার্থে/জ্ঞাতার্থে ও কার্যার্থে) :" with a list ([SI-2024 p.123][si]). The 2023 sample's subject is "বিষয় : অস্ট্রেলিয়া এডওয়ার্ড স্কলারশিপের আওতায় মাস্টার্স কোর্সে অধ্যয়নের জন্য আবেদনের সুযোগ।" and its opener is "উপর্যুক্ত বিষয়ের পরিপ্রেক্ষিতে জানানো যাচ্ছে যে, ..." ([SI-2024 p.124][si]). The meeting notice sample (২৬(খ)) is the only SI template for meetings:

```
গণপ্রজাতন্ত্রী বাংলাদেশ সরকার / জনপ্রশাসন মন্ত্রণালয় / পরিসংখ্যান ও গবেষণা কোষ / www.mopa.gov.bd
নম্বর: ০৫.০০.০০০০.১৬১.১৫.০০৮.২৩-১২৮                    তারিখ: ৫ আষাঢ় ১৪৩০ / ১৯ জুন ২০২৩
                              সভার নোটিশ
বিষয় : সচিবালয় নির্দেশমালা ২০১৪ হালনাগাদকরণের লক্ষ্যে গঠিত আন্তঃমন্ত্রণালয় কমিটির সভা।
     সচিবালয় নির্দেশমালা ২০১৪ হালনাগাদকরণের লক্ষ্যে গঠিত আন্তঃমন্ত্রণালয় কমিটির ৫ম সভা আন্তঃমন্ত্রণালয় কমিটির আহবায়ক ও অতিরিক্ত সচিব (সওগ), জনপ্রশাসন মন্ত্রণালয়-এর সভাপতিত্বে আগামী ১৬.০৫.২০২৩ তারিখ সকাল ১০:০০ টায় সংস্কার ও গবেষণা অনুবিভাগের সম্মেলন কক্ষে (ভবন নং-৬, কক্ষ নং-১৪০২) অনুষ্ঠিত হবে।
২।   উক্ত সভায় কমিটির সকল সদস্যকে উপস্থিত থাকার জন্য নির্দেশক্রমে অনুরোধ করা হলো।
                                              (রোকসানা রহমান) / উপসচিব / ফোন / ই-মেইল
বিতরণ :  ১। যুগ্মসচিব (...), ...
অবগতি/অবগতি ও প্রয়োজনীয় ব্যবস্থা গ্রহণের জন্য অনুলিপি প্রেরণ করা হলো:
১। উপসচিব (প্রশাসন-৪ শাখা), জনপ্রশাসন মন্ত্রণালয় (সভায় ২০ জন কর্মকর্তার আপ্যায়নের ব্যবস্থা গ্রহণের অনুরোধসহ)।
২। সিনিয়র সচিবের একান্ত সচিব ... (সিনিয়র সচিব মহোদয়ের সদয় অবগতির জন্য)।
```

The official sample has a defect: it schedules the meeting for ১৬.০৫.২০২৩ but is dated ১৯ জুন ২০২৩. **A generator should validate that a meeting date falls after the issue date** ([SI-2024 p.125][si]).

### সভার কার্যবিবরণী (minutes): required, but no SI template

SI-2024 requires minutes but gives no format: "যে-কোনো মাধ্যমে সভা আয়োজনের ক্ষেত্রে যথানিয়মে সভার নোটিশ ও কার্যবিবরণী প্রস্তুত করিতে হইবে এবং ই-মেইল/ডিজিটাল পদ্ধতিতে/কাস্টমাইজড সফটওয়্যার (customised software) ব্যবহার করিয়া উহা বিতরণ করিতে হইবে।" It also says "সময় ও ব্যয় সাশ্রয়ের লক্ষ্যে ক্ষেত্রমতে, ভার্চুয়াল প্লাটফর্মের মাধ্যমে সভা অনুষ্ঠান করিতে হইবে।" ([SI-2024 p.10][si]). Field practice supplies the rest. Attendance goes to an annex, "সভায় উপস্থিত সদস্যবৃন্দের তালিকা পরিশিষ্ট ‘‘ক’’-তে উল্লেখ করা হলো।" ([Chauddagram Upazila][chaud]; [Matubhuiyan UP][matu]). Minutes open with the chair ("১ম সভার কার্যবিবরণী: সভাপতি …, জেলা প্রশাসক, ঢাকা") and pair each decision with an implementing officer ([dhaka.gov.bd][dhaka]). The date and time are written like "সভার তারিখ ১৪ নভেম্বর, ২০১৬ খ্রি:, সকাল ১১:০০ ঘটিকা" ([Basail Upazila][basail]). **[convention]** The skeleton below is assembled from that practice. Its closing sentence is common wording but was not found verbatim in a fetched source.

```
গণপ্রজাতন্ত্রী বাংলাদেশ সরকার / [দপ্তর] / [শাখা] / www.---.gov.bd
                    [কমিটির নাম]-এর [ক্রম] সভার কার্যবিবরণী
সভাপতি      : [নাম, পদবি]
সভার তারিখ   : [তারিখ]
সময়         : [সকাল ১০:০০ টা]
স্থান        : [সম্মেলন কক্ষ]
উপস্থিত সদস্যবৃন্দ : পরিশিষ্ট ‘ক’ (সভায় উপস্থিত সদস্যবৃন্দের তালিকা পরিশিষ্ট ‘ক’-তে উল্লেখ করা হলো।)
     সভাপতি উপস্থিত সকলকে স্বাগত জানিয়ে সভার কার্যক্রম শুরু করেন। …
| ক্রম | আলোচ্যসূচি | আলোচনা | সিদ্ধান্ত | বাস্তবায়নে |
০২। সভায় আর কোনো আলোচ্য বিষয় না থাকায় সভাপতি উপস্থিত সকলকে ধন্যবাদ জানিয়ে সভার সমাপ্তি ঘোষণা করেন।
                                                   (নাম) / সভাপতি / [পদবি]
নম্বর: …                                            তারিখ: …
বিতরণ (জ্যেষ্ঠতার ক্রমানুসারে নয়): ১। … ২। … ৩। সংরক্ষণ নথি।
```

### নথি নোট, সারসংক্ষেপ, UO note, endorsement and fax

Notes follow নির্দেশ ১১১–১৩০. A formal note contains, in order (১১৪): "(১) সংশ্লিষ্ট বিষয় সম্পর্কিত তথ্যাদি ...; (২) বিষয়টি সম্পর্কে ব্যবস্থা গ্রহণের জন্য অনুসরণীয় বিধিবদ্ধ অথবা প্রথাগত কার্যপদ্ধতি; (৩) বিষয়টিকে প্রভাবিত করে এইরূপ সকল বিধি অথবা নিয়ম-কানুন; (৪) এতৎসংক্রান্ত অন্য কোনো তথ্যাদি অথবা পরিসংখ্যান; (৫) সিদ্ধান্ত গ্রহণের নির্দিষ্ট প্রসঙ্গসমূহ ও পূর্ব নজির; এবং (৬) সুনির্দিষ্ট প্রস্তাব।" The physical form (১১৫) is the closest thing to an official page-setup rule anywhere in the corpus: "**এক-পঞ্চমাংশ মার্জিন রাখিয়া ‘A4’ আকারের নোটশিটের উপর** প্রতিটি নোট কালিতে অথবা কম্পিউটার টাইপে লিপিবদ্ধ করিতে হইবে।" Further rules: "নোটসমূহের একটিমাত্র ধারাবাহিক অনুক্রমই … থাকিবে।"; "সকল নোটের অনুচ্ছেদে ধারাবাহিকভাবে সংখ্যা দিতে হইবে।"; and on multi-page notes, initial each page and "শেষ পৃষ্ঠায় সিলমোহরসহ স্বাক্ষর করিবেন।" Routing (১২১): "প্রশাসনিক কর্মকর্তা কোনো বিষয়ে নোট লিখিয়া নোটশিটের বামপার্শ্বে স্বীয় নাম ও পদনাম প্রদর্শনপূর্বক তারিখসহ স্বাক্ষর করিবেন এবং একই লাইনে ডানপার্শ্বে শাখার দায়িত্বে নিয়োজিত কর্মকর্তার পদনাম চিহ্নিত করিয়া নথি পেশ করিবেন।" and "কোনো নথির ঊর্ধ্বমুখী গতির সময় ডানপার্শ্বে এবং নিম্নমুখী গতির সময় বামপার্শ্বে প্রাপক কর্মকর্তার পদনাম চিহ্নিত করিতে হইবে।" Correspondence pages are cited as "পত্রপৃষ্ঠা ১৩-১৪" (১২০(২)). Summarising rather than quoting is preferred (১২৪). On tone (১২৬): "সকল নোট শোভন ও মার্জিত শব্দ প্রয়োগে লিখিতে হইবে। ব্যক্তিগত মন্তব্য, আবেগ ও বাহুল্য পরিহার করিয়া নিরপেক্ষভাবে নোট প্রদান করিতে হইবে।" ([SI-2024 pp.36–40][si]).

```
[নোটাংশ, A4, 1/5 margin]
অনুচ্ছেদ ১। [তথ্যাদি] … (পত্রপৃষ্ঠা ১৩-১৪)
অনুচ্ছেদ ২। [প্রযোজ্য বিধি/কার্যপদ্ধতি] …
অনুচ্ছেদ ৩। [পূর্ব নজির] …
অনুচ্ছেদ ৪। [সুনির্দিষ্ট প্রস্তাব] … বিবেচনা ও অনুমোদনের জন্য উপস্থাপন করা হলো।
[স্বাক্ষর, তারিখ]                                           [উপরের কর্মকর্তার পদনাম]
[নাম, পদনাম]  (LEFT: writer)                                (RIGHT: next officer, upward movement)
```

The **সারসংক্ষেপ** (ক্রোড়পত্র-১৬) is printed on "মনোগ্রামযুক্ত নির্ধারিত সবুজ কাগজে" (১১৭). It has the state emblem on the left, "মহামান্য রাষ্ট্রপতি/মাননীয় প্রধানমন্ত্রীর জন্য সারসংক্ষেপ" centred, and "সংখ্যা-" / তারিখ. Paragraphs run "বিষয়ের সংক্ষিপ্ত ও স্বয়ংসম্পূর্ণ ও বাহুল্যবর্জিত বর্ণনা ... ২। বরাতসূত্র ও সংলাগসহ প্রস্তাবের সঙ্গে সম্পর্কিত আইন, বিধি-বিধান, পরিপত্র, পূর্ব নজির ইত্যাদির বর্ণনা ... ৩। প্রস্তাবের স্বপক্ষে যৌক্তিকতা ... ৪। সুনির্দিষ্ট প্রস্তাব/সুপারিশ ... ৫। অনুচ্ছেদ-৪ এর প্রস্তাব মহামান্য রাষ্ট্রপতি/মাননীয় প্রধানমন্ত্রীর সদয় বিবেচনা ও সানুগ্রহ অনুমোদনের জন্য উপস্থাপন করা হইল।" The approval ladder follows: "সচিব" at right, then "মাননীয় প্রতিমন্ত্রী / মাননীয় মন্ত্রী / মাননীয় প্রধানমন্ত্রী / মহামান্য রাষ্ট্রপতি" ([SI-2024 pp.37, 102][si]).

The **অনানুষ্ঠানিক (UO) নোট** (১৪২) carries advice between ministries and within one: "মন্ত্রণালয়/বিভাগসমূহ এবং সংযুক্ত দপ্তরসমূহের মধ্যে পরামর্শ ও মতামত গ্রহণ এবং মন্ত্রণালয়/বিভাগের অভ্যন্তরীণ যোগাযোগের ক্ষেত্রে অনানুষ্ঠানিক নোট ব্যবহৃত হইবে।" Its format (ক্রোড়পত্র-২২) has no government header. The ministry and শাখা go top-right, then বিষয়, সূত্র, body and "২। প্রস্তাবনা", then a signature with an **ইন্টারকম নম্বর** and the recipient bottom-left. Below a rule comes "ইউ ও নোট নম্বর:" left and তারিখ right. Its টীকা reads: "অনানুষ্ঠানিক নোট মূলত পত্র হিসাবেই ব্যবহৃত হয়, নোটশিট হিসাবে নহে". The UO opener is "উপর্যুক্ত বিষয়ে সূত্রোক্ত স্মারকের পরিপ্রেক্ষিতে জানানো যাচ্ছে যে," ([SI-2024 pp.44, 115–116][si]). **Endorsement** (১৪৩): copies use "‘অবগতি/অবগতি ও প্রয়োজনীয় ব্যবস্থা গ্রহণের জন্য অনুলিপি প্রেরণ করা হইল’". When ministry খ forwards ministry ক's order it closes "এ আদেশ পৃষ্ঠাঙ্কন করিয়া ……… প্রাপক কর্মকর্তার দপ্তরে প্রেরণের প্রয়োজনীয় ব্যবস্থা গ্রহণের জন্য অনুরোধ করা হইল।" ([SI-2024 pp.44, 117][si]). A **fax** (২৫(ক)/(খ)) puts "অনতিবিলম্বে কার্যক্রম গ্রহণ প্রয়োজন" top-right, then the header and the title "ফ্যাক্স বার্তা". It uses "মহোদয়," with "শুভেচ্ছান্তে," left and "আপনার বিশ্বস্ত," right. The English version uses "Need Immediate Action." / "Dear Sir," / "Regards, Yours sincerely," / "Copy forwarded for kind information/Necessary Action:" ([SI-2024 pp.121–122][si]).

### D-Nothi supplies the frame; the drafter supplies the content

SI-2024 makes the digital nothi the default and requires system templates: "ডিজিটাল নথি সিস্টেমে প্রতিলিপি তৈরি করিবার ক্ষেত্রে সিস্টেমে অন্তর্ভুক্ত যথাযথ পত্রের টেমপ্লেট ব্যবহার করিতে হইবে।" (নির্দেশ ৬০). Issued letters reach recipients "স্বয়ংক্রিয়ভাবে" and are filed automatically as the office copy (৬৬(২)). Numbers are assigned automatically: "ডিজিটাল নথি ব্যবস্থাপনায় নথি নম্বর অথবা সনাক্তকরণ চিহ্ন যুক্ত করিবার স্বয়ংক্রিয় ব্যবস্থা থাকিবে।" (৪২(৪)–(৫)). Copies and endorsements also run in the system (১৪৩(৩)) ([SI-2024 pp.19–25, 44][si]). e-Nothi is now called D-Nothi, with manuals hosted by the Finance Division ([mof.gov.bd manual][dnothi]). The manual text itself was not retrieved. **[inferred]** For D-Nothi output, an agent should supply only the বিষয়, সূত্র, body, recipient list and অনুলিপি list, because the template fills the header, number, dual date and digital signature.

### Universities, autonomous bodies, NOCs and certificates

Under the applicability clause, offices outside the Secretariat may use SI-2024 formats. In universities the **রেজিস্ট্রার** signs অফিস আদেশ and বিজ্ঞপ্তি with the উপাচার্য's approval. Examples: Begum Rokeya University orders were "রেজিস্ট্রার স্বাক্ষরিত" with the VC's "অনুমোদন ক্রমে" ([Lalmonibarta][brur]); PSTU suspension orders came from the registrar ([দেশ রূপান্তর][pstu]); and a JnU controversy arose when a registrar signed transfers without the VC's knowledge ([Jugantor][jnu]). University Acts give the registrar powers the VC delegates ([bdlaws][lstu]). UGC issues অফিস আদেশ under the same headings ([ugc.gov.bd][ugc]). Web notices may instead be signed by the জনসংযোগ দফতর ([du.ac.bd][du]). **[convention]** The adapted header uses the institution's own name and logo in place of "গণপ্রজাতন্ত্রী বাংলাদেশ সরকার" (keep that line only for government departments and অধিদপ্তর), then দপ্তর/শাখা, then ঠিকানা · www.<domain> · email. A typical closing is "উপাচার্য মহোদয়ের অনুমোদনক্রমে এ আদেশ জারি করা হলো এবং তা অবিলম্বে কার্যকর হবে।" with signature "<নাম> / রেজিস্ট্রার (অতিরিক্ত দায়িত্ব)". Copy lists run "১। উপাচার্য মহোদয়ের দপ্তর (উপাচার্য মহোদয়ের সদয় অবগতির জন্য) … সংশ্লিষ্ট নথি।" Whether BDREN uses "গণপ্রজাতন্ত্রী বাংলাদেশ সরকার" is unverified.

SI-2024 has no general NOC or certificate format. Passport NOCs are a recognised type: DIP publishes a "বিভাগীয় অনাপত্তি সনদ (Noc) নমুনা ফরম" ([dip.gov.bd][dip]), and agencies post individual NOCs ([nsda.gov.bd][nsda]). The following skeletons are **[convention]**. For an NOC: standard header, number and date, centred **অনাপত্তি সনদ / অনাপত্তি পত্র**, then "এই মর্মে অনাপত্তি প্রদান করা যাচ্ছে যে, জনাব/বেগম <নাম>, <পদবি>, <দপ্তর> ... <উদ্দেশ্য: পাসপোর্ট প্রাপ্তি/বিদেশ ভ্রমণ/উচ্চশিক্ষা> ... বিষয়ে এ দপ্তরের কোনো আপত্তি নেই।", then signature and অনুলিপি. For a **প্রত্যয়নপত্র**: header, number and date, centred **প্রত্যয়নপত্র**, then "এই মর্মে প্রত্যয়ন করা যাচ্ছে যে, <নাম>, পিতা/মাতা ..., <পদবি/শিক্ষার্থী আইডি> ... । আমার জানামতে তিনি ... । আমি তাঁর সর্বাঙ্গীণ মঙ্গল কামনা করি।", with signature and seal on the right.

### Stock phrases an agent can reuse

The sourced openers come from the SI-2024 formats and samples. For সরকারি পত্র: "উপর্যুক্ত বিষয় ও সূত্রের বরাতে নির্দেশক্রমে জানাইতেছি যে," and "উপর্যুক্ত বিষয় ও সূত্রের বরাতে আদিষ্ট হয়ে …". For বিজ্ঞপ্তি: "উপর্যুক্ত বিষয়ের পরিপ্রেক্ষিতে জানানো যাচ্ছে যে,". For UO notes: "উপর্যুক্ত বিষয়ে সূত্রোক্ত স্মারকের পরিপ্রেক্ষিতে জানানো যাচ্ছে যে,". For DO letters: "আপনি নিশ্চয় অবগত রয়েছেন যে,". The sourced closings are "…নির্দেশক্রমে অনুরোধ করা হইল/হলো।" (স্মারক, সভার নোটিশ, UO); "যথাযথ কর্তৃপক্ষের অনুমোদনক্রমে জনস্বার্থে জারিকৃত এ আদেশ অবিলম্বে কার্যকর হবে।" (অফিস আদেশ); "ইহা অবিলম্বে কার্যকর হইবে।" (পরিপত্র); and "… তারিখ হতে কার্যকর হবে।" (প্রজ্ঞাপন). The sourced copy-list purposes are "(সিনিয়র সচিব মহোদয়ের সদয় অবগতির জন্য)", "(ওয়েবসাইটে প্রকাশের অনুরোধসহ)" and "(পরবর্তী গেজেটে প্রকাশ এবং গেজেটের ১০০ (একশত) কপি প্রেরণের অনুরোধসহ)" ([SI-2024][si]). **[convention]** Other common forms: "বিতরণ (জ্যেষ্ঠতার ক্রমানুসারে নয়):"; "অনুলিপি (জ্যেষ্ঠতার ক্রমানুসারে নয়):"; "সদয় অবগতি ও প্রয়োজনীয় কার্যার্থে অনুলিপি প্রেরণ করা হলো (জ্যেষ্ঠতার ক্রমানুসারে নয়):"; tail entries "মন্ত্রীর একান্ত সচিব, … (মন্ত্রী মহোদয়ের সদয় অবগতির জন্য)" and "সংরক্ষণ নথি।"; বিষয় lines ending "…প্রসঙ্গে।" or "…সংক্রান্ত।"; and "সংযুক্তি: [বর্ণনা] (… পাতা)" placed at the left before the signature.

## Bangla law and প্রমিত spelling govern the wording

The **বাংলা ভাষা প্রচলন আইন, ১৯৮৭** (Act 2 of 1987), section 3(1): "এই আইন প্রবর্তনের পর বাংলাদেশের সর্বত্র সরকারি অফিস, আদালত, আধা-সরকারি, স্বায়ত্তশাসিত প্রতিষ্ঠান কর্তৃক বিদেশের সাথে যোগাযোগ ব্যতীত অন্যান্য সকল ক্ষেত্রে নথি ও চিঠিপত্র, আইন আদালতের সওয়াল জবাব এবং অন্যান্য আইনানুগত কার্যাবলী অবশ্যই বাংলায় লিখিত হইবে।" Applications in another language "বেআইনী ও অকার্যকর বলিয়া গণ্য হইবে". An officer who breaches the Act "সরকারী কর্মচারী শৃংখলা ও আপীল বিধির অধীনে অসদাচরণ করিয়াছেন বলিয়া গণ্য হইবে" ([bdservicerules.info][bdsr-lang]; [CEFAN/Laval][cefan]). The **প্রশাসনিক পরিভাষা ২০১৫** glossary is the reference for administrative terms ([bdservicerules.info][bdsr-lang]). An agent drafting with AI should know that the Cabinet Division (ই-গভর্নেন্স-২ শাখা, 28 Jul 2026) ordered "সর্বোচ্চ সতর্কতা ও দায়িত্বশীলতা" with AI tools, warning against "সরকারি সংবেদনশীল ও গোপনীয় তথ্য অননুমোদিতভাবে প্রকাশ" ([ঢাকা টাইমস][dt-ai]). The skill should therefore remind users not to paste classified content and should present output as a draft for the signing officer.

Register is the subtle point. The SI-2024 format appendices use সাধু verbs (করা হইল, জানাইতেছি), while its filled samples from 2016–2023 use চলিত (করা হলো, জানানো যাচ্ছে, করছি). **[inferred]** Either is accepted, so default to চলিত and never mix the two in one document. Legal quotations keep their original সাধু spellings (সরকারী, আপীল, শৃংখলা), and these should not be used as models. **[convention]** The Bangla Academy প্রমিত rule: non-তৎসম words take ি, not ী (সরকারি, আধা-সরকারি, বিদেশি, শ্রেণি, জানুয়ারি), while তৎসম words keep ী where grammar requires it (মন্ত্রী, কর্মচারী). Preferred forms: উপর্যুক্ত (not উপরোক্ত), পরিপ্রেক্ষিতে, দাপ্তরিক, কার্যার্থে, জ্ঞাতার্থে, অবগতি, অনুলিপি, সংযুক্তি, খ্রিষ্টাব্দ, হলো (not হইল/হল in চলিত). "জনাব" precedes officers' names and is gender-neutral in current usage. "মহোদয়" is the salutation, and "মন্ত্রী মহোদয়"/"সচিব মহোদয়" appear in copy purposes. No official Bangla Academy rule text or চলিত mandate was retrieved, so these remain convention.

Bangla digits (০–৯, U+09E6–09EF) are used throughout: numbers, dates and amounts. **[convention]** No SI text mandating them was found, but every sample uses them. Keep Latin digits in English documents, URLs, emails, phone numbers in some templates (the SI sample's "E-mail: adminwelf@mopa.gov.bd" is Latin), and numeric spreadsheet cells, where substitution belongs only in the display layer. Python's `int('১২৩') == 123` works natively. Indian grouping (১২,৩৪,৫৬৭) is not supported by Python's format spec. The helper below was run and handles it. Amounts conventionally repeat in words, as in "মোট ১২,৫০০/- (কথায়: বারো হাজার পাঁচশত টাকা মাত্র)", using লক্ষ/শত/কোটি in formal text. Candidate libraries are `num2words(n, lang='bn')` ([PyPI][n2w]), `indic-num2words` ([PyPI][in2w]) and `bdtdecimaltowordsconverter` for taka/poisha ([PyPI][bdt]). None was quality-tested, and Bangla 1–99 are irregular words, so check their output against a 100-entry table.

```python
# [VERIFIED] 1234567 -> ১২,৩৪,৫৬৭ ; 123456789 -> ১২,৩৪,৫৬,৭৮৯
def lakh_group(n: int) -> str:
    s = str(abs(n))
    head, tail = s[:-3], s[-3:]
    parts = []
    while len(head) > 2:
        parts.insert(0, head[-2:])
        head = head[:-2]
    if head:
        parts.insert(0, head)
    out = ",".join(parts + [tail]) if parts else tail
    return ("-" if n < 0 else "") + to_bn_digits(out)
```

## Unicode Nikosh is mandated, but its license complicates bundling

A gazette (number, date and issuer not retrieved) directed all ministries, divisions and subordinate offices to adopt Bangla Unicode "without delay". The same secondary source says "সরকারি অফিসে নিকষ ব্যবহার করতে বলা হয়েছে" ([bdservicerules.info][bdsr-nikosh]). Nikosh was made by the **Bangladesh Election Commission** (designers Jowad Kazi, Omi Azad, Mozammel Sarker). It has a Regular weight only and Latin glyphs from modified DejaVu Serif, and its reported license is **CC BY-NC-ND 3.0** ([fonts.maateen.me/nikosh][nikosh]). OmicronLab distributes five variants, Nikosh, NikoshBAN, NikoshGrameen, NikoshLight and NikoshLightBan, without saying how they differ ([OmicronLab][omicron]). Open alternatives: Noto Sans/Serif Bengali (OFL 1.1, Debian `fonts-noto-core`) ([fontsource][noto]); Hind Siliguri (OFL, five weights) ([Adobe Fonts][hind]); and Tiro Bangla (OFL) ([maateen][tiro]). SolaimanLipi's license is reported both as GPLv2 with a font exception ([online-fonts][solaiman-gpl]) and as OFL ([maateen][solaiman-ofl]). BCC Purno is a separate BCC font ([cufonfonts][purno]). Debian `fonts-beng` pulls in Lohit Bengali and fonts-beng-extra (Mukti, Likhan, Akaash and others) ([Debian][fonts-beng]). **[inferred]** **Name "Nikosh" in documents, because recipients have it installed, but render with an installed open font in the sandbox.** Install Nikosh only when the operator supplies it and accepts the license (a non-commercial government or education deployment such as BdREN is the plausible case). Pin substitution with fontconfig so headless LibreOffice does not pick a random fallback:

```xml
<!-- /etc/fonts/local.conf or ~/.config/fontconfig/fonts.conf, then fc-cache -f -->
<fontconfig>
  <alias><family>Nikosh</family><prefer><family>Noto Serif Bengali</family></prefer></alias>
  <alias><family>SolaimanLipi</family><prefer><family>Noto Sans Bengali</family></prefer></alias>
  <alias><family>SutonnyMJ</family><prefer><family>Noto Serif Bengali</family></prefer></alias>
</fontconfig>
```

Page setup has almost no primary source. The one exception is the note sheet: A4 with a one-fifth margin (১১৫(১)). Drafts are double-spaced (১৩৫(১)) and footers carry the file name and path (৬২(৯)) ([SI-2024][si]). **[convention]** Adjustable defaults: A4; Nikosh; body 13–14 pt (e-Nothi output is commonly Nikosh around 13 pt); header lines 14–16 pt with the first line bold; about 1-inch margins; line spacing 1.15 or more, never exact; justified body (`both`, not `distribute`); right-aligned signature block; Bangla numerals everywhere.

**Legacy Bijoy text** (SutonnyMJ and other "MJ" or "ANSI" fonts) puts Bangla glyph shapes on ASCII and Latin-1 code points. On disk "বাংলাদেশ" becomes `evsjv‡`k` and "গণপ্রজাতন্ত্রী" becomes `MYcÖRvZš¿x`. Pre-base vowels and reph are also stored in visual order ([bangladatetoday guide][bijoy]). Many offices still type in Bijoy despite the directive ([bdservicerules.info][bdsr-nikosh]). Converters: `pip install bijoy2unicode` (MPL-2.0, both directions: `from bijoy2unicode import converter; c = converter.Unicode(); c.convertBijoyToUnicode(s)` / `c.convertUnicodeToBijoy(s)`) ([GitHub][b2u]); `bijoytounicode` ([PyPI][b2u2]); `unicodeconverter` ([GitHub][ucconv]); and LegacyLipi for PDFs, which detects legacy encodings and can OCR ([PyPI][legacylipi]). **[inferred]** Detect Bijoy per run. Flag runs whose `w:rFonts` name matches `/MJ$|MJ\b|Sutonny|Bijoy|ANSI/i` and whose text is mostly `[\x20-\xFF]` with no U+0980–09FF characters, or, when no font name is available, runs dense in characters like `‡ † ‰ ¨ Ö ÿ ©` and backtick. Convert only flagged runs and leave real English runs (Times New Roman, Arial) alone. Then set the run font to a Unicode Bangla font with `w:cs` and `bn-BD`, and NFC-normalise. Test fixtures should cover cluster-wide pre-base reordering (wK¬ → ক্লি), two-part vowels ো/ৌ, reph, ya-phala and ra-phala, precomposed conjuncts and digits. Converter quality varies, so round-trip known strings (বাংলাদেশ, গণপ্রজাতন্ত্রী বাংলাদেশ সরকার, মন্ত্রণালয়, কর্মকর্তা, স্মারক) and pin the version. Output Unicode unless the user explicitly asks for SutonnyMJ.

**Unicode hygiene.** NFC-normalise before comparing or searching. NFC **decomposes** য় ড় ঢ় into base + nukta, because U+09DF, 09DC and 09DD are composition exclusions ([Unicode CompositionExclusions][ce]). It composes ক+ে+া into কো, and NFD splits ৌ into U+09C7 U+09D7. Khanda ta U+09CE is unchanged ([VERIFIED] with CPython). ZWJ after the hasant requests a joined form, and ZWNJ forces a visible hasant ([Unicode Indic FAQ][indicfaq]). **[inferred]** Convert legacy ত+্+ZWJ to ৎ (U+09CE). Write র‍্য (as in র‍্যাব) as র + ZWJ + ্ + য so it does not render as reph. Write অ্যা as অ+্+য+া. Never strip ZWJ/ZWNJ or a word-final hasant in sanitisers. ৳ is U+09F3. For offline proofing, `apt install hunspell hunspell-bn` provides `/usr/share/hunspell/bn_BD.{aff,dic}` ([Debian filelist][hunspell]); usage is `hunspell -d bn_BD -l file.txt` or `spylls`. Add ministry names and designations (উপসচিব, সিনিয়র সহকারী সচিব) to a custom word list, and treat its output as advisory.

## Bangla breaks silently unless every engine shapes it

Correct Bangla needs three things in every pipeline: a font slot that routes U+0980–09FF to a Bangla font, a HarfBuzz-class shaper that reorders pre-base vowels and forms conjuncts, and a Latin fallback. The third matters because **Noto Sans Bengali lacks ASCII punctuation, Latin letters and Latin digits** (`, . — - ( ) : ; / A a 0` are absent from its cmap, while `। ৳ ZWNJ ZWJ` are present) [VERIFIED]. Each failure is silent. The text comes out in the wrong font, at the wrong size, unbolded, with ি after the consonant, with a visible hasant instead of a conjunct, or with dropped punctuation. The recipes below were run with python-docx 1.2.0, `docx` npm 9.13.0, reportlab 5.0.1 with uharfbuzz 0.51.7, fpdf2 2.8.4, python-pptx 1.0.2, openpyxl 3.1.5, matplotlib 3.9.4/3.11.2, Pillow 11.3/13.0 and PyMuPDF 1.26.5, on macOS rather than Linux. LibreOffice, poppler, WeasyPrint and tesseract were not run.

### DOCX: write the complex-script slots yourself

Word picks a font slot per character. Bangla uses `w:rFonts/@w:cs`, `w:szCs`, `w:bCs` and `w:iCs` ([python-docx font analysis][pdx-font]; [ECMA-376 rFonts][rfonts]). python-docx's `font.name` writes only `w:ascii`/`w:hAnsi` [VERIFIED in source], and `font.size`/`bold` write only `w:sz`/`w:b`. Without explicit CS properties, Bangla falls back through the theme. The OOXML theme example maps `Beng` to **Vrinda** ([MS OOXML theme][theme]). The result is the wrong font, and **[inferred]** a "14 pt bold" heading that renders at 11 pt regular. python-docx exposes `font.cs_bold`, `font.cs_italic` and `font.complex_script` ([python-docx Font][pdx-src]). Child order in `w:rPr` matters, so insert with `insert_element_before` rather than `append`:

```python
# [VERIFIED] python-docx 1.2.0 — correct rPr order even with pre-existing w:b / w:lang
from docx import Document
from docx.shared import Pt
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

BN_FONT = "Noto Sans Bengali"     # or Nikosh / Kalpurush / SolaimanLipi if installed
SEQ = ("w:rStyle","w:rFonts","w:b","w:bCs","w:i","w:iCs","w:caps","w:smallCaps","w:strike",
       "w:dstrike","w:outline","w:shadow","w:emboss","w:imprint","w:noProof","w:snapToGrid",
       "w:vanish","w:webHidden","w:color","w:spacing","w:w","w:kern","w:position","w:sz",
       "w:szCs","w:highlight","w:u","w:effect","w:bdr","w:shd","w:fitText","w:vertAlign",
       "w:rtl","w:cs","w:em","w:lang","w:eastAsianLayout","w:specVanish","w:oMath")

def _child(rPr, tag):
    el = rPr.find(qn(tag))
    if el is None:
        el = OxmlElement(tag)
        rPr.insert_element_before(el, *SEQ[SEQ.index(tag) + 1:])
    return el

def set_bn_rpr(rPr, font=BN_FONT, size_pt=None, latin_font=None, lang_val="bn-BD"):
    rFonts = _child(rPr, "w:rFonts")
    for theme in ("w:asciiTheme", "w:hAnsiTheme", "w:eastAsiaTheme", "w:cstheme"):
        rFonts.attrib.pop(qn(theme), None)          # theme attrs override explicit names
    for slot in ("w:ascii", "w:hAnsi", "w:eastAsia"):
        rFonts.set(qn(slot), latin_font or font)
    rFonts.set(qn("w:cs"), font)
    if size_pt:
        for tag in ("w:sz", "w:szCs"):
            _child(rPr, tag).set(qn("w:val"), str(round(size_pt * 2)))   # half-points
    lang = _child(rPr, "w:lang")
    lang.set(qn("w:val"), lang_val)
    lang.set(qn("w:bidi"), "bn-BD")     # w:bidi = language of complex-script text
    return rPr

doc = Document()
# docDefaults
rPrDefault = doc.styles.element.find(qn("w:docDefaults")).find(qn("w:rPrDefault"))
set_bn_rpr(rPrDefault.find(qn("w:rPr")), size_pt=12)
# Normal style
set_bn_rpr(doc.styles["Normal"].element.get_or_add_rPr(), size_pt=12)
# a run (bold must also set cs_bold for Bangla)
r = doc.add_paragraph().add_run("গণপ্রজাতন্ত্রী বাংলাদেশ সরকার")
r.bold = True; r.font.cs_bold = True
set_bn_rpr(r._element.get_or_add_rPr(), size_pt=14)
doc.save("out.docx")
```

The verified output is `<w:rPr><w:rFonts w:ascii=".." w:hAnsi=".." w:eastAsia=".." w:cs="Noto Sans Bengali"/><w:b/>…<w:sz w:val="28"/><w:szCs w:val="28"/><w:lang w:val="bn-BD" w:bidi="bn-BD"/></w:rPr>`. If the Bangla font lacks Latin (Noto does), pass `latin_font="Liberation Serif"` or "Times New Roman" so ascii and hAnsi get a Latin face. Nikosh includes Latin and can fill all four slots. Remember `r.font.cs_bold = True` (and `cs_italic`) whenever you set bold or italic. With `docx` npm 9.13.0, `size` is copied into `szCs` automatically, but `complexScript: true` on a TextRun emitted no `<w:cs/>` [VERIFIED]:

```js
// [VERIFIED] docx npm 9.13.0
const BN = "Noto Sans Bengali";
new Document({
  styles: { default: { document: { run: {
    font: { ascii: BN, hAnsi: BN, eastAsia: BN, cs: BN, hint: "cs" },
    size: 24, sizeComplexScript: 24,
    language: { value: "en-US", bidirectional: "bn-BD" } } } } },
  sections: [{ children: [new Paragraph({ children: [new TextRun({
    text: "গণপ্রজাতন্ত্রী বাংলাদেশ সরকার",
    font: { ascii: BN, hAnsi: BN, eastAsia: BN, cs: BN }, size: 28, sizeComplexScript: 28,
    language: { value: "bn-BD", bidirectional: "bn-BD" } })] })] }] });
```

When editing an existing .docx, Word splits words across many runs. Replace a paragraph's text in `runs[0]`, delete the other runs and re-apply the CS properties, which keeps the first run's formatting [VERIFIED]. **[inferred]** Never split a grapheme cluster (consonant + hasant + consonant, or consonant + vowel sign) across runs with different fonts, because shaping happens per run.

```python
def replace_paragraph_text(p, new_text):
    runs = p.runs
    if not runs:
        return set_bn_rpr(p.add_run(new_text)._element.get_or_add_rPr())
    runs[0].text = new_text
    for r in runs[1:]:
        r._element.getparent().remove(r._element)
    set_bn_rpr(runs[0]._element.get_or_add_rPr())
```

**[inferred] layout guidance.** Justify with `WD_ALIGN_PARAGRAPH.JUSTIFY` (`w:jc="both"`). `DISTRIBUTE` adds inter-character spacing that visually detaches vowel signs. Use multiple or at-least line spacing (≥1.15), never `EXACTLY`, because reph and ঈ/ঊ marks rise high, ু ূ ৃ and ra-phala hang low, and SolaimanLipi and Kalpurush have especially tall metrics. Build the stacked date and the left-number/right-date line as a borderless two-column table or with a right tab stop, so the two lines of the date stay aligned.

### PDF: shape with HarfBuzz or don't ship

ReportLab gained "Experimental support for character shaping using Harfbuzz, used for many south asian languages" in 4.4 (April 2025) ([ReportLab 4.4 notes][rl44]). With reportlab 5.0.1 and uharfbuzz, `shaping=0` produced broken output, rendering দেশ as দশে and showing ক্ষ with a visible hasant, while `shaping=1` was correct [VERIFIED]. fpdf2 shapes once `set_text_shaping` is on ([fpdf2 docs][fpdf2]). It **silently drops** glyphs missing from the font and only issues a `UserWarning`, so add fallback fonts and turn warnings into errors. ReportLab draws tofu boxes instead [VERIFIED].

```python
# [VERIFIED] pip install reportlab uharfbuzz
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import SimpleDocTemplate, Paragraph
pdfmetrics.registerFont(TTFont("NotoBn", "NotoSansBengali-Regular.ttf"))
st = ParagraphStyle("bn", fontName="NotoBn", fontSize=16, leading=26, shaping=1)
SimpleDocTemplate("out.pdf").build([Paragraph("গণপ্রজাতন্ত্রী বাংলাদেশ সরকার", st)])
```

```python
# [VERIFIED] pip install fpdf2 uharfbuzz
import warnings; warnings.simplefilter("error")      # make "missing glyphs" fatal
from fpdf import FPDF
pdf = FPDF(); pdf.add_page()
pdf.add_font("NotoBn", "", "NotoSansBengali-Regular.ttf")
pdf.add_font("Latin", "", "LiberationSerif-Regular.ttf")   # any Latin TTF
pdf.set_font("NotoBn", size=14)
pdf.set_fallback_fonts(["Latin"])
pdf.set_text_shaping(use_shaping_engine=True, script="beng", language="ben")
pdf.multi_cell(0, 10, "স্মারক নং: ০৫.৪৩, তারিখ — (Memo No.)")
pdf.output("out.pdf")
```

**[inferred]** The reliability ranking for a Python + Node + LibreOffice sandbox is: (1) build the DOCX, then `soffice --headless --convert-to pdf` (HarfBuzz inside, one source of truth); (2) HTML → WeasyPrint, which uses Pango and HarfBuzz ([WeasyPrint summary][weasy]), with `<html lang="bn">` and `@font-face{font-family:Bn;src:url(NotoSansBengali-Regular.ttf)} body{font-family:Bn, "Noto Serif", serif}`; (3) ReportLab ≥4.4 or fpdf2 with uharfbuzz. **Never use ReportLab or fpdf2 without uharfbuzz for Bangla.** Shaping quality also depends on the HarfBuzz and font versions: an old Fedora bug shows conjunct failures with HarfBuzz 0.9.5 ([Red Hat 872836][rh]).

### PPTX, XLSX, charts and images

**PPTX.** python-pptx `run.font.name` writes only `<a:latin>`. Add `<a:cs>` (and `<a:ea>`) with `lang="bn-BD"` on each run [VERIFIED], or set the theme's `<a:minorFont><a:cs>` and `<a:font script="Beng">` for the whole deck ([MS OOXML theme][theme]). If a run already has `a:hlinkClick`, `sym`, `rtl` or `extLst` children, insert before them rather than appending.

```python
# [VERIFIED] python-pptx 1.0.2 -> <a:rPr sz="3200" lang="bn-BD"><a:latin …/><a:ea …/><a:cs …/></a:rPr>
from pptx import Presentation
from pptx.util import Pt
from pptx.oxml.ns import qn
from pptx.oxml.xmlchemy import OxmlElement
BN = "Noto Sans Bengali"
def bn_run(run, size=None):
    if size: run.font.size = Pt(size)
    run.font.name = BN                       # -> <a:latin>
    rPr = run._r.get_or_add_rPr()
    rPr.set("lang", "bn-BD")
    for tag in ("a:ea", "a:cs"):             # schema order: latin, ea, cs, sym, hlinkClick...
        el = rPr.find(qn(tag))
        if el is None:
            el = OxmlElement(tag); rPr.append(el)   # append is safe only if no sym/hlink*/rtl/extLst children
        el.set("typeface", BN)
```

**XLSX.** SpreadsheetML has one font name per style, with no CS slot. `ws["A1"].font = Font(name="Noto Sans Bengali", size=12)` round-trips the string exactly [VERIFIED], and shaping happens in the viewer. LibreOffice's built-in `bn` CTL fallback list is "Mukti Narrow;Lohit Bengali;Vrinda;Tahoma;Lucidasans;Lucida Sans;Arial Unicode MS", with no Noto or Nikosh ([LibreOffice VCL.xcu][vcl]). **[inferred]** Pick a Bangla font that also covers Latin for mixed cells. Widen columns and set `wrap_text=True` and an explicit `row_dimensions[i].height` for matras. Keep numeric cells numeric, and render with `soffice --headless --convert-to pdf book.xlsx` to check.

**Charts.** matplotlib 3.11 (June 2026) bundles libraqm, HarfBuzz and SheenBidi, so "all text should now support modern font features" ([Matplotlib 3.11 announcement][mpl311]). 3.11.2 shaped Bangla correctly in Agg and PDF, while 3.9.4 was broken [VERIFIED]. On matplotlib ≤3.10, use mplcairo with raqm ([Matplotlib discourse][mpltamil]). **Pillow** wheels ship a libraqm that loads FriBiDi at runtime ([Pillow docs][pillow]). Without it, `Layout.RAQM` warns "Raqm layout was requested, but Raqm is not available. Falling back to basic layout." and produces byte-identical broken output [VERIFIED]. **[inferred]** Run `apt install libfribidi0 libraqm0` and assert `PIL.features.check("raqm")` before drawing Bangla.

```python
# [VERIFIED] matplotlib 3.11.2
import matplotlib; matplotlib.use("Agg")
from matplotlib import font_manager, pyplot as plt
font_manager.fontManager.addfont("/path/NotoSansBengali-Regular.ttf")
plt.rcParams["font.family"] = ["Noto Sans Bengali", "DejaVu Sans"]  # Latin fallback list
```

### LibreOffice sandbox checklist and verification

LibreOffice rewrites `registrymodifications.xcu` on every run and does not support hand edits ([LO dev list][lo-dev]). Headless conversion has historically produced tofu where the GUI substituted ([freedesktop 38311][fdo]). The usual fix is to install a covering font and check with `fc-match -v` ([ask.libreoffice][asklo]). **[inferred]** The sandbox setup:

```bash
apt-get install -y fonts-noto-core fonts-beng hunspell hunspell-bn libraqm0 libfribidi0 \
                   poppler-utils tesseract-ocr-ben libreoffice-writer libreoffice-impress libreoffice-calc
# optional, operator-supplied: cp Nikosh*.ttf /usr/local/share/fonts/ ; then:
fc-cache -f
fc-list :lang=bn family                 # must list Noto Sans/Serif Bengali (and Nikosh if supplied)
fc-match "Nikosh:lang=bn"               # must NOT return DejaVu
soffice -env:UserInstallation=file:///tmp/lo_profile --headless --norestore \
        --convert-to pdf --outdir out in.docx
```

Verify by **rendering and looking**, not by extracting text. Correctly shaped Bangla PDFs extract worse than broken ones [VERIFIED]: ReportLab output gave PUA characters with ে/ি in visual order, fpdf2 gave `\x0f` and `(cid:15)`, and matplotlib PDFs duplicated clusters ([Unicode list][ucml]; [Adobe community][adobe]). **[inferred]** The automated check runs in five steps. (1) Before rendering, confirm with fontTools `TTFont(path).getBestCmap()` that the chosen fonts cover every character, including `।`, `৳` and ASCII punctuation. (2) After rendering, run `pdffonts out.pdf` or PyMuPDF `page.get_fonts()`: the Bangla font must appear embedded as a subset (`AAAAAA+NotoSansBengali-Regular` [VERIFIED]), and no unexpected DejaVu or Liberation font may cover Bangla. (3) Rasterize with `pdftoppm -r 120 -png -f 1 -l 2 out.pdf pg` or `page.get_pixmap(dpi=110).save("p.png")` [VERIFIED]. (4) Inspect the canary words কি, দেশ, ক্ষ, ন্ত্র, কৌ, প্র, র্ক in the canary sentence "গণপ্রজাতন্ত্রী বাংলাদেশ সরকার, কৌশল ক্ষেত্রে". The failure signatures are ি/ে drawn after the consonant, a visible ্ where a conjunct belongs, tofu, and missing punctuation. (5) Turn fpdf2 "missing the following glyphs" warnings into errors. No tool detects mis-shaping automatically, so vision inspection of the PNGs is the practical check. To **read** incoming PDFs, try PyMuPDF or `pdftotext -layout`. If the output contains U+E000–F8FF, `(cid:` or control characters, OCR with `pdftoppm -r 300` and `tesseract … -l ben+eng --oem 1 --psm 6`; the LSTM models reach about 95% word accuracy on clean pages ([BRAC thesis][brac]). If the output is mostly ASCII gibberish like `MYcÖRvZš¿x evsjv‡`, it is Bijoy text, which needs conversion rather than OCR. Prefer extracting from the source DOCX whenever one exists.

### What remains unverified

These items are open and a SKILL should flag them. The D-Nothi template field list (manuals not retrieved). Ministry and branch code tables for the 22-digit number. The Nikosh gazette's number and date and whether it names Nikosh, and an authoritative Nikosh license file. Official paper size, margins and font size for letters, as opposed to note sheets. Any চলিত-over-সাধু mandate. Placement of the নজরুল বর্ষ logo. Contents of ক্রোড়পত্র-৬(ক) and ৯. BDREN's own letterhead and numbering. Accuracy of the `bn` number-to-words libraries and of the Bijoy converters. All LibreOffice, WeasyPrint, poppler and tesseract behaviour in an actual Linux sandbox.

## Conclusion

The biggest correction for anyone working from older material is that **SI-2024, not the 2014 manual, is now the citable authority, and it ships official ফরম্যাট/নমুনা pairs**. The agent can therefore generate documents from transcribed templates instead of folk conventions. That said, its own samples still carry pre-2024 18-digit numbers, mix সাধু formats with চলিত fills, and in one case date a meeting before its notice, so a generator should follow the rules and validate its output rather than copy the samples. The dual date is not a lookup problem: since 2019 the Bangla month starts are fixed Gregorian dates, so a ten-line function reproduces every real date checked. The 22-digit number is equally mechanical, apart from codes that should never be invented.

On the engineering side, every Bangla failure mode is silent: the wrong CS slot, an unshaped PDF, dropped glyphs, or Pillow quietly losing Raqm. A Bangla document skill therefore needs a mandatory render-and-inspect gate more than it needs more templates. The licensing split adds a design choice: specify Nikosh in the document for the recipient, render with Noto in the sandbox, and pin the substitution with fontconfig. That keeps output faithful on government desktops without redistributing a font whose reported license forbids commercial bundling.

[si]: https://objectstorage.ap-dcc-gazipur-1.oraclecloud15.com/n/axvjbnqprylg/b/V2Ministry/o/office-moca/2024/12/39f8ba965fd545149fefd1b458063bb1.pdf
[dr]: https://www.deshrupantor.com/517276/
[bdsr-memo]: https://bdservicerules.info/%e0%a6%85%e0%a6%ab%e0%a6%bf%e0%a6%b8-%e0%a6%b8%e0%a7%8d%e0%a6%ae%e0%a6%be%e0%a6%b0%e0%a6%95-%e0%a6%b8%e0%a6%b0%e0%a6%95%e0%a6%be%e0%a6%b0%e0%a6%bf-%e0%a6%aa%e0%a6%a4%e0%a7%8d%e0%a6%b0/
[bdsr-22]: https://bdservicerules.info/govt-nothi-22-digit-now-bd/
[bdsr-nazrul]: https://bdservicerules.info/?p=47970
[dr-nazrul]: https://www.deshrupantor.com/707488/
[dt-referendum]: https://www.dhakatimes24.com/2026/01/10/399829
[gazette]: https://www.dpp.gov.bd/bgpress/bangla/index.php/home/download_file/gazettes/55706_76279.pdf
[dpp]: https://www.dpp.gov.bd/bgpress/bangla/index.php/document/extraordinary_gazettes_monthly/2024-08-16
[srolist]: https://legislativediv.gov.bd/pages/static-pages/6940329a35ce18e1c055f2e9
[cal]: https://www.teachers.gov.bd/content/details/493103
[oldcal]: https://ary.wordpress.org/plugins/bangla-date-display/
[ctg1]: https://file-chittagong.portal.gov.bd/uploads/c4d96487-3091-433e-99da-1beb956cab46//65c/71a/360/65c71a3609458542255968.pdf
[ctg2]: https://file-chittagong.portal.gov.bd/uploads/c4d96487-3091-433e-99da-1beb956cab46//659/57f/0a1/65957f0a11597264196562.pdf
[rbd]: https://www.risingbd.com/national/news/662336
[inq]: https://dailyinqilab.com/national/news/923874
[chaud]: https://chauddagram.comilla.gov.bd/en/site/page/IkUy-%E0%A6%95%E0%A6%BE%E0%A6%B0%E0%A7%8D%E0%A6%AF%E0%A6%AC%E0%A6%BF%E0%A6%AC%E0%A6%B0%E0%A6%A3%E0%A7%80-%E0%A6%93-%E0%A6%97%E0%A7%81%E0%A6%B0%E0%A7%81%E0%A6%A4%E0%A7%8D%E0%A6%AC%E0%A6%AA%E0%A7%81%E0%A6%B0%E0%A7%8D%E0%A6%A8-%E0%A6%B8%E0%A6%BF%E0%A6%A6%E0%A7%8D%E0%A6%A7%E0%A6%BE%E0%A6%A8%E0%A7%8D%E0%A6%A4
[matu]: https://matubhuiyanup.feni.gov.bd/pages/static-pages/6990d20935ce18e1c071d325
[dhaka]: https://file-dhaka.portal.gov.bd/files/www.dhaka.gov.bd/notices/c054ef41_7014_4609_a41d_b1e9627e79cc/9e0a077fdc89f6fd1743c70bf4cb4747.pdf
[basail]: https://basail.tangail.gov.bd/pages/static-pages/6995aa6f35ce18e1c07925a3
[dnothi]: https://mof.gov.bd/site/notices/a2056a2a-9ae6-4865-877c-50626b7b0919/D-Nothi-User-Manual
[brur]: https://lalmonibarta.com/14/60/
[pstu]: https://www.deshrupantor.com/709556/
[jnu]: https://www.jugantor.com/campus/1007603
[lstu]: http://bdlaws.minlaw.gov.bd/act-print-1480/section-print-53824.html
[ugc]: https://ugc.gov.bd/pages/static-pages/6922dcbd933eb65569e11c02
[du]: https://www.du.ac.bd/du_post_details/16699
[dip]: https://dip.gov.bd/pages/forms/6922d9e0933eb65569e00be9
[nsda]: https://nsda.gov.bd/pages/go-ultimates/
[bdsr-lang]: https://bdservicerules.info/no-foreign-language-in-govt-office/
[cefan]: https://axl.cefan.ulaval.ca/asie/Bangladesh-loi-1987.htm
[dt-ai]: https://www.dhakatimes24.com/national/409829/
[n2w]: https://pypi.python.org/pypi/num2words
[in2w]: https://pypi.org/project/indic-num2words
[bdt]: https://pypi.org/project/bdtdecimaltowordsconverter/
[bdsr-nikosh]: https://bdservicerules.info/?p=2462
[nikosh]: https://fonts.maateen.me/nikosh/
[omicron]: https://omicronlab.com/bangla-fonts.html
[noto]: https://fontsource.org/fonts/noto-sans-bengali/about
[hind]: https://fonts.adobe.com/fonts/hind-siliguri
[tiro]: https://fonts.maateen.me/tiro-bangla/
[solaiman-gpl]: https://online-fonts.com/fonts/solaimanlipi
[solaiman-ofl]: https://fonts.maateen.me/solaiman-lipi
[purno]: https://www.cufonfonts.com/font/bcc-purno
[fonts-beng]: https://tracker.debian.org/pkg/fonts-beng
[bijoy]: https://bangladatetoday.com/blog/bijoy-to-unicode-avro-guide
[b2u]: https://github.com/Mad-FOX/bijoy2unicode
[b2u2]: https://pypi.org/project/bijoytounicode/1.1.0/
[ucconv]: https://github.com/shahad-mahmud/unicode_converter
[legacylipi]: https://pypi.org/project/legacylipi/0.6.0/
[ce]: https://www.unicode.org/Public/UCD/latest/ucd/CompositionExclusions.txt
[indicfaq]: https://www.unicode.org/faq/indic.html
[hunspell]: https://packages.debian.org/sid/all/hunspell-bn/filelist
[pdx-font]: https://python-docx-oss.readthedocs.io/en/latest/_sources/dev/analysis/features/text/font.rst
[rfonts]: https://webapp.docx4java.org/OnlineDemo/ecma376/WordML/rFonts.html
[theme]: https://learn.microsoft.com/en-us/previous-versions/office/developer/office-2010/cc846608(v=office.14)
[pdx-src]: https://python-docx.readthedocs.io/en/stable/_modules/docx/text/font.html
[rl44]: https://docs.reportlab.com/releases/notes/whats-new-44/
[fpdf2]: https://py-pdf.github.io/fpdf2/TextShaping.html
[weasy]: https://openapps.pro/packages/weasyprint
[rh]: https://bugzilla.redhat.com/show_bug.cgi?id=872836
[vcl]: https://raw.githubusercontent.com/LibreOffice/core/master/officecfg/registry/data/org/openoffice/VCL.xcu
[mpl311]: https://discourse.matplotlib.org/t/matplotlib-announce-ann-matplotlib-3-11-0/
[mpltamil]: https://discourse.matplotlib.org/t/tamil-letters-not-properly-printed-in-x-axis/23123
[pillow]: https://pillow.readthedocs.io/en/stable/installation/building-from-source.html
[lo-dev]: https://listarchives.libreoffice.org/global/dev/2012/msg05935.html
[fdo]: https://bugs.freedesktop.org/show_bug.cgi?id=38311
[asklo]: https://ask.libreoffice.org/t/command-line-docx-to-pdf-characters-just-blank-squares/4254
[ucml]: https://www.unicode.org/mail-arch/unicode-ml/y2017-m02/0014.html
[adobe]: https://community.adobe.com/t5/acrobat-discussions/if-i-try-to-copy-unicode-bengali-text-from-pdf-it-always-broken/m-p/13973286
[brac]: https://dspace.bracu.ac.bd/items/68f560de-6e25-4cc7-9a2f-8f913b6f9273
