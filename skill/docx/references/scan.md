# From a scan or photo of a page to Word

"Convert this to Word", "type this up", or "a new one in exactly this layout" with a picture of an office order, letter or notice. The user wants their page back as an editable file that looks like the picture.

"Convert" means the user's own document: keep every name, number and signature. Only "a new one like this" with new details from the user replaces them; with no new details it still keeps the sample's text.

A scanned PDF works the same way: first render it with `pdftoppm -r 150 -png <file>.pdf /mnt/data/qa/page`, and treat each page image as the scan.

The whole job is five tool calls after loading this skill. Do not add OCR, enlarged crops, or a hand-written docx-js script: each of those has cost runs ten extra steps and made the file worse.

## If `read_document` saved elements

When the `read_document` tool has read this file, `/mnt/data/document-<id>.elements.json` exists. Do not transcribe: the words come from it. Make the page image with `pdftoppm -r 150 -png <pdf> qa/page` if the source is a PDF, then:

```bash
mkdir -p /mnt/data/qa && cd /mnt/data && python3 /mnt/data/skills/docx/scripts/elements_spec.py document-<id>.elements.json qa/spec.json --scan <page image>
```

The report lists the blocks and the crops. Read the page image once with `read_file` and open `qa/spec.json`: fix any block type that came out wrong (a letterhead line taken as a title, a signature block taken as paragraphs) with `edit_file`, without retyping text. Where a word is plainly misread, correct that word from the image. A crop printed with a box goes to `crop.py` as is; one marked `(box needed)` takes its box from the image. A picture the elements missed but the page shows, such as a logo or seal, gets its own crop and block. Then do step 2, leaving out the `cat > qa/spec.json` part, and steps 3 and 4.

If the file is not there, or `read_document` said it could not read the file, carry on from step 1.

Asked for a PDF rather than Word: build the Word file the same way; `letter.py` leaves the PDF at `qa/<name>.pdf`, so copy that to `/mnt/data/<name>.pdf` and deliver it.

## 1. Look at the scan

Make the reading copies, in a call of its own:

```bash
mkdir -p /mnt/data/qa && cd /mnt/data && file <scan> && python3 /mnt/data/skills/docx/scripts/crop.py <scan> qa --read
```

Then, in one turn, read three images: `/mnt/data/qa/grid.jpg`, `/mnt/data/qa/read-top.jpg` and `/mnt/data/qa/read-bottom.jpg`. The halves are the page enlarged 2x, so read every word from them; use the grid for the layout and for the crop boxes. If the scan is not in `/mnt/data`, transcribe from the picture in the conversation, skip the crops, and say in one line that the logo and signatures were left out.

Write down every word: letterhead, memo number, both dates, title, body, signature blocks, addressee, the second memo line, and every copy-list entry with its own numbering (`২-১২।` stays one entry). Keep Bangla digits as Bangla digits. A handwritten digit you cannot read becomes `[?]`; printed text you can read is copied, not marked. Do not run tesseract: on these scans it returns noise.

Take the pixel box of the logo, each signature and any seal from the red rulers on `grid.jpg`, whose labels are scan pixels; never estimate a box by eye. A signature box covers the handwriting only: stop below the printed line above it and above the printed name under it, and leave out margin notes that run into it. Write the crops and the spec only after you have read all three images.

## 2. Crop, build and check in one call

```bash
mkdir -p /mnt/data/qa && cd /mnt/data && \
python3 /mnt/data/skills/docx/scripts/crop.py <scan> qa logo=X0,Y0,X1,Y1 sig1=X0,Y0,X1,Y1 sig2=X0,Y0,X1,Y1 && \
cat > qa/spec.json <<'EOF'
{ ...the spec below... }
EOF
python3 /mnt/data/skills/docx/scripts/letter.py qa/spec.json /mnt/data/<name>.docx --source <scan>
```

`crop.py` trims each box to its ink, whitens the paper, and saves `qa/<name>.png`. If it prints `BOX CUTS INK`, a left or right side is almost always a cut signature: move that side in the one fix of step 4. A signature that truly touches the printed name under it may keep the warning on its bottom side. If a picture is still cut after that fix, say so in the reply. `letter.py` builds the document from the spec, shrinks margins and type until it fits the page count, validates it, renders it, and writes `qa/<name>-compare.jpg` (scan left, your page right). Its last lines are the report. It already sets the file's author and last-modified-by to Synapse, so do not set them again.

The spec is data. Use the block types in the order they appear on the page:

```json
{
  "pages": 1,
  "font": {"latin": "Times New Roman", "bangla": "Nikosh", "size": 12},
  "blocks": [
    {"type": "letterhead", "logo": "/mnt/data/qa/logo.png", "logo_width_cm": 1.6,
     "lines": [{"text": "বাংলাদেশ বিশ্ববিদ্যালয় মঞ্জুরী কমিশন", "size": 18, "bold": true},
               {"text": "University Grants Commission of Bangladesh", "size": 13, "bold": true},
               {"text": "আগারগাঁও, শেরে বাংলা নগর, ঢাকা-১২০৭", "size": 11}]},
    {"type": "memo", "left": "স্মারক নং- ...", "right": ["তারিখ : ০১ আশ্বিন ১৪৩৩", "১৬ সেপ্টেম্বর ২০২৬"]},
    {"type": "title", "text": "অফিস আদেশ", "underline": true},
    {"type": "paragraph", "text": "..."},
    {"type": "signature", "intro": "কর্তৃপক্ষের অনুমোদনক্রমে,", "image": "/mnt/data/qa/sig1.png",
     "lines": ["তাহমিনা রহমান", "যুগ্মসচিব", "ফোন : ..."]},
    {"type": "address", "lines": ["...", "..."]},
    {"type": "heading", "text": "সদয় অবগতি ও প্রয়োজনীয় কার্যার্থে অনুলিপি ...", "underline": true, "bold": true},
    {"type": "list", "items": [["১।", "সচিব, ইউজিসি, ঢাকা।"], ["২-১২।", "..."]]},
    {"type": "signature", "image": "/mnt/data/qa/sig2.png", "lines": ["মোঃ ...", "সিনিয়র সহকারী সচিব"]}
  ]
}
```

Other blocks: `{"type": "image", "path": ..., "width_cm": ...}`, `{"type": "spacer", "pt": 6}` and `{"type": "table", "rows": [[{"text": ..., "header": true, "colspan": 2, "rowspan": 1}, ...], ...], "widths_cm": [...]}`. Any block takes `align` (left, center, right, justify), `size`, `bold`, `space_before` and `space_after` in points. A signature is its cropped image plus its printed lines; never type the handwriting out as text.

Handwritten margin notes, "Received" stamps and initials added after printing are not part of the document: leave them out and say so in one line.

## 3. Look at the comparison

`read_file /mnt/data/qa/<name>-compare.jpg`, on its own. Check that every block is present and in the same place as on the scan. Check each signature and logo image too: printed words caught in one, or a stray line beside it, need a tighter box. The report already tells you the page count, the pictures placed and any missing font, so do not judge those from the picture.

## 4. One fix, if needed

Change `qa/spec.json` with `edit_file` (several edits in one call), then rerun only the `letter.py` line. For a bad crop, rerun `crop.py` for that box first, in the same command. Check the report; deliver. If only minor spacing differs, deliver and mention it. Never start a third round.
