# QA details

`scripts/check.py` runs all of this in one call. This file explains what each check means; read it only when a check reports something you do not understand.

## The checks

Your first render usually has a few real issues — overlaps, overflow, misalignment. Find and fix those, re-render only the slides you changed, and stop.

**Keep it to one fix round, two at most.** Every tool call spends part of a fixed step budget for the whole request; a run that keeps polishing hits that limit, stops with an error, and the user receives no deck — even a finished one. Run the file, layout and render checks in one command; read the results once and list every defect before changing anything; fix them all in one edit and rebuild; re-check once. Layout-gate defects must be fixed, but if only minor visual polish remains after that, deliver and mention it. Do not load this skill again after the conversation is summarized — its rules still apply and your generator script is still in `/mnt/data/qa/`.

### Content QA

```bash
markitdown output.pptx
```

Check for missing content, typos, wrong order.

**When using templates, check for leftover placeholder text:**

```bash
markitdown output.pptx | grep -iE "\bx{3,}\b|lorem|ipsum|\bTODO|\[insert|this.*(page|slide).*layout"
```

If grep returns results, fix them before declaring success.

### File QA (required)

```bash
python3 /mnt/data/skills/pptx/scripts/fix_content_types.py output.pptx                    # pptxgenjs decks: always
python3 /mnt/data/skills/pptx/scripts/office/validate.py output.pptx                      # built from scratch
python3 /mnt/data/skills/pptx/scripts/office/validate.py output.pptx --original src.pptx  # built from a template
```

**Run `fix_content_types.py` first on anything pptxgenjs wrote.** It declares a slideMaster
per slide and writes one, so a four-slide deck claims `slideMaster1..4` and ships
`slideMaster1`. PowerPoint and LibreOffice ignore the strays; a reader that walks the
overrides does not — the artifact preview dereferences each one and a single missing part
leaves it with zero slides, so the user sees an empty deck. `validate.py` reports the same
fault, but this is the only thing that fixes it: the bug is in the library, not your code.

**If the deck came from a template, always pass `--original`.** A template may itself
contain parts the XSD rejects, so a bare run can report failures you never caused — and
a genuine regression can hide among them. `--original` baselines
the schema and slide checks against the template, suppressing errors it already had.
The structural checks — relationships, content types, charts — ignore `--original` and
report template-inherited problems either way, so read those on their own merits.

pptxgenjs emits chart XML PowerPoint refuses to open, and every other tool
accepts: python-pptx opens those decks, LibreOffice renders them, the XSD
passes them. Every failure names its fix. Fix it in the generator and rebuild.

### Mandatory layout gate

`validate.py` proves the file opens; it says nothing about whether the slides read correctly.
Run the layout check on every deck before you hand it over:

```bash
python3 /mnt/data/skills/pptx/scripts/check_layout.py out.pptx                        # new deck
python3 /mnt/data/skills/pptx/scripts/check_layout.py out.pptx --original deck.pptx   # edit or redesign; add --json for parsing
```

It reports four things a reader sees immediately, measured with the deck's real font metrics:
slides that are not 16:9 (and, with `--original`, a canvas that no longer matches the source),
text that outgrows its box (flagged when the overshoot is large, or when the overflow lands on
other text), text a later shape covers, and shapes off the canvas. It exits 0 when clean and 2
when it finds defects, each named by slide and shape.

- **Do not deliver a deck while the check reports defects.** Fix the generator — widen the box,
  shorten the line, move the shape — and rerun. "It looks fine in my head" is exactly the
  failure this catches.
- A defect it reports is a defect regardless of what the render looks like, because a renderer
  may substitute a narrower font than PowerPoint will use.
- It is a floor, not a ceiling: it cannot see contrast, alignment or crowding. Do the visual
  pass below as well.
- If the check cannot run at all, say so plainly in your final response rather than implying
  the deck was verified.

### Visual QA

**Use the bundled grid — do not hand-roll a montage.** One command renders every slide and
stitches a labelled contact sheet, into the scratch directory, and prints the path to read back:

```bash
python3 /mnt/data/skills/pptx/scripts/thumbnail.py out.pptx
# Created 1 grid(s):
#   /mnt/data/qa/thumbnails.jpg
```

Read that path and look at it. For a slide the grid makes you suspicious of, read its full-size
render — `/mnt/data/qa/slide-N.jpg`, produced by
[Converting to Images](#converting-to-images) — rather than squinting at the thumbnail.

Writing your own PIL montage is the one thing to avoid here: every hand-rolled one so far has been
saved to `/mnt/data/montage.png` and shipped to the user alongside the deck. Deleting it afterwards
does not help — an output is collected at the end of the call that wrote it, and nothing retracts
it later.

Inspect every slide. After staring at the generating code you tend to see what you expect rather
than what rendered, so look at the images fresh (a subagent works well for this if you have one).
User-visible defects to look for:

- **Text overflow or text cut off at a box or slide boundary — check this first.** It is the most common defect and always user-visible. (For a font the previewer renders unreliably per Typography, the preview is approximate: trust the ~10% slack you left, not its apparent fit.)
- Overlapping elements (text through shapes, lines through words, stacked elements)
- Source citations or footers colliding with content above
- Elements too close (< 0.3" gaps) or cards/sections nearly touching
- Uneven gaps (large empty area in one place, cramped in another)
- Insufficient margin from slide edges (< 0.5")
- Columns or similar elements not aligned consistently
- Low-contrast text (e.g., light gray text on cream-colored background)
- Template decoration mispositioned after text replacement — e.g., a title underline positioned for one line, but the replaced title wrapped to two
- Low-contrast icons (e.g., dark icons on dark backgrounds without a contrasting circle)
- Text boxes too narrow causing excessive wrapping
- Leftover placeholder content

**Finding a defect is half the job.** Fix it in the generator, rebuild, and re-render the slides
you changed before delivering — a deck shipped with overlapping text after you looked at it is
worse than one never checked, because the user reasonably assumes you looked. Say in the final
response which slides you checked and what you fixed.

## Converting to Images

Convert presentations to individual slide images for visual inspection:

```bash
mkdir -p /mnt/data/qa
python3 /mnt/data/skills/pptx/scripts/office/soffice.py --headless --convert-to pdf --outdir /mnt/data/qa output.pptx
rm -f /mnt/data/qa/slide-*.jpg
pdftoppm -jpeg -r 150 /mnt/data/qa/output.pdf /mnt/data/qa/slide
ls -1 /mnt/data/qa/slide-*.jpg
```

**Render into the directory `/mnt/data/qa/`, never into `/mnt/data` itself.** Everything written directly to `/mnt/data` is delivered to the user as a result, so a nine-slide deck checked there arrives as nine images and a stray PDF alongside the file they asked for. A file in a subdirectory is not delivered and survives between calls, so the renders can be read on the next call. `qa` is a directory, not a name prefix — `/mnt/data/qa_slides.pdf` is a top-level file and would be delivered. Do not use a dot-prefixed directory: it is wiped between calls. The same applies to any intermediate PDF, thumbnail grid or cropped image: if the user did not ask for it, it belongs under `/mnt/data/qa/`.

**Pass the absolute paths printed above directly to the view tool.** The `rm` clears stale images from prior runs. `pdftoppm` zero-pads based on page count: `slide-1.jpg` for decks under 10 pages, `slide-01.jpg` for 10-99, `slide-001.jpg` for 100+.

**After fixes, rerun all four commands above** — the PDF must be regenerated from the edited `.pptx` before `pdftoppm` can reflect your changes.
