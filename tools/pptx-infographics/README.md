# Infographic packs: index, render, sort

Turns the purchased infographic packs into a catalogue where every slide has a confirmed kind
(cycle, funnel, timeline…) and item count. That catalogue is the input for choosing and
preparing the library `deck.py` will use (`docs/pptx-infographics-plan.md`, phases I-1 and I-2).
The packs themselves stay where they are and are only read.

Everything these tools write goes to one output folder, `$OUT` below. We keep it in the main
checkout at `docs/infographics/`. A `.gitignore` inside that folder keeps all of it out of git,
since it holds thumbnails of purchased packs:

```bash
OUT="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/docs/infographics"
mkdir -p "$OUT" && printf '*\n' > "$OUT/.gitignore"
```

## 1. Index (20 seconds)

```bash
uv run --no-project --python 3.12 --with lxml python -I index.py \
  --pack A="$HOME/Downloads/Compressed/01-MASSIVE-Powerpoint-Infographics" \
  --pack B="$HOME/Downloads/Compressed/5000+ Infographics" --out "$OUT"
```

This writes:
- `$OUT/catalogue.jsonl`: one line per slide, with its source deck and slide number, text boxes
  (text, position, size), shape counts, item count and a first guess at its kind.
- `$OUT/decks.json`: the deck list that `render.py` reads.

Where the guess comes from:
- **The folder or deck name**, when it names a kind (`Funnel`, `SWOT`, `Asia Map`). Those
  names are listed in `kinds.py`. This guess is reliable.
- **Otherwise, the slide's structure.** This guess is weak: it agreed with the folder name only
  about a third of the time. The sorter shows it as a hint and never pre-selects it.

The `Arrows Small Size` deck is skipped: it repeats `Arrows` at a smaller size.

## 2. Render thumbnails (about an hour)

```bash
A="$HOME/Downloads/Compressed/01-MASSIVE-Powerpoint-Infographics"; B="$HOME/Downloads/Compressed/5000+ Infographics"
docker run --rm --network none -v "$A":"$A":ro -v "$B":"$B":ro -v "$PWD":/t:ro -v "$OUT":/o \
  --entrypoint python3 bangla-skill-test:latest -I /t/render.py /o > "$OUT/render.log" 2>&1
```

It writes `$OUT/thumbs/<deck>/<NNN>.png`, 640 px wide.
- **Image:** any image with LibreOffice and Poppler works.
- **Mounts:** the packs are mounted read-only, at the same paths they have on this Mac.
- **Network:** none.
- **Parallel runs:** four LibreOffice processes, each with its own profile. Two processes
  sharing a profile fail, so profiles are handed out one per running conversion.
- **Rerunning:** decks already rendered are skipped. `grep FAILED "$OUT/render.log"` lists decks to
  retry.

## 3. Sort (a few hours, in as many sittings as you like)

```bash
python3 sort.py "$OUT"          # then open http://localhost:8765
```

The sidebar lists every deck with its progress and its folder kind (or "mixed"). Pick a deck
and work through its grid:

| Key | Does |
|---|---|
| letter (shown at the bottom) | set the focused slide's kind and move on |
| `1`–`9` | set the item count, before or after the kind |
| `Enter` | accept the folder's kind for this slide |
| `Shift`+`Enter` | accept the folder's kind for every unsorted slide in the deck |
| `x` | skip: not useful |
| `Space` | enlarge the slide |
| arrows | move |
| `]` | next unfinished deck |

**Fastest route:**
1. **Decks whose folder names a kind:** glance at the grid, fix the odd ones out, then press
   `Shift`+`Enter`.
2. **"Mixed" decks:** go slide by slide.

**Saving and exporting:**
- Each choice is saved at once to `$OUT/labels.jsonl`; a later choice for the same slide wins.
- **Export**, or `python3 sort.py "$OUT" --export`, writes two things:
  - `$OUT/catalogue-labelled.jsonl`, the input for choosing designs
  - `$OUT/sorted/<kind>/<N items>/`, one thumbnail per sorted slide, to browse in Finder.
    Slides without an item count go in `other/`. Each export rebuilds these folders from
    scratch, so a relabelled slide moves. The thumbnails are hard links, so the folders take no
    extra space.

The kinds and their keys live in `kinds.py`. Change them there before sorting starts: renaming
a kind after slides carry it means relabelling those slides.
