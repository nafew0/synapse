---
name: pdf-to-docx
description: "Use when converting a PDF into an editable Word document (.docx) — 'convert this PDF to Word', 'make this editable', or any request that starts from a .pdf and ends in a .docx. Not for reading a PDF's text (use the pdf skill) or for producing a new document from scratch (use the docx skill)."
license: Proprietary. LICENSE.txt has complete terms
---

# PDF to Word

## Which skill is this

| The request | The skill |
|---|---|
| A PDF in, a Word file out — "convert to Word", "make this editable" | **this skill** |
| Read, search, split, merge, fill or OCR a PDF; produce a PDF | `pdf` |
| Write a new Word document, or edit one the user already has | `docx` |
| "Just give me a picture of each page in Word" | this skill, `--mode visual-fidelity` |

## The rule that matters most

**Never build the Word document yourself.** Not with `python-docx`, not by reading the PDF's text
and re-typing it into a new file, not by styling a rebuild to look like the original. Every such
rebuild silently drops the logo, the seal and the signature — the parts of an office order that
make it an office order — because the text is all you extracted. Two delivered files have already
failed this way: one holding nine page images and one character of text, one a hand-styled rebuild
of a Khulna University order with all four of its images gone.

`convert.py` is the only way to produce the file. The gate below runs on whatever you are about to
deliver, however it was made, and a hand-built document fails it.

## The three fidelity modes

| Mode | Guarantees | Does not |
|---|---|---|
| `semantic-editable` | Real Word paragraphs, headings, lists and tables in reading order that **reflow when typed into**; tables at the column widths the page gave them; a repeated letterhead and page footer moved into Word's own header and footer, with `PAGE`/`NUMPAGES` fields; logos, seals, signatures and QR codes taken from the PDF's own image streams and placed at the size it drew them, so a QR still scans; justification, tabbed fields, indents and the spacing between blocks carried over; Bangla and English both named in the font slots Word reads | Reproduce the original layout line for line. Text is re-laid out, so a page may gain or lose a line |
| `layout-editable` | Every line where the PDF had it, images anchored where they sat, page size and page count preserved | Reflow. Each line is its own positioned box: typing into one grows it past its frame while its neighbours stay put |
| `visual-fidelity` | Near-exact appearance: one full-page picture per page | Produce text that can be edited, searched or copied |

**Pick by what the user is going to do with the file.**

- They want to *edit the wording* — "make this editable", "convert to Word", "I need to change a
  few lines of this order" → `semantic-editable`. This is the usual request.
- The layout is the document and must come back identical — a form, a certificate, a bill,
  anything to be reprinted as-is → `layout-editable`.
- They asked for a picture of the pages → `visual-fidelity`, and say so in the reply.

Always pass `--mode` explicitly; do not rely on the CLI's default. Silently switching an editable
request to page images is the failure this skill exists to prevent.

**Why `layout-editable` is not the safe choice it looks like.** It reproduces the page exactly and
is unusable for editing: a delivered order came back with "when I try to edit the doc the text
gets broken", because every line sat in its own box. If the user said "editable", they meant they
would type into it.

### What `semantic-editable` does not do

These are the cases where it is the wrong mode, not bugs to work around. The gate catches the
first two; the third has no signature to catch.

- **Pages set in columns.** Lines are recovered by their vertical position, so two columns come
  back interleaved — left line 1, right line 1, left line 2. The gate reports `columns` and names
  `layout-editable` as the mode to use.
- **Dense pages that no longer fit.** Text re-set in another face takes different room. A page of
  a textbook can spill onto two, and the gate reports the page count it actually lays out to.
- **Vector artwork.** Coloured panels, rules, drawn icons and chart lines are not rasters and are
  not carried; the text on top of them survives, the design does not. A designed document — a
  brochure, a slide-style report — wants `layout-editable`, or `visual-fidelity` if the look is
  the point.
- **Merged table cells** come back as separate empty cells, and a table without ruling lines is
  only found when its columns line up.

## The one command

```bash
python /mnt/data/skills/pdf-to-docx/scripts/convert.py /mnt/data/input.pdf /mnt/data/output.docx \
  --mode semantic-editable
```

It prints one line of JSON — mode, pages, characters recovered against the source, images carried
over — and exits non-zero without writing a file when it cannot honour the mode. It does not fall
back to another mode; neither should you.

For `layout-editable` it also repairs what LibreOffice's import leaves broken: a full-bleed page
fill is re-anchored to the page origin *behind* the text (untouched, it paints over the text and a
dark page turns into a solid block), and any raster the import dropped is re-inserted at its
source rectangle. `--no-restore` skips that repair; use it only to isolate a problem.

## Mandatory gate before delivery

A file that exists is not a conversion that worked. Run the gate, every time:

```bash
python /mnt/data/skills/pdf-to-docx/scripts/verify_conversion.py /mnt/data/input.pdf \
  /mnt/data/output.docx --mode semantic-editable
```

It checks page count, text recovered against the PDF (70% floor, and never a token few hundred
characters), that no page-sized image stands in for a page, that every raster in the PDF is in
`word/media`, that every QR still decodes, that the file actually opens, and that the Word page
matches the PDF page. Text and pictures are counted across the headers and footers too, so a
letterhead moved into a real Word header is not read as content that went missing. The image and QR checks run in every mode — a lost seal is a defect however
the file was produced.

Pass the same `--mode` you converted with; three checks change with it.

- `semantic-editable` adds the reflow check: a single text box in the document fails the run,
  because that is the defect this mode exists to remove.
- `semantic-editable` counts the pages LibreOffice actually lays the document out to, not the
  breaks the file carries, and allows a quarter of the source's page count in drift — reflowed
  text repaginates. `layout-editable` counts breaks and allows no drift.
- `semantic-editable` refuses a document set in columns, which it would otherwise read straight
  across.
- Pictures are matched by the rectangle they fill rather than by pixel count in
  `semantic-editable`. A picture may be re-rendered, and Word stores one copy of a raster placed
  on two pages; the rectangle is what both sides agree on. A lost logo leaves its rectangle
  empty and is still reported.

- Exit 0 prints a one-line summary. Exit 2 lists every defect. Exit 1 means bad arguments.
- **Do not return or attach the .docx unless the gate exits 0.** Do not widen `--min-text` to make
  a failing run pass — the floor is the promise.
- On a defect, fix the cause or say which check failed and stop. Falling back to page images is
  not a fix; if the user wants the picture they can ask for `visual-fidelity`.

## What the final response says

State the mode delivered, the pages converted, and what the gate verified — quoting its numbers,
not adjectives:

> Converted to Word in `semantic-editable` mode: 1 page, 572 of the PDF's 579 characters recovered
> as editable paragraphs, 3 of 3 images carried over, 1 table rebuilt. The verification gate
> passed: the text reflows as paragraphs, all images present, QR code still decodable, page size
> unchanged.

Never describe a file as editable, or its layout as preserved, without a clean gate run behind the
claim.

## Gotchas

- `soffice --convert-to docx` on a PDF fails with **"no export filter"** — LibreOffice imports a
  PDF into Draw, and Draw cannot write Word. `convert.py` passes `--infilter=writer_pdf_import` to
  route the import through Writer. Do not assemble the command yourself.
- `/tmp` and `/mnt/data` are both `noexec`: run `python script.py`, never `./script.py`.
- **Only the deliverable belongs in `/mnt/data`.** Every new file there is attached to your reply,
  so a round-trip render you made to eyeball the result arrives in the user's chat looking like
  their own upload coming back. Put intermediates in `/tmp` — it is wiped between tool calls,
  which is exactly what you want for them — and keep the one `.docx` in `/mnt/data`. Do not copy
  the user's input into `/mnt/data`; it is already there.
- LibreOffice writes every text box twice — DrawingML in `mc:Choice`, VML in `mc:Fallback`. Any
  text you extract yourself will be doubled unless you skip the fallback branch; `probe.py` does.
- A PDF of scanned pages has no text to recover. The gate says so rather than pretending; that
  document needs OCR (the `pdf` skill) before any conversion is worth attempting.

## Files

| Path | What it does |
|---|---|
| `scripts/convert.py` | The conversion, in one of three modes. Prints a JSON summary |
| `scripts/verify_conversion.py` | The gate. Exit 0 clean, 2 defects, 1 bad input |
| `scripts/semantic.py` | The `semantic-editable` rebuild: paragraphs, headings, lists, tables, pictures |
| `scripts/restore.py` | Page-background and dropped-image repair, run by `convert.py` |
| `scripts/probe.py` | Shared PDF and .docx measurements used by both scripts |
