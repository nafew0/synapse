# Charts

Read this before adding or changing a chart.

Build charts with `openpyxl.chart` in the same script that writes the data, from `Reference`
ranges on the sheet, never from Python lists. A chart that points at cells updates when the
cells do; one built from literals is a picture.

**Every chart setting you care about must be stated explicitly, because `recalc.py` rewrites
the chart.** Recalculation opens the workbook in LibreOffice and saves it back, and LibreOffice
re-serialises every chart with *its own* default for anything openpyxl left out. The costly case
is data labels: openpyxl writes only the flags you set, and LibreOffice treats a missing
`showCatName`, `showSerName` or `showLegendKey` as **on**. A chart that asked for value labels
comes back with every bar labelled `■ Score; Bangabandhu Sheikh Mujibur Rahman Agricultural
University; 100.00` — ten of those on a ten-bar chart pile on top of each other and read as
overlapping legends. Set all four, every time:

```python
from openpyxl.chart import BarChart, Reference
from openpyxl.chart.label import DataLabelList

ch = BarChart(); ch.type = "bar"; ch.title = "Top 10 Universities by APA Score"
ch.add_data(Reference(ws, min_col=2, min_row=1, max_row=11), titles_from_data=True)
ch.set_categories(Reference(ws, min_col=1, min_row=2, max_row=11))
ch.dataLabels = DataLabelList()
ch.dataLabels.showVal = True
ch.dataLabels.showCatName = False     # the axis already names the category
ch.dataLabels.showSerName = False
ch.dataLabels.showLegendKey = False
ch.dataLabels.showPercent = False
ch.legend = None                      # one series: a legend adds nothing
ch.height = 0.5 * 10 + 3              # cm — see sizing below
ch.width = 22
ws.add_chart(ch, "D2")
```

Explicit `False` values survive the round-trip; omitted ones do not. Verified on
openpyxl 3.1.5 through LibreOffice.

- **Never label a bar with its category name when the category axis already shows it.** The
  name is beside the bar; repeating it at the bar end doubles the text and is what collides.
- **Legend:** a single-series chart gets `ch.legend = None`. With several series, keep it and
  place it with `ch.legend.position = "b"` (or `"r"`); the position survives recalculation.
- **Size the chart to its bars, not the default.** A horizontal bar chart needs about **0.5 cm
  of height per category plus 3 cm** for title and axis; ten long university names in the
  default 7.5 cm is exactly where labels overlap. Set `ch.height` / `ch.width` in cm before
  `add_chart`. For long category names prefer `type = "bar"` (horizontal) over `"col"`: the
  names lie flat instead of wrapping under the axis.
- **`dataLabels.numFmt` does not survive recalculation.** Round or format the source cells
  instead; labels show what the cell shows.
- **A chart survives a later `load_workbook` + `save` in openpyxl 3.1** (checked), so a
  workbook with charts can be reopened to edit cells. Images and shapes do not survive that;
  see the structure gate above.

**Look at the chart before delivering it.** A clean `recalc.py` says nothing about a chart —
it only evaluates formulas. Render and read the page, in a subdirectory so nothing extra is
delivered:

```bash
mkdir -p /mnt/data/qa && \
python3 /mnt/data/skills/xlsx/scripts/office/soffice.py --headless --convert-to pdf --outdir /mnt/data/qa /mnt/data/output.xlsx && \
pdftoppm -png -r 110 /mnt/data/qa/output.pdf /mnt/data/qa/page && \
ls /mnt/data/qa/page-*.png   # then Read the page that holds the chart
```

If labels touch each other, either the chart is too small for its categories or a label flag
is on that should not be. Fix the script and rebuild; do not hand-edit the chart XML.
