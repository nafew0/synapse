# From a scan or photo of a page to Word

"Convert this to Word", "type this up", or "a new one in exactly this layout" with a picture of an office order, letter or notice. The user wants their page back as an editable file that looks like the picture.

"Convert" means the user's own document: keep every name, number and signature. Only "a new one like this" with new details from the user replaces them; with no new details it still keeps the sample's text.

The whole job is five tool calls after loading this skill. Do not add OCR, enlarged crops, or a hand-written docx-js script: each of those has cost runs ten extra steps and made the file worse.

## 1. Look at the scan

Make the reading copies, in a call of its own:

```bash
mkdir -p /mnt/data/qa && cd /mnt/data && file <scan> && python3 /mnt/data/skills/docx/scripts/crop.py <scan> qa --read
```

Then, in one turn, read three images: `read_file /mnt/data/<scan>`, `/mnt/data/qa/read-top.png` and `/mnt/data/qa/read-bottom.png`. The halves are the page enlarged 2x, so read every word from them; use the whole scan for the layout and for the crop boxes, in the scan's own pixels (its size is in the `file` output). If the scan is not in `/mnt/data`, transcribe from the picture in the conversation, skip the crops, and say in one line that the logo and signatures were left out.

Write down every word: letterhead, memo number, both dates, title, body, signature blocks, addressee, the second memo line, and every copy-list entry with its own numbering (`২-১২।` stays one entry). Keep Bangla digits as Bangla digits. A handwritten digit you cannot read becomes `[?]`; printed text you can read is copied, not marked. Do not run tesseract: on these scans it returns noise.

Note the pixel box of the logo, each signature and any seal. A signature box covers the handwriting only: stop above the printed name under it, and leave out margin notes that run into it.

## 2. Crop, build and check in one call

```bash
mkdir -p /mnt/data/qa && cd /mnt/data && \
python3 /mnt/data/skills/docx/scripts/crop.py <scan> qa logo=X0,Y0,X1,Y1 sig1=X0,Y0,X1,Y1 sig2=X0,Y0,X1,Y1 && \
cat > qa/spec.json <<'EOF'
{ ...the spec below... }
EOF
python3 /mnt/data/skills/docx/scripts/letter.py qa/spec.json /mnt/data/<name>.docx --source <scan>
```

`crop.py` trims each box to its ink, whitens the paper, and saves `qa/<name>.png`. `letter.py` builds the document from the spec, shrinks margins and type until it fits the page count, validates it, renders it, and writes `qa/<name>-compare.jpg` (scan left, your page right). Its last lines are the report. It already sets the file's author and last-modified-by to Synapse, so do not set them again.

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

Other blocks: `{"type": "image", "path": ..., "width_cm": ...}` and `{"type": "spacer", "pt": 6}`. Any block takes `align` (left, center, right, justify), `size`, `bold`, `space_before` and `space_after` in points. A signature is its cropped image plus its printed lines; never type the handwriting out as text.

Handwritten margin notes, "Received" stamps and initials added after printing are not part of the document: leave them out and say so in one line.

## 3. Look at the comparison

`read_file /mnt/data/qa/<name>-compare.jpg`, on its own. Check that every block is present and in the same place as on the scan. The report already tells you the page count, the pictures placed and any missing font, so do not judge those from the picture.

## 4. One fix, if needed

Change `qa/spec.json` with `edit_file` (several edits in one call), then rerun only the `letter.py` line. Check the report; deliver. If only minor spacing differs, deliver and mention it. Never start a third round.
