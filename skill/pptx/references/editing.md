# Editing, redesigning and templates

Read this when the task starts from a deck or template the user gave you.

## Redesigning a deck the user gave you

A redesign changes how the deck looks. It does not change what it says.

- **Move the words, never rewrite them.** Copy each string from the source deck verbatim —
  titles, body copy, captions, footers, the lot. Shortening "A bounded assistant for a small
  pilot cohort — useful on approved content" into "Useful on approved content" drops the
  subject and leaves a sentence fragment on the slide; the user notices, and it reads as
  careless in a document going to their stakeholders. `markitdown deck.pptx` gives you the
  text to copy from.
- **If something genuinely will not fit, say so rather than paraphrasing.** Give the slide
  more room, use a smaller size, or split the content across two slides. Trimming a sentence
  to make a box work is a last resort, and the final response must name every line you changed.
- **Keep the slide count and order** unless the user asked for a different structure.
- **Ask first when the request is ambiguous.** "Redesign this" can mean restyle these exact
  slides, or build something new from the same material. Use `ask_user_question` — the two
  produce very different decks.
- **Match the source's canvas** exactly — see [Slide size](#slide-size).

## Editing existing decks and templates

Pick layouts first: `python scripts/thumbnail.py template.pptx template-thumbs` writes a labeled grid of every slide and prints the file(s) it created — `template-thumbs.jpg`, split into `template-thumbs-N.jpg` past 12 slides. **Always pass that second argument, named after the deck.** It defaults to `thumbnails`, so two decks thumbnailed in one directory silently overwrite each other's grids — the first deck's are simply gone (template analysis only — visual QA needs the full-resolution renders from [Converting to Images](#converting-to-images); it only accepts `.pptx`, so copy a `.potx` to a `.pptx` name first). Use it with `markitdown` to map each content section onto a template slide, and vary the layouts — don't put every section on the same title-and-bullets slide.

**Unpack, edit and repack must be ONE `bash_tool` call.** Not one call to unpack and another
to edit: `/tmp` is wiped between calls, so the second call finds an empty directory and the
`mv` that produces the deliverable never runs. Chain the whole thing with `&&` in a single
command:

```bash
cd /tmp && rm -rf unpacked && unzip -q /mnt/data/deck.pptx -d unpacked && \
python3 - <<'XML_EDIT' && \
from defusedxml.minidom import parse
doc = parse('unpacked/ppt/slides/slide1.xml')
# ... your edits ...
open('unpacked/ppt/slides/slide1.xml', 'w').write(doc.toxml())
XML_EDIT
(cd unpacked && rm -f ../out.pptx && zip -Xrq ../out.pptx .) && \
mv /tmp/out.pptx /mnt/data/deck.pptx
```

Verify in the NEXT call, against `/mnt/data/deck.pptx` — that is the copy that persists. If a
check fails, re-run the whole command above; it always starts from the delivered file.

The individual steps:

```bash
cd /tmp && rm -rf unpacked && python3 -c "import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall('unpacked')" /mnt/data/deck.pptx
python scripts/add_slide.py unpacked/ slide2.xml --after slide2.xml   # duplicate a slide (or slideLayoutN.xml); prints the new slide's path
# reorder / delete slides = edit <p:sldIdLst> in ppt/presentation.xml
python scripts/clean.py unpacked/                                     # after deletions: removes orphaned slides, media, rels
# edit slide content in ppt/slides/slideN.xml
(cd unpacked && rm -f ../out.pptx && zip -Xrq ../out.pptx .)          # from INSIDE the dir, no exclusions; rm first or deleted parts survive
mv /tmp/out.pptx /mnt/data/deck.pptx                                  # replace the deliverable, same call
python scripts/office/validate.py out.pptx --original deck.pptx
```

- **Do all structural work — add, delete, reorder — before editing any slide's content.** `add_slide.py` copies a slide file verbatim, so duplicating after you edit clones the edited content; and `clean.py` deletes any slide missing from `<p:sldIdLst>`, including one you just wrote.
- **Never copy a slide file by hand** — `add_slide.py` does every registration a new slide needs and reports what it made (`Created ppt/slides/slide17.xml from slide2.xml`). It also works directly on a file: `add_slide.py deck.pptx slide2.xml -o out.pptx` — **pass `-o`, or it rewrites the input deck in place.** A duplicated slide still *references* its source's chart/SmartArt/embedded-object parts rather than cloning them, so editing one slide's chart changes the other's.
- **If you use `python-pptx`**, three things it won't do: duplicate a slide (its only entry point is `add_slide(layout)`), preserve formatting through `text_frame.text = "..."` (that collapses the paragraph to a single unstyled run — assign `run.text` instead), or read the SVG/EMF most template art uses (`add_picture` raises `UnidentifiedImageError`).
- Legacy `.ppt` must be converted first: `python scripts/office/soffice.py --headless --convert-to pptx file.ppt`. `.potx` templates unpack and pack identically — keep the `.potx` extension on the output.
- To reuse a template icon or image, duplicate a slide or layout that already contains it.

When filling in a template:

- If you script an XML transform, parse with `defusedxml.minidom` — round-tripping OOXML through `xml.etree.ElementTree` rewrites namespace prefixes and corrupts the deck.
- **Template slots ≠ source items.** If the template shows 4 team members and you have 3, delete the 4th member's entire group (image + text boxes), not just its text — then check for orphaned visuals in QA.
- One `<a:p>` per list item — never concatenate items into a single paragraph. Copy the sibling `<a:pPr>` to preserve spacing, and put `b="1"` on the `<a:rPr>` of titles, section headers, and inline labels (`Status:`, `Owner:`).
- Let bullets inherit from the layout; only add `<a:buChar>`, `<a:buAutoNum>` (numbered), or `<a:buNone>` to override — never a literal `•` in the text.
- Text with leading or trailing spaces needs `xml:space="preserve"` on its `<a:t>`.

After the edit, run `scripts/check.py out.pptx --original <their deck>` (see QA in SKILL.md).
