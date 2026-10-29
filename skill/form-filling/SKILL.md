---
name: form-filling
description: "Fill in a form from the user's documents or messages: application, nomination or award (Ekushey Padak), funding or survey forms, as fillable or scanned PDF or Word. Not for making a new blank form (use docx or pdf)."
user-invocable: false
license: Proprietary. LICENSE.txt has complete terms
---

# Filling PDF and Word forms

The user gives a form (fillable PDF, flat or scanned PDF, or Word) and the material to fill it from:
attached CVs, certificates, letters, or what they wrote earlier in the conversation. You deliver the
same form with the blanks filled, in its own layout, and say exactly which fields you left blank and
why. Three scripts do the work: `fields.py` lists the blanks, `fill.py` writes the values, `check.py`
proves every value landed and nothing was invented or overflowed.

> Script paths below are relative to this skill's directory (in the sandbox:
> `/mnt/data/skills/form-filling/`). Put working files in `/mnt/data/qa/`; only the filled form goes
> at the top of `/mnt/data`.

For PDF work that is not filling a form (merge, split, extract, OCR, make a new PDF), use the `pdf`
skill. For making a new blank form, use `docx` or `pdf`.

## Which route

| The form is… | `fields.py` says | Route |
|---|---|---|
| Fillable PDF (has AcroForm fields) | `N fields (pdf_form)` | Map by field id; `fill.py` sets the fields |
| Flat PDF with a text layer | `no fillable fields: this is a flat PDF`, exit 2, candidate blanks with x/y | Overlay: mapping gives page, x, y, size per value |
| Scanned PDF, or a photo of a form | `… (scanned image, no text layer)` | Overlay in pixels: render the page, read positions off the image |
| Word `.docx` | `N fields (docx)` | Map by id: table cells, content controls, `____`/`……` blanks, ☐ boxes |
| Word `.doc` | — | Convert first: `python3 scripts/office/soffice.py --headless --convert-to docx --outdir /mnt/data/qa FILE.doc` |

A photo (`.jpg`, `.png`) of a form: save it as a one-page PDF at 100 dpi
(`Image.open(p).convert("RGB").save("/mnt/data/qa/form.pdf", resolution=100)`), then use the
scanned route with `"units": "px", "dpi": 100`; the pixel positions you read off the photo are then exact.

## Workflow

**1. List the fields.**

```bash
mkdir -p /mnt/data/qa && python3 scripts/fields.py /mnt/data/FORM.docx --out /mnt/data/qa/fields.json
```

It prints one line per field: `id [type] label = current value options=[…]`. Ids are stable for that
file: `t0.r2.c1` (table 0, row 2, cell 1), `p7.b0` (paragraph 7, first blank), `p9.x1` (second tick box),
`sdt3` (content control), or the PDF field name. Grid tables give labels such as `Degree (row 1)`.
If a Word form yields 0 fields (blanks made of plain spaces or tab leaders), fill it with the `docx`
skill's XML editing instead.

**2. Build the mapping** at `/mnt/data/qa/mapping.json`: one entry per field, with the value and the
**source** of the value (`"CV.pdf p2"`, `"NID card"`, `"user message"`). Full schema and examples:
`references/mapping.md`. Read every source document once before mapping (`pdftotext -layout`,
`pandoc -t plain`; for a scan, `tesseract IMG - -l ben+eng`). "Use the information I already gave"
means the earlier messages are the source; quote them as `"user message (earlier)"`.

- A value with no source stays `""`, gets `"required": true` if the form marks it required (`*`,
  "mandatory", the PDF's own flag), and gets a reason in `blank_reasons`.
- Long narrative fields (contribution, justification, summary) are written from the sources, in the
  form's language, sized to the box. Do not pad them with claims the documents do not make.
- Fill a checkbox or radio with `true`/`false` or the option text; a choice field with one of its
  listed options.

**3. Ask once, only for what matters.** If required fields have no source, ask in ONE
`ask_user_question` round, at most 3 questions (group related fields: "date of birth and NID number").
If the user skips or answers only part, fill what you have and leave the rest blank with the reason
"not provided". Never ask twice, and never ask about optional fields.

**4. Fill.**

```bash
python3 scripts/fill.py /mnt/data/FORM.docx /mnt/data/qa/mapping.json /mnt/data/FORM-filled.docx
```

The output keeps the form's type: a Word form comes back as Word, a PDF as PDF. Never overwrite the
user's original. The report lists filled, blank, unknown ids and problems; exit 2 means fix the
mapping (wrong id, an option that does not exist, text too long for its PDF box) and run it again.

**5. Gate and look once.**

```bash
python3 scripts/check.py /mnt/data/FORM.docx /mnt/data/FORM-filled.docx /mnt/data/qa/mapping.json --render /mnt/data/qa
```

`PASS` is required before delivery. Then read ONE rendered page image (the busiest page) to confirm
placement, in a call of its own. Overlay forms need this look most: if text sits on a label or off
its line, move x/y in the mapping and refill once. Keep it to one round, two at most. When the gate
fails, read the defect and check whether the mapping or the gate is wrong before changing the form.

## Never invent

These are filled only from a document or the user's own words, never guessed, inferred from other
data, or made plausible:

- dates of birth, ages, joining and award dates
- NID, passport, birth registration, TIN, BIN, registration, roll and employee numbers
- phone numbers, email addresses, postal addresses
- bank details, amounts, salaries, budgets, fees
- signatures, seals, initials (never draw or type a signature; leave the box empty)
- names of referees, nominators, guardians; anyone's designation you have not seen

Leave them blank, put them in `blank_reasons`, and list them in the reply. A CV that says "born 1958"
fills a year field, not a full date field.

## Language

- Fill in the form's language, field by field: a Bangla form gets Bangla values, an English form
  English, and a bilingual form follows each label. Names keep the spelling used in the sources;
  translate descriptions, not proper names.
- Bangla is written in Unicode Bangla (precomposed য় ড় ঢ়), never Bijoy/ANSI. `fill.py` puts it in the
  complex-script font slot (Nikosh) in Word and uses a Bangla TTF with shaping on PDF overlays.
- Use Bangla numerals (০১২৩…) only if the form itself prints its numbers that way; otherwise use
  0–9. Dates follow the format the form shows (`DD/MM/YYYY` unless the form says otherwise).
- Bangla typed into a fillable PDF field may show as boxes in viewers without a Bangla font;
  `fill.py` notes this. If the render shows boxes, fill those fields by overlay instead.

## The reply

- Say in one or two sentences what was filled and from which documents.
- List every field left blank with its reason ("Date of birth — not in any attached document";
  "Signature — must be signed by hand").
- Mention anything the user should check: a long text that was shortened, a value taken from an
  older document, a choice you made between conflicting sources.
- Attach the filled file. No `/mnt/data` paths, no script names, no narrated steps.
- "Give me the Docx you were supposed to give": deliver the filled file now from the mapping you
  already have; do not restart or ask again.

## Gotchas

- `fields.py` exits 2 on a flat PDF. That is the overlay route, not an error.
- Overlay coordinates: points with the origin at the bottom left and y on the text baseline; or
  `"units": "px"` with the `dpi` the page image was rendered at (origin top left). Use the candidate
  blanks from `fields.json` when they exist; they are exact. For a scan, render at the same dpi
  (`pdftoppm -r 100 -png -f N -l N FORM.pdf /mnt/data/qa/page`), and write on the line, just above it.
- Give long overlay values a `width` (and `height` for a box) so they wrap and the gate can catch
  overflow. Size 9–11 pt matches most printed forms.
- A Word value goes into the cell, control or blank in that place's own formatting; multi-line
  values in a cell become line breaks, in an underscore blank they become one line.
- Table rows in Word grow to fit, so long cell text is fine; in a PDF field it is clipped, which is
  why `fill.py` and `check.py` fail on PDF overflow.
- Dynamic XFA PDFs (show "Please wait…" outside Adobe Reader) cannot be filled here; tell the user
  to fill it in Adobe Reader, or offer a Word version of the form.
