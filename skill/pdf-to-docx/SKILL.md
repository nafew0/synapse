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

Never reach for `pdf` + `docx` to hand-roll a conversion. That route is what produced a 993 KB
file holding nine page images and one character of text, delivered as "an editable Word document".

## The three fidelity modes

| Mode | Guarantees | Does not |
|---|---|---|
| `layout-editable` (default) | Editable text in boxes positioned as the PDF had them, images anchored where they sat, page size and page count preserved | Reflow like a document typed in Word; paragraphs are boxes, not a flowing body |
| `semantic-editable` | Flowing Word paragraphs in reading order, page size and page count preserved — the natural choice when the user wants to *rewrite* the text | Keep coordinates, images, or any positioning |
| `visual-fidelity` | Near-exact appearance: one full-page picture per page | Produce text that can be edited, searched or copied |

**Default to `layout-editable`.** Use `visual-fidelity` only when the user asked for a picture of
the pages, and say so in the reply. Silently switching an editable request to page images is the
failure this skill exists to prevent.

## The one command

```bash
python /mnt/data/skills/pdf-to-docx/scripts/convert.py /mnt/data/input.pdf /mnt/data/output.docx \
  --mode layout-editable
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
  /mnt/data/output.docx --mode layout-editable
```

It checks page count, text recovered against the PDF (70% floor, and never a token few hundred
characters), that no page-sized image stands in for a page, that every raster in the PDF is in
`word/media`, that every QR still decodes, and that the Word page matches the PDF page.

- Exit 0 prints a one-line summary. Exit 2 lists every defect. Exit 1 means bad arguments.
- **Do not return or attach the .docx unless the gate exits 0.** Do not widen `--min-text` to make
  a failing run pass — the floor is the promise.
- On a defect, fix the cause or say which check failed and stop. Falling back to page images is
  not a fix; if the user wants the picture they can ask for `visual-fidelity`.

## What the final response says

State the mode delivered, the pages converted, and what the gate verified — quoting its numbers,
not adjectives:

> Converted to Word in `layout-editable` mode: 2 pages, 489 of the PDF's 489 characters recovered
> as editable text, 1 image carried over. The verification gate passed: page count, page size, all
> images present, QR code still decodable.

Never describe a file as editable, or its layout as preserved, without a clean gate run behind the
claim.

## Gotchas

- `soffice --convert-to docx` on a PDF fails with **"no export filter"** — LibreOffice imports a
  PDF into Draw, and Draw cannot write Word. `convert.py` passes `--infilter=writer_pdf_import` to
  route the import through Writer. Do not assemble the command yourself.
- `/tmp` and `/mnt/data` are both `noexec`: run `python script.py`, never `./script.py`.
- `/tmp` does not survive between tool calls. Keep inputs, outputs and any scratch file under
  `/mnt/data`.
- LibreOffice writes every text box twice — DrawingML in `mc:Choice`, VML in `mc:Fallback`. Any
  text you extract yourself will be doubled unless you skip the fallback branch; `probe.py` does.
- A PDF of scanned pages has no text to recover. The gate says so rather than pretending; that
  document needs OCR (the `pdf` skill) before any conversion is worth attempting.

## Files

| Path | What it does |
|---|---|
| `scripts/convert.py` | The conversion, in one of three modes. Prints a JSON summary |
| `scripts/verify_conversion.py` | The gate. Exit 0 clean, 2 defects, 1 bad input |
| `scripts/restore.py` | Page-background and dropped-image repair, run by `convert.py` |
| `scripts/probe.py` | Shared PDF and .docx measurements used by both scripts |
