# PPTX infographics: plan to turn the purchased packs into a slide library

Branch: `feature/pptx-v1`. Builds on `deck.py` and the themes (`docs/pptx-themes-plan.md`).
The packs are licensed (purchased); keep the licence and receipt with the source files and name
them in `skill/pptx/themes/NOTICE.md`.

## What we have

| | Pack A: `01-MASSIVE-Powerpoint-Infographics` | Pack B: `5000+ Infographics` |
|---|---|---|
| Decks / slides | 170 decks, 3,975 slides | 30 decks, 2,013 slides |
| Size | 26.67 × 15 in (2× ours) | 26.67 × 15 in (one deck 10 × 5.63) |
| Build | ~259k native shapes, 90 pictures | ~186k native shapes, 535 pictures |
| Colour | 62% theme slots: recolours with a theme | 76% fixed hex: needs mapping to slots |
| Fonts | Montserrat, Poppins, Raleway, Arial | Calibri, Arial, Montserrat Light, Open Sans |
| Placeholder text | "Title 01", "Make a big impact…" | "Lorem ipsum", "Title here" |
| Quality | consistent, modern, flat | mixed: strong maps, cycles, arrows and flat people; some dated 3D and clip-art |
| Strongest material | timelines, SWOT, puzzles, frameworks, concentric circles, data panels, Gantt, 30-60-90, funnels, roadmaps, maps of every continent | editable country maps (South Asia with Bangladesh, India, Nepal, Pakistan), cycle diagrams (122 slides), arrows (238), education, medical, people illustrations |

Both are vector shapes, not pictures, so every piece can be resized, recoloured and edited by
the user in PowerPoint. That is what makes them usable inside generated decks.

## How it plugs into deck.py

The model keeps writing content only. A new block names the **kind** of graphic and its items;
`deck.py` chooses a matching part from the library, copies it into the layout's content area,
fills the text, and recolours it through the theme:

```json
{"layout": "content", "title": "Admissions run as a four-stage cycle",
 "infographic": {"kind": "cycle", "items": [["Plan", "Set intake targets"], ["Promote", "School visits"],
                                            ["Admit", "Merit list in May"], ["Review", "Compare with target"]]}}
```

Kinds (first set, from what the packs cover best): `process`, `cycle`, `timeline`, `roadmap`,
`funnel`, `pyramid`, `matrix` (2×2, SWOT), `comparison`, `hub` (centre and spokes),
`concentric`, `puzzle`, `kpi` (figures with icons or rings), `gantt`, `agenda`, `map`.

Plus two supporting libraries harvested from the same packs:
- **Icons:** small vector groups (several thousand in the packs) tagged by meaning, so cards,
  steps, stats and infographic items get a fitting icon: `"icon": "money"`.
- **Illustrations:** flat people and objects (Pack B education, medical, business), for cover,
  section and picture areas: `"illustration": "teacher"`.

## Phase I-0: themes ready for recolouring (1 day)

Found while checking: all five themes still carry LibreOffice's default colour slots
(accent1 `18a303` green, accent2 `0369a3` blue…), not their own palettes. Anything coloured by
slot, including inserted infographics and shapes a user adds in PowerPoint, would come out in
those defaults.

1. `tools/pptx-themes/clean.py` writes each theme's `colors` (primary, accent, chart list, ink)
   into `<a:clrScheme>` as accent1–6, dk1/dk2 and lt1/lt2.
2. Test: each theme's slots equal its JSON colours.

## Phase I-1: index every slide (2 days)

`tools/pptx-infographics/index.py <pack>` writes `catalogue.jsonl`, one line per slide (~6,000):
- source deck and slide number, so every part can be traced back to its purchase
- shape, group, picture and text-box counts
- the text slots in reading order, with their boxes and font sizes
- the palette: slot colours versus fixed hex
- fonts
- a 400 px thumbnail, rendered with LibreOffice in the `bangla-skill-test` image with no network

Contact sheets per source deck go to `tools/pptx-infographics/out/`.

## Phase I-2: classify and choose (3 days)

1. **Automatic first pass:** a vision model reads each thumbnail and returns:
   - its kind, from the list above
   - its item count
   - a quality score from 1 to 5
   - whether it looks dated (3D, clip-art, heavy shadows)
   - whether it contains a title area to remove

   Use a small model through OpenRouter, as the eval judge does. 6,000 images costs about
   $10–20 (estimate). Folder names and numbered slots ("01"…"05") check the count.
2. **Human pass:** one contact sheet per kind, best first. You or a designer pick the keepers.
3. Target: about 200 parts, which is 3–6 good variants for each kind and item count
   (3, 4, 5, 6 items). Keep every map of South Asia and Bangladesh's neighbours, and the
   world and continent maps.

**Done when:** `parts.yaml` lists each chosen slide with its kind, count and source.

## Phase I-3: normalise each part (5 days, the main work)

`tools/pptx-infographics/build.py` turns `parts.yaml` into a library. For each part, it:

1. **Lifts the graphic out of its slide.** It deletes the slide's own title and subtitle, keeps
   the graphic with its text slots, and records the bounding box and aspect ratio.
2. **Scales it by 0.5** to our 13.333 × 7.5 size, text sizes and line widths included, the same
   way `clean.py` already scales themes.
3. **Maps colours to slots.** Fixed hex colours become theme slots: cluster the part's
   colours, give the most-used saturated ones accent1–6 in order, and turn greys into
   text/background tints. Pack A is mostly done already; Pack B needs this.
4. **Names the slots.** It groups text boxes into items by position and numbering, then names
   them `item1.head`, `item1.body`, `item1.value`… and `center` for hubs. For each slot it
   records the box and how much it holds, in English and in Bangla, measured with
   `check_layout`'s fonts.
5. **Sets fonts.** Every run gets the theme's Latin font and Nikosh as its Bangla font.
6. **Checks the result.** It fills the part with sample English and Bangla text in two themes,
   renders it, and runs `check_layout`. Parts that fail go to a review list, not the library.
7. **Writes the library:**
   - one `.pptx` per kind in `skill/pptx/infographics/`, one slide per part
   - `manifest.json` with id, kind, count range, slots, capacity, aspect ratio and tags
   - a preview contact sheet per kind

Icons and illustrations go through steps 2, 3 and 5 into `skill/pptx/icons/` and
`skill/pptx/illustrations/`, each with a tagged manifest. Tags start with the pack's own shape
names and slide text. A vision pass then fills the gaps, and a human checks the top 300 icons.

**Size:** stay under 10 MB per file, which is the deployment limit, and about 30 MB in all.
Strip unused layouts and media from every library file. Measure this before going wider:
skill files upload to each tenant's sandbox once.

## Phase I-4: deck.py blocks (4 days)

1. **`infographic`:**
   - **Choosing a part:** pick parts of the requested kind and item count whose aspect ratio
     suits the layout's content area. Prefer one not yet used in this deck, and break ties by a
     seed from the deck title, so a rebuild looks the same.
   - **Placing it:** copy its shapes, relationships and any media into the slide. Scale it into
     the area and centre it.
   - **Filling it:** write each item's text with explicit size, colour and fonts, fitted down to
     a minimum size. If the text still does not fit, try the next part. If none fits, report the
     problem as `deck.py` does today (`slide 5: no cycle fits 4 items of this length: shorten
     the details`).
   - **Leftovers:** delete unused slots.
2. **`icon`** on cards, steps, stats and timeline items. **`illustration`** on cover, section,
   closing and layouts with a picture area. Both draw from the tagged manifests and are
   recoloured by the theme.
3. **`map`:** `{"region": "south_asia", "highlight": {"Bangladesh": "Pilot sites"}}`. It
   colours the named countries with the accent and adds labels. This needs country shapes to be
   named, which Phase I-3 does for the maps we keep. Bangladesh's divisions and districts are
   not in either pack; that map would have to be drawn or bought separately.
4. `--list` gains `--infographics`: kinds, item ranges and a preview path per kind.

## Phase I-5: skill and QA (2 days)

1. **SKILL.md:**
   - a table of kinds with "use when" and item counts
   - the rule that a deck uses one infographic every two or three content slides, chosen by the
     relationship (order → `process` or `timeline`, a loop → `cycle`, stages that narrow →
     `funnel`)
   - icons on cards and steps by default
2. **Tests:** every kind builds with its smallest and largest item count, in English and Bangla,
   on all five themes, clean under `check_layout`. Recolouring follows the theme. The same spec
   picks the same parts.
3. A sample deck of every kind, saved to `docs/slide-templates/samples/` for review.

## Phase I-6: more themes from the packs (optional, 3 days)

Pack B's `Minimal`, `Black`, `Brush` and `Banners` decks, and Pack A's `Title` and `Summary`
folders, contain cover, section and background designs. Turning the best of them into masters
with the canonical layout names adds themes that match the infographics' style.

## Phase I-7: measure

Run the themes plan's Phase 8 eval with three variants:
- the current skill
- themes only
- themes with infographics and icons

Add a case that asks for a process and a timeline, where infographics should matter most. Keep
infographics only if they raise the judge score without costing extra fix rounds.

## Order and effort

| Phase | Depends on | Effort |
|---|---|---|
| I-0 theme colour slots | none | 1 day |
| I-1 index | none | 2 days |
| I-2 classify and choose | I-1 | 3 days, plus your review time |
| I-3 normalise | I-0, I-2 | 5 days |
| I-4 deck.py blocks | I-3; canonical layout names (themes plan Phase 2) | 4 days |
| I-5 skill and QA | I-4 | 2 days |
| I-6 themes from packs | I-1 | 3 days, optional |
| I-7 measure | I-5 | with themes plan Phase 8 |

About three and a half weeks. This replaces the themes plan's Phase 5 ("more blocks"), because
the library covers timeline, comparison and matrix with better drawings, and shrinks its Phase 7
("generated shapes") to the `Brand` theme only. Start with I-0 and I-1 now: they need no
decisions.
