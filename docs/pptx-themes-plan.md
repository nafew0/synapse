# PPTX themes: plan for the remaining work

Branch: `feature/pptx-v1` (cut from `bdren-prod`; worktree `.claude/worktrees/pptx-themes`). The first themes commit was made on `feature/pptx-themes`, cut from `feature/hybrid-ocr`, and carried over.
Built so far (`8b2536797`): `skill/pptx/scripts/deck.py`, five themes in `skill/pptx/themes/`,
SKILL.md making a themed deck the default, 6 tests. Decision record:
`kb/decisions/pptx-themed-decks-deck-py.md`; LibreOffice traps:
`kb/gotchas/libreoffice-template-export-traps.md`.

Rules that hold for every phase:
- Anything that must happen goes in SKILL.md or a script, not an optional reference
  (`kb/decisions/pptx-storytelling-from-agent-slides.md`).
- The deck path stays within the step budget: one build call, at most two fix rounds
  (`kb/issues/office-graph-recursion-limit.md`).
- Spec and QA files go in `/mnt/data/qa/`, the deck at the top of `/mnt/data`
  (`kb/gotchas/sandbox-output-dirs.md`).
- Every run's size, colour, font and bullets are written explicitly: LibreOffice ignores layout styles.
- Tests run from `tests/skill/pptx/` with
  `uv run --no-project --python 3.12 --with python-pptx --with pillow --with pytest pytest -q tests/skill/pptx`,
  and again in the `bangla-skill-test` image, which has real fonts and Nikosh.

## Phase 0: bring the tools onto the branch (half a day)

The tools that made the themes and the earlier storytelling work exist only as untracked
files in the main checkout.

1. Move `docs/slide-templates/tools/{clean.py,config.json,layouts.py}` to
   `tools/pptx-themes/` on this branch, with a short README: where the LibreOffice sources come
   from, the one command that rebuilds all five themes, and how to check a theme
   (`layouts.py` sheet).
2. Decide about the storytelling port (`references/storytelling.md`, `references/patterns.md`,
   `scripts/check_story.py`, `tests/skill/pptx/test_check_story.py`). It measured well
   (sentence titles, 0 of 4 unsourced charts against 4 of 4), but its SKILL.md section and the
   `check.py` hook were removed at some point. Ask who removed them and why. If no one knows,
   restore them in Phase 3, where they fit the themed path.

**Done when:** `python3 tools/pptx-themes/clean.py` rebuilds byte-identical themes from the
LibreOffice sources, and the storytelling question has an answer.

## Phase 1: confirm the licence (1 day, mostly waiting)

1. For each of the five templates, read its commit in LibreOffice core
   (`git log --follow extras/source/templates/presnt/<Name>`): the commit message and linked
   bug usually state the licence (CC0 from the 2015 Design Team call, or MPL-2.0).
2. If any is unclear, ask the LibreOffice design team (design@global.libreoffice.org).
3. Record the result per theme in `skill/pptx/themes/NOTICE.md` and in the KB decision. Drop
   any theme that stays unclear.

**Done when:** every shipped theme has a named licence with a link to its source commit.
**Gate:** no merge to `bdren-prod` before this phase is done.

## Phase 2: one layout vocabulary for every theme (2 days)

Today each theme names its layouts its own way (`feature`, `chart`, `content_band`…), so a
spec written for one theme fails on another.

1. Fix a canonical set:
   `cover`, `section`, `closing`, `agenda`, `content`, `content_dark`, `wide` (full-width body
   for charts and tables), `picture` (picture area beside text), `quote`, `columns` (fixed
   2–4 columns).
2. Add `"aliases"` to each theme's JSON, mapping canonical names to its layouts, plus extra
   theme-only layouts the model may use by name. A canonical name a theme lacks maps to its
   nearest layout (`quote` → `content` and so on), so every canonical name works everywhere.
3. `deck.py`: resolve the alias first; `--list` shows canonical names first.
4. SKILL.md: the spec example and the block table use canonical names only.
5. Test: one spec using all ten canonical names builds on all five themes, cleanly under
   `check_layout`.

**Done when:** changing `"theme"` is the only edit needed to move a deck to another theme.

## Phase 3: deck-writing rules back on the themed path (1 day)

1. Restore the short "Plan the deck first" section to SKILL.md, rewritten for the spec:
   - sentence titles for decision and report decks
   - one message per slide
   - a block chosen by the relationship (peers → cards, order → steps, a figure → stats)
   - a `source` on every chart, table and stat
2. Run `check_story.py` from `check.py` again, so `deck.py` reports `story:` lines. They stay
   suggestions and never cost a round.
3. `references/storytelling.md` stays optional; `references/patterns.md` now covers the
   pptxgenjs path only, and says so.

**Done when:** the sample decks report `story: ok` except the legitimate short titles, and the
story tests pass.

## Phase 4: fonts and contrast (2 days)

1. **Font:** the themes use Noto Sans, which Windows PowerPoint lacks, so users would see a
   substitute. Switch every theme's Latin font to Calibri in `clean.py`. The sandbox has
   Carlito, which has the same widths, so fit measurement stays exact. Re-render all five themes
   and fix any layout box that the wider glyphs break.
2. **Contrast:** add a `"bg"` colour per layout to each theme JSON (sampled once from the
   render). Have `deck.py` refuse a text colour below 4.5:1 against it, and pick white or ink
   automatically for drawn text, so a wrong `"dark"` flag cannot ship unreadable text.
3. Tests: the contrast choice for light and dark layouts; Calibri is written on every run.

**Done when:** all sample decks pass, and opening one in PowerPoint on Windows shows no font
substitution.

## Phase 5: more blocks (replaced by the infographics plan)

Superseded by `docs/pptx-infographics-plan.md`: the purchased infographic packs give timeline,
comparison, matrix and many more kinds with better drawings than we would draw ourselves. The
table below is kept as the minimum set the library must cover.

The pptxgenjs patterns that themed decks still cannot make:

| Block | Spec | Drawing |
|---|---|---|
| `timeline` | `[["2025", "What happened"], ...]` 3–6 | line with dots, labels alternating above and below |
| `compare` | `{"left": {"title", "points"}, "right": {...}}` | two columns, a divider, optional verdict band |
| `matrix` | `{"axes": ["Effort", "Impact"], "cells": [[h, d] x4]}` | 2×2 cards with axis labels |
| `kpis` with chart | `stats` above a `chart` in one slide | the only allowed two-block pair |

Each block gets its own fit rules, error messages and a test, and a line in the SKILL.md block
table.

**Done when:** a 12-slide spec using every block builds clean on all five themes.

## Phase 6: institution branding (2–3 days)

1. Spec gains an optional `"brand": {"logo": "/mnt/data/logo.png", "primary": "0B5394"}`.
2. Each theme JSON names a logo box on `cover` and `closing` (and optionally a small one on
   content layouts). `deck.py` places the logo there, scaled to fit.
3. `primary` replaces the theme's primary and emphasis colours in everything `deck.py` draws:
   cards, steps, chart highlight, table header, takeaway band. The master's decoration keeps its
   colours. Check contrast as in Phase 4.
4. SKILL.md: use `brand` when the user names their institution and gives or attaches a logo.
   Never invent a logo.
5. Later, outside this branch: read the logo and colour from the tenant's settings so users do
   not have to attach them.

**Done when:** a deck with a sample logo and colour builds on all five themes, with the logo
inside its box and text contrast intact.

## Phase 7: generated shapes (3–4 days)

A sixth theme, `Brand`, for decks whose look must follow an institution's own colours, built
from generated shapes instead of a template.

1. `scripts/shapes.py`: smooth blobs (closed Bézier through jittered points), waves (sine
   ribbons), dot grids, arcs, and corner sweeps, written as native `custGeom` with `gradFill`.
   Seeded from the deck title, so a rebuild looks the same.
2. A plain master (white and one dark variant) carrying the canonical layouts, built by
   `tools/pptx-themes/` like the others.
3. `deck.py`: on `Brand`, add 1–2 shapes per slide in safe zones (corners and edges, never under
   the title or body box), coloured from `brand.primary` and its tints.
4. Tests: shapes stay inside their zones, `check_layout` finds no covered text, and the same
   seed gives the same XML.

**Done when:** a `Brand` deck in a sample institution colour looks designed, not generated, by
the same review we used for the five themes.

## Phase 8: measure (2 days)

1. Install LibreOffice in the eval runner (local or in the `feature/office-eval` harness), so
   the judge sees rendered slides rather than structure only.
2. Cases (in `evals/office/cases/`):
   - `deck-decision` and `deck-bangla` (existing)
   - a teaching deck
   - a data report with a table and chart
   - a deck with a user-attached logo
3. Variants: the current skill on `bdren-prod` against this branch, 3 repeats each.
4. Compare:
   - judge score
   - checks passed on first build
   - fix rounds used
   - time
   - cost per run
   - how often the model falls back to pptxgenjs
5. Record the result in the KB decision. If themed decks do not win on judge score at similar
   cost, keep pptxgenjs as the default and offer themes on request.

**Done when:** the report is saved and the decision entry says which path is the default and why.

## Phase 9: merge and deploy

1. `feature/hybrid-ocr` must reach `bdren-prod` first: this branch is cut from it.
2. Rebase or merge `bdren-prod` into this branch, rerun all tests and one eval case.
3. Open the PR; after merge, deploy, then confirm the skill files reached the sandbox: the
   themes are binary, about 2.6 MB, uploaded once per tenant.
4. Update `BRANCHES.md`, the KB decision (status `fixed`), and the feature entry.

## Order and effort

| Phase | Depends on | Effort |
|---|---|---|
| 0 tools and storytelling decision | none | 0.5 day |
| 1 licence | none (start now, it waits on others) | 1 day |
| 2 layout vocabulary | 0 | 2 days |
| 3 deck-writing rules | 0, 2 | 1 day |
| 4 fonts and contrast | 0 | 2 days |
| 5 more blocks | 2 | 2–3 days |
| 6 branding | 2, 4 | 2–3 days |
| 7 generated shapes | 2, 4, 6 | 3–4 days |
| 8 measure | 2–4 at least; ideally all | 2 days |
| 9 merge | 1, 8 | 0.5 day |

About three weeks of work in all. The first eval (Phase 8) can run after Phase 4, so that a poor
result can still change the course before branding and shapes are built.
