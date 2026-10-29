---
name: pptx
description: "Use this skill any time a .pptx or .potx file is involved in any way — as input, output, or both. This includes: creating slide decks, pitch decks, or presentations; reading, parsing, or extracting text from any .pptx or .potx file (even if the extracted content will be used elsewhere, like in an email or summary); editing, modifying, or updating existing presentations; combining or splitting slide files; working with templates (.potx), layouts, speaker notes, or comments. Trigger whenever the user mentions \"deck,\" \"slides,\" \"presentation,\" or references a .pptx or .potx filename, regardless of what they plan to do with the content afterward. If a .pptx or .potx file needs to be opened, created, or touched, use this skill."
user-invocable: false
license: Proprietary. LICENSE.txt has complete terms
---

# PPTX creation, editing, and analysis

A `.pptx` is a ZIP archive of XML files. Choose your approach by task:

| Task | Approach |
|---|---|
| **Create** a new deck | Write a `pptxgenjs` script — see gotchas below. Never author in `python-pptx`: the idioms here are pptxgenjs, and transliterating them invents methods that do not exist (python-pptx has no `Slide.add_notes`; notes live at `slide.notes_slide.notes_text_frame.text`). python-pptx is for the read and validate scripts |
| **Edit** an existing deck, or build from a template | unzip → edit `ppt/slides/slideN.xml` → zip |
| **Read** content | `markitdown deck.pptx` (one block per slide under `<!-- Slide number: N -->` markers); visual grid: `python scripts/thumbnail.py deck.pptx`; build and check: `python scripts/check.py deck.pptx` |

## Where working files go

**A file written at the top of `/mnt/data` is delivered to the user. A file in any
subdirectory is not.** That is the whole rule: `/mnt/data/deck.pptx` is the deliverable,
`/mnt/data/qa/slide-1.jpg` is yours.

**One request, one file at the top level.** Fixing a defect means *replacing* the deck, not
writing a second one beside it:

```bash
rm -f /tmp/rebuilt.pptx && zip -Xrq /tmp/rebuilt.pptx .   # from INSIDE the unpacked tree
mv /tmp/rebuilt.pptx /mnt/data/deck.pptx
```

Zip from inside the directory with no exclusions. A package is mostly dot-files —
`_rels/.rels`, `ppt/_rels/presentation.xml.rels`, one per slide — and an exclude pattern like
`-x '.*'` silently drops every one of them. The result has no relationships at all: python-pptx
raises `no relationship of type '...officeDocument'`, LibreOffice says "source file could not
be loaded", and the deck is unopenable.

Never `deck_fixed.pptx`, `deck_v2.pptx`, `deck_final.pptx`. Each one is delivered, so a deck
corrected three times arrives as four decks and the user has to guess which is current.

Renders, intermediate PDFs, thumbnail grids, montages and cropped images go in a
subdirectory — use **`/mnt/data/qa/`** so there is one place to find and clear them. Those
survive between calls, so you can render on one call and read them back on the next, and the
user never sees them.

**An unpacked package is the exception: never leave one under `/mnt/data`.** Unzip, edit and
re-zip inside a SINGLE call, with the tree in `/tmp`. Only ordinary filenames survive a call
boundary: `.rels` parts are dropped because they begin with a dot, and `[Content_Types].xml`
comes back renamed to `_Content_Types_-<hash>.xml`. Re-zipping a tree that has crossed a call
therefore produces a package with no relationships and no content-types manifest — a deck that
cannot be opened, and several wasted turns discovering it.

Do not use a dot-prefixed directory. It is hidden from the user, but it is also wiped between
calls, so a render written to `.render/` cannot be read back at all.

## Scripts

This skill is mounted at **`/mnt/data/skills/pptx/`** — the script paths in the table below are
relative to it, so `scripts/check_layout.py` is run as
`python3 /mnt/data/skills/pptx/scripts/check_layout.py`. Do not guess another root: a wrong guess
costs a round trip per script. Everything else is plain Python, `node`, or shell.

| Script | What it does |
|---|---|
| `scripts/check.py deck.pptx [--build qa/build.js.txt] [--original src.pptx]` | **The QA step.** Builds, fixes content types, validates, runs the layout gate and placeholder scan, and draws the slide grid, in one call with one short report. |
| `scripts/thumbnail.py deck.pptx [prefix]` | Labeled contact sheet of every slide — the visual-QA grid, and how you pick template layouts. `.pptx` only. Writes to `/mnt/data/qa/thumbnails.jpg` and prints the path. Pass `prefix` when two decks are in flight at once, or the second overwrites the first's grid |
| `scripts/add_slide.py unpacked/ slide2.xml [--after slideN.xml]` | Duplicate a slide (or a `slideLayoutN.xml`) with all the package bookkeeping. Also takes a `.pptx` directly with `-o out.pptx` |
| `scripts/fix_content_types.py deck.pptx` | Removes `[Content_Types].xml` overrides naming parts the package does not contain. **Run on every pptxgenjs deck right after `writeFile()`** — pptxgenjs declares one slideMaster per *slide*, so an N-slide deck claims N masters and writes one. Idempotent |
| `scripts/clean.py unpacked/` | Delete slides, media, and rels no longer referenced. Run **after** `<p:sldIdLst>` is final |
| `scripts/office/validate.py deck.pptx [--original src.pptx]` | Schema, relationship, content-type, chart and slide checks; each failure names its fix. Pass `--original` for any template-derived deck — it baselines the schema checks against the template, so the template's own XSD errors don't read as yours |
| `scripts/office/soffice.py --headless --convert-to pdf deck.pptx` | LibreOffice wrapper — bare `soffice` hangs in this sandbox |
| `scripts/check_layout.py deck.pptx [--original src.pptx] [--slides 2,5] [--json]` | Slide size, overflowing text, text covered by a later shape, shapes off the canvas. Measured with the deck's own fonts; exits 2 on defects |

## Creating with pptxgenjs — gotchas

`pptxgenjs` is preinstalled — do not run `npm install` first; write the script and `require('pptxgenjs')` directly. Only if that require fails: `npm install pptxgenjs`. The model knows the API; these are the footguns:

- **Set `pres.layout` before adding slides.** The default canvas is `LAYOUT_16x9` = **10" × 5.625"**, not 13.3" wide. Coordinates past the edge are written, not clamped — the shape just isn't on the slide. Use `pres.layout = "LAYOUT_WIDE"` (13.333" × 7.5") unless the deck you are matching says otherwise.
- **Hex colors: never `#`, never 8 digits.** `color: "FF0000"`. Both `"#FF0000"` and alpha baked into the hex (`"00000020"`) **corrupt the file**. For translucency: `transparency: 0-100` on fills and images, `opacity: 0.0-1.0` on shadows — each is silently ignored on the other.
- **pptxgenjs mutates option objects in place** (converts values to EMU on first use). Never share one `shadow`/options object across two `add*` calls — build a fresh object each time.
- **Shadow `offset` must be ≥ 0** — a negative offset corrupts the file. To cast a shadow upward, use `angle: 270` with a positive offset.
- **`letterSpacing` is silently ignored** — the real option is `charSpacing`.
- **Lists:** `bullet: true` on each item, never a literal `•` (renders double bullets). Set `breakLine: true` on every array item except the last. Space bulleted paragraphs with `paraSpaceAfter`, not `lineSpacing` (huge gaps).
- **One `new pptxgen()` per output file** — never reuse an instance.
- **`rectRadius` only works on `ROUNDED_RECTANGLE`**, not `RECTANGLE`.
- **Gradient fills aren't supported** — use a gradient image as the background instead.
- **Text boxes have built-in internal padding** — set `margin: 0` whenever text must align with a shape, line, or icon at the same x.
- **Speaker notes go in `slide.addNotes("...")`** (plain text, once per slide), never in a text box on the slide.
- **Keep charts native.** Use `addChart()` for everything PowerPoint can chart (pass an array of `{type, data, options}` for combos). For PowerPoint-native features the library doesn't expose (trendlines, error bars), compute the extra series yourself or post-process the generated OOXML — do not fall back to a rendered image. Only chart types PowerPoint has no native form for (Sankey, network, chord) go in as images.
- **Default charts render bare** — no title, no data labels, dated palette. Set `showTitle` + `title`, `showValue: true` + `dataLabelPosition`, `chartColors: [...]` from your palette, and quiet the frame (`catAxisLabelColor`/`valAxisLabelColor`, `valGridLine: { color, size }`, `catGridLine: { style: "none" }`, `showLegend: false` for a single series).
- **On a stacked bar or column chart, `dataLabelPosition` must be `ctr`, `inEnd`, or `inBase`.** `outEnd` **corrupts the file**.
- **A combo series using `secondaryValAxis`/`secondaryCatAxis` needs both `valAxes` and `catAxes` on the chart options, two entries each.** Without them pptxgenjs writes axis *ids* it never declares, and PowerPoint **discards that chart** and reports the file as corrupt. Supplying only `valAxes` is not enough.
- **After `writeFile()`, run `python scripts/office/validate.py deck.pptx`.** It reports the two chart faults above and the slide-XML defects PowerPoint refuses, and names the fix for each. Fix them in your generator, not by hand-editing the packed XML.
- **Never reorder the children of `<p:presentation>`.** pptxgenjs writes `<p:notesMasterIdLst>` right after `<p:sldIdLst>` and points both masters at one theme part. PowerPoint reads that happily — move the element and the same deck becomes unopenable.
- **Icons:** render `react-icons` to SVG (`ReactDOMServer.renderToStaticMarkup`), rasterize with `sharp` at ≥256px, and insert via `addImage({ data: "image/png;base64," + buf.toString("base64") })` — the `image/png;base64,` prefix is required (`react-icons`, `react`, `react-dom`, and `sharp` are preinstalled — `npm install react-icons react react-dom sharp` only if a require fails).

## Slide size

**Every deck is 16:9 — 13.333" × 7.5" (`LAYOUT_WIDE`).** That is what projectors, laptops and
PowerPoint's own default expect; a 4:3 deck (10" × 7.5") shows as a narrow panel with black bars
either side, and is immediately visible as wrong.

- `python-pptx`'s default is **4:3**. Creating a `Presentation()` without setting the size gives
  you the wrong shape, so set both dimensions before adding any slide:

  ```python
  from pptx.util import Inches
  presentation.slide_width = Inches(13.333)
  presentation.slide_height = Inches(7.5)
  ```

- **Editing or redesigning: keep the source deck's dimensions,** whatever they are. Read
  `slide_width`/`slide_height` from the original and set the same values on the output. A deck
  rebuilt at a different size puts every carried-over position in the wrong place, even when the
  ratio still works out to 16:9 — 10" × 5.625" is 16:9 too, and half the width of a 13.333" deck.
- `check_layout.py` reports a deck whose slides are not 16:9, and reports a redesign whose
  canvas differs from the original when you pass `--original`.

## Editing, redesigning or using a template

When the task starts from a deck or template the user gave you, read `references/editing.md` (`read_file /mnt/data/skills/pptx/references/editing.md`) before changing anything, and pass `--original <their deck>` to `check.py`.

## Design Ideas

**Don't create boring slides.** Plain bullets on a white background won't impress anyone. Consider ideas from this list for each slide.

### Before Starting

- **Pick a bold, content-informed color palette**: The palette should feel designed for THIS topic. If swapping your colors into a completely different presentation would still "work," you haven't made specific enough choices.
- **Dominance over equality**: One color should dominate (60-70% visual weight), with 1-2 supporting tones and one sharp accent. Never give all colors equal weight.
- **Dark/light contrast**: Dark backgrounds for title + conclusion slides, light for content ("sandwich" structure). Or commit to dark throughout for a premium feel.
- **Commit to a visual motif**: Pick ONE distinctive element and repeat it — rounded image frames, icons in colored circles. Carry it across every slide. **Do not use a color bar or accent stripe as your motif** (see Avoid list).

### Color Palettes

Choose colors that match your topic — don't default to generic blue. Use these palettes as inspiration:

| Theme | Primary | Secondary | Accent |
|-------|---------|-----------|--------|
| **Midnight Executive** | `1E2761` (navy) | `CADCFC` (ice blue) | `FFFFFF` (white) |
| **Forest & Moss** | `2C5F2D` (forest) | `97BC62` (moss) | `F5F5F5` (cream) |
| **Coral Energy** | `F96167` (coral) | `F9E795` (gold) | `2F3C7E` (navy) |
| **Warm Terracotta** | `B85042` (terracotta) | `E7E8D1` (sand) | `A7BEAE` (sage) |
| **Ocean Gradient** | `065A82` (deep blue) | `1C7293` (teal) | `21295C` (midnight) |
| **Charcoal Minimal** | `36454F` (charcoal) | `F2F2F2` (off-white) | `212121` (black) |
| **Teal Trust** | `028090` (teal) | `00A896` (seafoam) | `02C39A` (mint) |
| **Berry & Cream** | `6D2E46` (berry) | `A26769` (dusty rose) | `ECE2D0` (cream) |
| **Sage Calm** | `84B59F` (sage) | `69A297` (eucalyptus) | `50808E` (slate) |
| **Cherry Bold** | `990011` (cherry) | `FCF6F5` (off-white) | `2F3C7E` (navy) |

### For Each Slide

**Every slide needs a visual element** — image, chart, icon, or shape. Text-only slides are forgettable.

**Layout options:**
- Two-column (text left, illustration on right)
- Icon + text rows (icon in colored circle, bold header, description below)
- 2x2 or 2x3 grid (image on one side, grid of content blocks on other)
- Half-bleed image (full left or right side) with content overlay

**Data display:**
- Large stat callouts (big numbers 60-72pt with small labels below)
- Comparison columns (before/after, pros/cons, side-by-side options)
- Timeline or process flow (numbered steps, arrows)

**Visual polish:**
- Icons in small colored circles next to section headers
- Italic accent text for key stats or taglines

### Typography

**Font names you write into the .pptx are rendered by the user's PowerPoint, not by this environment.** Your visual QA renders via LibreOffice, which substitutes fonts it doesn't have — and for some fonts the substitute has different widths, so your QA preview can show text overflow (or fit) that the real deck won't have. To keep your QA trustworthy:

- **Safe fonts** (render true-to-width in QA *and* ship with Office): **Arial, Calibri, Cambria, Times New Roman, Courier New, Bookman Old Style, Century Schoolbook**. Use these for body text and anything where fit matters.
- **Headers with personality at zero QA risk**: pair a safe-list serif header (Cambria, Bookman Old Style, Century Schoolbook) with a safe-list sans body (Calibri or Arial). You get visual contrast without giving up reliable overflow checks.
- **If the user asks for a font outside the safe list** (e.g. Georgia or Trebuchet MS): use it where the user asked, but size those containers with extra slack (~10%) and don't trust QA text-fit on those elements — the preview of that font is approximate. If the user hasn't specified, prefer safe-list fonts for body text.
- **QA-unreliable fonts** (substitute has different widths — overflow checks can be wrong): Georgia, Trebuchet MS, Impact, Arial Black, Garamond, Consolas, Palatino Linotype. Calibri Light substitution varies by environment; treat as QA-unreliable. Fine for titles/accents with slack; don't trust QA text-fit on these.
- **Never default to Aptos** — Office's post-2023 default has no metric-compatible substitute here *and* is missing from older Office installs, so it's unreliable on both ends.

| Element | Size |
|---------|------|
| Slide title | 36-44pt bold |
| Section header | 20-24pt bold |
| Body text | 14-16pt |
| Captions | 10-12pt muted |

### Spacing

- 0.5" minimum margins
- 0.3-0.5" between content blocks
- Leave breathing room—don't fill every inch

### Avoid (Common Mistakes)

- **Don't repeat the same layout** — vary columns, cards, and callouts across slides
- **Don't center body text** — left-align paragraphs and lists; center only titles
- **Don't skimp on size contrast** — titles need 36pt+ to stand out from 14-16pt body
- **Don't default to blue** — pick colors that reflect the specific topic
- **Don't mix spacing randomly** — choose 0.3" or 0.5" gaps and use consistently
- **Don't style one slide and leave the rest plain** — commit fully or keep it simple throughout
- **Don't create text-only slides** — add images, icons, charts, or visual elements; avoid plain title + bullets
- **Don't forget text box padding** — when aligning lines or shapes with text edges, set `margin: 0` on the text box or offset the shape to account for padding
- **Don't use low-contrast elements** — icons AND text need strong contrast against the background; avoid light text on light backgrounds or dark text on dark backgrounds
- **NEVER use accent lines under titles** — these are a hallmark of AI-generated slides; use whitespace or background color instead
- **NEVER add decorative color bars or accent stripes** — this includes: header/footer bars spanning the slide width, vertical sidebar stripes down one edge of the slide, thin accent stripes along one edge of a card or content block, and "single-side borders" on rectangles. These read as AI-generated filler. If you want to set a card apart, use a subtle background tint, a drop shadow, or an icon — not an edge stripe.
- **Don't default to cream/beige backgrounds** — when no background is specified, use white (`FFFFFF`) or the user's brand palette; avoid warm-neutral defaults like `F5F5DC`, `FAF0E6`, `FAEBD7`, `FFF8E1`
- **Don't ship text that overflows its shape** — if text doesn't fit, reduce font size, split across slides, or enlarge the container; never leave content cut off or spilling past bounds

## QA (Required)

One command builds the deck and runs every check:

```bash
python3 /mnt/data/skills/pptx/scripts/check.py /mnt/data/<deck>.pptx --build /mnt/data/qa/build.js.txt
# for an edit or a template: add --original /mnt/data/<their deck>.pptx and drop --build
```

It runs the generator, `fix_content_types.py`, `validate.py`, the layout gate (`check_layout.py`), a scan for leftover placeholder text, and draws one labelled grid of every slide. The report ends with the grid's path. Exit 0 means every check passed; 2 means something to fix, named by slide and shape.

1. **Read the report, then read the grid image once.** One image shows every slide. Do not render or read slides one by one: several slide images in one turn are dropped before they reach you.
2. **List every defect before changing anything:** what the report names, plus what the grid shows (text running out of a box or off the slide, overlapping shapes, low contrast, uneven gaps, cramped margins, leftover placeholder text).
3. **Fix them all in one `edit_file` call** on the generator, then rerun the same `check.py` line. Never patch the generator with `sed` or a Python replace.
4. **Two rounds at most.** Every call spends part of a fixed step budget, and a run that reaches it delivers nothing. Layout-gate defects must be fixed; if only minor visual polish remains, deliver and mention it.

Do not deliver while the layout gate reports defects: a defect it reports is real even if the render looks fine, because the renderer may draw a narrower font than PowerPoint. If a check cannot run, say so rather than implying the deck was verified. `references/qa.md` explains each check in detail.

## Dependencies

`pptxgenjs` (npm, preinstalled — install only if `require('pptxgenjs')` fails) · `markitdown[pptx]`, `Pillow`, `python-pptx`, `defusedxml`, `lxml` (pip — text dump, thumbnail, clean, validate, layout check) · `fontconfig` (`fc-match`, so the layout check measures with the deck's real fonts) · LibreOffice (`soffice`, auto-configured for sandboxed environments via `scripts/office/soffice.py`) · `pdftoppm` (Poppler)
