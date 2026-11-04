---
name: official-correspondence
description: Use for official letters, memos, notices, circulars, reminders, leave or duty requests and formal emails for a university, UGC, ministry or public body, and for editing or replying to them. Not for personal or creative writing.
user-invocable: false
license: Proprietary. LICENSE.txt has complete terms
---

# Official correspondence

The layouts here were read from documents these bodies publish. `references/formats.md` shows each
one and its source. One call builds the Word file and checks it.

> Script paths below are relative to this skill's directory.

## Which route

| The user wants | Do |
|---|---|
| A formal email | Write it in the reply. No file unless asked. See [Email](#email) |
| A letter, circular, notice, memo, meeting notice, office order or leave request | Fill a spec and run `scripts/build.py` |
| A small change to something built in this chat ("add the venue", "change the subject") | Change that part of `qa/letter.json`, rebuild, reply in one line |
| Their own letterhead file used, or their own .docx edited | the `docx` skill; apply the wording rules below |
| A prescribed form filled in, such as an overseas leave form | the `form-filling` skill |
| A Bangla government document (নথি, পরিপত্র, অফিস আদেশ) | the `govdoc` skill if it is available. Otherwise build here and say the layout is not the Secretariat Instructions one |

## Ask once, or go ahead

If the issuing office, the signer, the recipients or the reference number are missing and you
cannot tell them from the chat or an uploaded letter, ask once, at most three questions together.
If they skip or say "you decide", build with visible placeholders. Never ask twice.

**Never invent** a name, reference or circular number, meeting number, date of an earlier letter,
amount, deadline, phone number or email address. A missing one is a placeholder such as `[My No.]`
in the file, and the reply lists every placeholder. No crest or logo unless the user supplied the
image.

## Pick the house and the kind

| The issuing office | `house` | What it sets |
|---|---|---|
| University Grants Commission, Sri Lanka | `ugc-lk` | Date `03rd October, 2023`; capital subject, left; paragraphs unnumbered; signature left |
| A Sri Lankan university or institute | `university-lk` (default) | Date `03.10.2023`; capital subject, left; unnumbered; signature left |
| Ministry of Public Administration circular | `pa-lk` | Date `03.10.2023`; centred subject, size 14; first paragraph unnumbered, then `02.` `03.`; signature right with telephone, fax and email |
| Another Sri Lankan ministry or department | `ministry-lk` | Date `2023.10.03`; `02.` `03.` numbering; signature left. Common practice, not read from a primary source |
| A Bangladeshi UGC, university or ministry, in English | `bd` | Government line and rule in the letterhead; `Ref. No.` left and `Date:` right; `Subject:` **before** `Dear Sir,`; bold `02.`; signature right |

If the user uploads a letter from their own office, its layout beats this table. Copy its order,
reference style and date style, using `date_style`, `numbered` and `signature` in the spec.

Kinds: `letter`, `circular` (to a list of posts, no salutation), `notice`, `memo`, `meeting`,
`order`, `leave`. For a reminder, a covering letter or a reply use `letter`. A reply also fills
`your_no` and opens by citing their letter and its date.

`references/spec.md` has every field.

## The one command

```bash
python3 /mnt/data/skills/official-correspondence/scripts/build.py /mnt/data/qa/letter.json /mnt/data/Reminder-to-Universities.docx
```

Write the spec to `/mnt/data/qa/letter.json` so later edits start from it. Exit 0: passed, though
warnings may be listed. Exit 2: read the defects, fix the spec and rebuild. Exit 1: bad spec or
arguments. A multi-page document gets `Page 1 of 2` footers by itself. Read the one page image the
report names, once, then reply.

Dates in the spec are `YYYY-MM-DD`; the house sets how they print. A missing date becomes today.

## Wording

Institutional voice, British spelling, no contractions, one matter per document. Write the purpose
in the first sentence and the action, with its date, in the last paragraph. Use these phrases; each
one comes from a published document:

| Purpose | Phrase | Seen in |
|---|---|---|
| Open a circular | "Your attention is hereby drawn to…" | Public Administration circular |
| Stress a rule | "it is hereby emphasized that…" | Public Administration circular |
| Report a decision | "The Commission at its [number] meeting held on [date] decided…" | UGC circular |
| Enclose | "I enclose…" / "…attached hereto" | University of Moratuwa; UGC |
| Ask | "I shall be grateful if you could kindly…" / "You are kindly requested to…" | Moratuwa; UGC Bangladesh |
| End a circular | "Please take action accordingly." | UGC |
| Require compliance | "All the Heads of Institutions should ensure the adherence to these provisions." | Public Administration circular |
| Inform the public | "The public is hereby informed that…" | UGC notice |
| Open a Bangladesh letter | "The undersigned is pleased to inform…" | UGC Bangladesh |
| Grant in an order | "This is to notify that the Vice-Chancellor… is pleased to give permission…" | Bangladesh Open University |
| Call for applications | "will entertain applications for the post of…"; "Incomplete applications will be rejected." | University of Colombo |

Do not use "I am directed to" unless the user's own letters do: no published letter we read has it.

**Salutation and close.** Published circulars and most covering letters have neither. An individual
letter takes "Dear Sir/Madam," with "Yours faithfully," or "Dear Professor Perera," with "Yours
sincerely,". This pairing is common practice, not taken from a published Sri Lankan letter.

**Reminders.** Pick the level from the user's words, and go one softer if they say "don't say it
directly" or "ask them to attend to it":

1. First: "May I remind you that… is due on [date]. I shall be grateful if you could kindly…"
2. Second: cites the earlier letter by its number and date, then "…has not yet been received. You are kindly requested to… on or before [date]."
3. Final: states what follows if the date passes, only if the user told you what follows.

**Language.** Answer in the language of the letter being replied to, or the one the user wrote in.
Bangla goes in the spec as it is and is set in Nikosh. Sinhala and Tamil are not supported yet: write
the document in English and say so.

**Translating or tidying** the user's draft keeps their facts and adds none.

## Leave and duty requests

Read `references/leave.md` first. If the user's institution has a prescribed form and they supplied
it, fill that with `form-filling`; the Establishments Code requires it. Otherwise use `kind: leave`.

## Email

Write it in the reply, ready to paste, with no heading of your own beyond these:

```
To: …
Cc: …
Subject: …

Dear Professor Perera,

…

Yours sincerely,
Name
Post, Office
official@address | website
```

Following the ICTA government email policy draft and university policies:

- Always a clear subject; open with the recipient's name or post, end with the sender's name and signature details.
- `To` for those who must act; `Cc` when the mail is mainly for one person; `Bcc` for people who do not know one another, as with a mail to all Vice-Chancellors from a list.
- It goes from the official or post account (registrar@…), not a personal one. Say so only if the user seems to be using a personal one.
- Shorter than the letter: purpose, action, date. Do not put circular numbering in it. No emoji.
- A "reply all" that declines or objects: suggest in one line replying to the sender alone.
- If they gave a link, read it first and take facts only from it.

## What the reply says

One or two lines plus the file name. Say which layout was followed, list every placeholder to fill,
and name any warning you chose to keep. Never show a `/mnt/data` path, the spec or the script. After
an edit, one line on what changed.

> Reminder ready: Reminder-to-Universities.docx, in the UGC circular layout. Fill in [My No.] and the signer's name.

## Gotchas

- Do not type `Subject:` into a `subject` value; the house adds the label when it uses one.
- Do not type `02.` into a paragraph; numbering comes from the house.
- Deliverables at the top of `/mnt/data`; working files in `/mnt/data/qa/`.
- Bare `soffice` hangs in the sandbox. The build uses `scripts/office/soffice.py`; do not convert by hand.
