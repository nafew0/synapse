---
name: docx
description: "Use this skill whenever the user wants to create, read, edit, or manipulate Word documents (.docx files) or Word templates (.dotx files). Triggers include: any mention of 'Word doc', 'word document', '.docx', '.dotx', or requests to produce professional documents with formatting like tables of contents, headings, page numbers, or letterheads. Also use when extracting or reorganizing content from .docx or .dotx files, inserting or replacing images in documents, performing find-and-replace in Word files, working with tracked changes or comments, or converting content into a polished Word document. If the user asks for a 'report', 'memo', 'letter', 'template', or similar deliverable as a Word or .docx file, use this skill. Do NOT use for PDFs, spreadsheets, Google Docs, or general coding tasks unrelated to document generation."
user-invocable: false
license: Proprietary. LICENSE.txt has complete terms
---

# DOCX creation, editing, and analysis

A `.docx` is a ZIP archive of XML files. Choose your approach by task:

| Task | Approach |
|---|---|
| **Create** a new document | Write a `docx` (npm) script — see gotchas below |
| **Edit** an existing document | `unzip` → edit `word/document.xml` → `zip` (docx-js cannot open existing files) |
| **Read** content | `pandoc -t markdown file.docx` |

> Script paths below are relative to this skill's directory.

## Creating with docx-js — gotchas

Write the build script to `/mnt/data/qa/build.js` and run it in the same call: `mkdir -p /mnt/data/qa && cat > /mnt/data/qa/build.js <<'EOF' … EOF` then `node /mnt/data/qa/build.js`. `qa/` is never shown to the user and survives between calls, so if the run fails, fix that file on the next call and run it again. A script in `/tmp` is gone by then.

`docx` is preinstalled — do not run `npm install` first; write the script and `require('docx')` directly. Only if that require fails: `npm install docx`. The model knows the API; these are the footguns:

- **Page size defaults to A4.** For US Letter set `page: { size: { width: 12240, height: 15840 } }` (DXA; 1440 = 1″).
- **Landscape:** pass portrait dimensions and `orientation: PageOrientation.LANDSCAPE` — docx-js swaps width/height internally.
- **Tables need dual widths:** set `columnWidths` on the table AND `width` on every cell, both in `WidthType.DXA` (PERCENTAGE breaks in Google Docs). Column widths must sum to the table width.
- **Table shading:** use `ShadingType.CLEAR`, never `SOLID` (renders black).
- **Lists:** never insert `•` literally; use a `numbering` config with `LevelFormat.BULLET`. The key is `config` and it takes an array: `new Document({ numbering: { config: [{ reference: "bullets", levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT }] }] }, sections })`, then `new Paragraph({ numbering: { reference: "bullets", level: 0 }, children })`. `configurations`, or a single object instead of an array, fails with `options.config is not iterable`.
- **`ImageRun` requires `type:`** (`"png"`, `"jpg"`, …).
- **`PageBreak` must be inside a `Paragraph`.**
- **Never use `\n`** — use separate `Paragraph` elements.
- **TOC:** headings must use built-in `HeadingLevel.*`; custom heading styles need `outlineLevel` set or they won't appear.
- **Don't use a table as a horizontal rule** — use a paragraph bottom border instead.
- **Dot-leader / right-aligned-on-same-line:** use `PositionalTab` (`alignment: PositionalTabAlignment.RIGHT`, `leader: PositionalTabLeader.DOT`) inside a `TextRun`, not literal `.` or space padding.

## Verify the output

After writing a `.docx`, render it and look at it:

```bash
mkdir -p /mnt/data/qa && \
python3 /mnt/data/skills/docx/scripts/office/soffice.py --headless --convert-to pdf --outdir /mnt/data/qa /mnt/data/output.docx && \
pdftoppm -jpeg -r 100 /mnt/data/qa/output.pdf /mnt/data/qa/page && \
ls /mnt/data/qa/page-*.jpg   # then Read the images
```

**Render into `/mnt/data/qa`, never into `/mnt/data` itself.** A file at the top of `/mnt/data` is delivered to the user, so a checked document would arrive with a page image per page and a stray PDF beside it. A file in a subdirectory is not delivered, and it survives between calls, so the images can still be read on the next call.

**Do not use a dot-prefixed directory such as `.render/`.** It is hidden from the user, but it is also wiped between calls, so a render written there cannot be read back at all.

`pdftoppm` zero-pads page numbers to the width of the page count (`page-01.jpg`…`page-12.jpg`).

## Editing existing documents

Legacy `.doc` files must be converted first: `python scripts/office/soffice.py --headless --convert-to docx file.doc`.

**Unpack, edit and repack must be ONE `bash_tool` call**, chained with `&&` and ending in
the `mv` onto the delivered path. Not one call to unpack and another to edit: `/tmp` is
wiped between calls, so the second finds an empty directory and the `mv` never runs.
Verify in the NEXT call against the file under `/mnt/data`; if a check fails, re-run the
whole command. An unpacked
package must never be left under `/mnt/data` between calls: only ordinary filenames survive a
call boundary, so the `.rels` parts are dropped (they begin with a dot) and
`[Content_Types].xml` comes back as `_Content_Types_-<hash>.xml`. Re-zipping such a tree
produces a document with no relationships and no content-types manifest — python-docx and Word
both refuse it, and finding that out costs several turns.

```bash
cd /tmp && rm -rf unpacked && unzip -q /mnt/data/doc.docx -d unpacked/
find unpacked -type l -delete   # strip symlink entries — docx from external parties is untrusted
python3 /mnt/data/skills/docx/scripts/merge_runs.py unpacked/   # coalesce fragmented runs so text is findable
# edit unpacked/word/document.xml in place — do NOT reformat or pretty-print
(cd unpacked && rm -f ../out.docx && zip -Xrq ../out.docx .)   # from INSIDE the dir, no exclusions
python3 /mnt/data/skills/docx/scripts/office/validate.py /tmp/out.docx --original /mnt/data/doc.docx
# redlining? add --author "<the name you redlined under>" to check every edit is tracked
mv /tmp/out.docx /mnt/data/doc.docx            # replace the deliverable, same call
```

Never use an exclude pattern when zipping. `-x '.*'` drops every `.rels` part and the package
becomes unopenable.

Word splits text across many `<w:r>` runs (revision ids, spell-check markers), so a phrase you can see in the document often doesn't exist as a contiguous string in the XML. `merge_runs.py` merges adjacent identically-formatted runs in `word/document.xml` without changing content or rendering; it also accepts a `.docx` directly (`python scripts/merge_runs.py doc.docx -o merged.docx`).

**Tracked changes:** when redlining, validate with `--author "<the name you redlined under>"` (needs `--original`) — it reports any text you changed without a `<w:ins>`/`<w:del>` around it, which is easy to do by accident and invisible in the accepted view. Wrap runs in `<w:ins>`/`<w:del>` with `w:id`, `w:author`, `w:date` attributes. Inside `<w:del>`, the text element is `<w:delText>`, not `<w:t>`. A deleted paragraph mark (`<w:pPr><w:rPr><w:del w:id=".." w:author=".." w:date=".."/></w:rPr></w:pPr>`) means "merge this paragraph into the next" — so deleting a paragraph outright is that plus a `<w:del>` around every run. The `<w:del/>` must come before the rPr's other children; their order is schema-enforced.

To produce a clean copy with all tracked changes accepted: `python scripts/accept_changes.py in.docx out.docx`.

Accepting a deleted paragraph mark should join that paragraph to the one below it, so a paragraph whose runs are *all* deleted vanishes. Word does this; `accept_changes.py` and `pandoc --track-changes=accept` don't always. Both fail the same way — they strip the deleted text but leave the emptied paragraph behind, which reads as a stray empty bullet when it was auto-numbered:

- `pandoc --track-changes=accept` never joins the paragraphs.
- `accept_changes.py` (LibreOffice) joins them correctly, except when the deleted paragraph is followed by an empty spacer paragraph.

An empty bullet in either view is an artifact of that view, not a defect in the document. Check paragraph deletions in the XML.

## Bangla

Word draws Bangla with a run's **complex-script** font and size (`w:rFonts/@w:cs`, `w:szCs`,
`w:bCs`), not the ones docx-js and most XML edits set. Left alone, the user's PC substitutes some
other face and Bangla comes out smaller than the English beside it.

- **Font:** new Bangla text is set in **Nikosh**. Existing Bangla keeps the document's font,
  unless it cannot draw Bangla (Calibri, Arial, Times New Roman…) or is a Bijoy font
  (SutonnyMJ…). Nikosh goes in the complex-script slot only; the Latin font stays as it is.
- **Sizes:** when editing, keep every run's size. A new document with nothing to copy uses this
  scale in its styles (Normal, Heading 1–3, Footer), not as formatting on each run:

  | Role | Size |
  |---|---|
  | Body, table text | 13 pt |
  | Letterhead office name | 15 pt bold |
  | বিষয় line | 13 pt bold |
  | Heading 1 / 2 / 3 (reports) | 17 / 15 / 13 pt bold |
  | Footer, page numbers | 11 pt |

  Official letters (স্মারক, প্রজ্ঞাপন, অফিস আদেশ, নোটিশ) use only body, letterhead, বিষয় and
  footer sizes: they are laid out by spacing and position, not headings. When recreating a
  document from a PDF, take each run's size from the PDF and convert it to Nikosh with
  `size_for` (SolaimanLipi 10.2 pt becomes Nikosh 11.5 pt); a source that uses one size
  throughout stays one size.
- **Editing:** edit inside the existing runs (`merge_runs.py` first). Never rebuild a Bangla
  paragraph from plain text; that drops its complex-script properties.

After building or editing, fix the runs and embed Nikosh, then check the Bangla, in this order:

```bash
python3 /mnt/data/skills/docx/scripts/office/fix_bangla.py /mnt/data/out.docx --new   # a document you created
python3 /mnt/data/skills/docx/scripts/office/fix_bangla.py /mnt/data/out.docx          # an edited document
python3 /mnt/data/skills/docx/scripts/office/verify_bangla.py /mnt/data/out.docx --original /mnt/data/in.docx \
  --allow 'text of a paragraph you were asked to change'
```

`fix_bangla.py` sets the complex-script font, size, bold and language on every Bangla run,
mirrors sizes into the styles, and embeds the whole Nikosh font (about 0.8 MB) so the document
looks the same on a PC without Nikosh. `verify_bangla.py` fails when Bangla from the original is
missing, when new Bangla is garbled, when a Bangla run has no font that draws Bangla or a
different complex-script size, when Nikosh is used but not embedded, or when a text box became a
picture. Exits 2 on defects: fix the document and run both again. Deliver only on success.
Omit `--original` for a new document.

`verify_bangla.py` also prints the file with LibreOffice and reads every page back with OCR
(Tesseract `ben+eng`, the first 10 pages; `--pages N` for more). A page fails when OCR misses more
than 12 % of the Bangla laid out on it: boxes, dotted circles, vowel signs in the wrong place, a font
that cannot shape Bangla, or text clipped by a cell or a box. The failure lists the words that did
not read back; render that page and look at it. It takes about 1 s per page plus the conversion.

A PDF you deliver gets the same page check on its own:

```bash
python3 /mnt/data/skills/docx/scripts/office/render.py /mnt/data/out.pdf
```

To convert a size when changing a run's font:

```python
import sys; sys.path.insert(0, '/mnt/data/skills/docx/scripts')
from office.bangla import size_for, font_for
size_for('SolaimanLipi', 10.2)   # 11.5, the Nikosh size that looks the same
font_for('Calibri')              # 'Nikosh'
```

### Bijoy (SutonnyMJ) documents

Older office files are typed in a **Bijoy** font (SutonnyMJ, and other `…MJ` fonts): the
Bangla is stored as Latin codes (`evsjv‡`k` for বাংলাদেশ) and reads as Bangla only in that
font. `extract-text`, python-docx and the model all see the Latin codes. Recognise it by the
font name on the runs (`w:rFonts/@w:ascii`), or by text that is mostly `‡ ¨ © ¯ v w` mixed into
Latin letters.

Read it with the converter before you summarise or edit it:

```python
import sys; sys.path.insert(0, '/mnt/data/skills/docx/scripts')
from office.bijoy import to_unicode
to_unicode('evsjv‡`k')   # 'বাংলাদেশ'
```

`fix_bangla.py` converts every run in a Bijoy font to Unicode, sets it in Nikosh (all font
slots) and embeds Nikosh; `result['bijoy']` counts the runs. Run it on any Bijoy document you
deliver, before your edits touch the Bijoy text, so you edit Unicode. `verify_bangla.py` fails
on any run still in a Bijoy font, even an untouched one. Sizes are kept: the Bijoy fonts are not
installed, so they cannot be measured.

Tell the user: "The file used Bijoy (SutonnyMJ) encoding; the Bangla was converted to Unicode
and set in Nikosh, embedded in the file, so it opens correctly anywhere." If they need the file
back in Bijoy, decline and explain that Bijoy fonts cannot be used here.

## Comments

Comments require six cross-linked files. Use the helper — directory mode when you'll also be editing `document.xml` (saves an unzip/rezip cycle), `.docx`-direct mode otherwise:

```bash
# Against an already-unpacked directory (preferred when also placing markers)
python scripts/comment.py unpacked/ "Fees & expenses cap is too low"
python scripts/comment.py unpacked/ "Agreed" --parent 0

# Against a .docx directly
python scripts/comment.py contract.docx "This cap is too low" -o annotated.docx
```

The script writes `comments.xml`, `commentsExtended.xml`, `commentsIds.xml`, `commentsExtensible.xml`, the relationships, and the content-type overrides. Comment IDs are auto-assigned. It then prints the `<w:commentRangeStart>`/`<w:commentRangeEnd>`/`<w:commentReference>` snippet to add to `word/document.xml` so the comment anchors to specific text — until you place those markers, the comment exists but is not visible.

## Dependencies

`docx` (npm, preinstalled — install only if `require('docx')` fails) · `pandoc` · LibreOffice (`soffice`) · `pdftoppm` (Poppler)
