# Theme masters for deck.py

Rebuilds `skill/pptx/themes/<Name>.pptx` from the LibreOffice Impress templates in `sources/`.
The theme's JSON in `skill/pptx/themes/` supplies the colours; `config.json` says which layouts
to keep, their names and any placeholder boxes to move.

```bash
docker run --rm --network none -v "$PWD":/r -w /r --entrypoint sh bangla-skill-test:latest -c \
  'for n in Candy Growing_Liberty Freshes Yellow_Idea Grey_Elegant; do
     python3 -I tools/pptx-themes/clean.py tools/pptx-themes/sources/$n.pptx tools/pptx-themes/config.json \
       skill/pptx/themes/$n.pptx skill/pptx/themes; done'
```

Run it from the repository root. Any image with python-pptx works.

## Checking a theme

`layouts.py theme.pptx sheet.pptx` writes one slide per layout, with each placeholder labelled
by its name and index. It includes Bangla text, so the Nikosh font shows up too. Render the
sheet and look at every layout before using a theme.

## Where the sources come from

`sources/` holds five of the presentation templates that ship with LibreOffice
(`extras/source/templates/presnt` in https://github.com/LibreOffice/core). Each one was
packed into an `.otp` file and converted with `soffice --convert-to pptx`. Licence and authors
are in `skill/pptx/themes/NOTICE.md`.

Exported templates need cleaning before python-pptx can fill them, and the reasons are not
obvious. See `kb/gotchas/libreoffice-template-export-traps.md`.
