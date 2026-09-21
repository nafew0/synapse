---
name: xlsx
description: "Use this skill any time a spreadsheet file is the primary input or output. This means any task where the user wants to: open, read, edit, or fix an existing .xlsx, .xlsm, .xltx, .csv, or .tsv file (e.g., adding columns, computing formulas, formatting, charting, cleaning messy data); create a new spreadsheet from scratch or from other data sources; or convert between tabular file formats. Trigger especially when the user references a spreadsheet file by name or path — even casually (like \"the xlsx in my downloads\") — and wants something done to it or produced from it. Also trigger for cleaning or restructuring messy tabular data files (malformed rows, misplaced headers, junk data) into proper spreadsheets. The deliverable must be a spreadsheet file. Do NOT trigger when the primary deliverable is a Word document, HTML report, standalone Python script, database pipeline, or Google Sheets API integration, even if tabular data is involved."
user-invocable: false
license: Proprietary. LICENSE.txt has complete terms
---

# XLSX creation, editing, and analysis

| Task | Approach |
|---|---|
| **Create** or **edit** with formulas/formatting | `openpyxl` — see gotchas below |
| **Bulk data** in or out | `pandas` (`read_excel`, `to_excel`) |
| **Quick look** at a sheet | `markitdown file.xlsx` — `## SheetName` per sheet; reads `.xlsm` too. No cell coordinates, so don't plan edits from it |
| **Read** a model (formulas *and* values) | two `load_workbook` passes — see gotchas |

> `openpyxl`, `pandas`, and `markitdown` are preinstalled — do not run `pip install` first; write the script and import directly. Only if an import fails (or the `markitdown` command is missing): `pip install` the missing package.

> Script paths below are relative to this skill's directory.

## Requirements for every output

- **Professional font** (Arial, Times New Roman) throughout, unless the user says otherwise.
- **Zero formula errors.** Never ship while `recalc.py` reports `errors_found`. If you think an error predates you, prove it: load the *original* with `data_only=True` and look at that cell. An error you introduced looks exactly like one you inherited.
- **Use formulas, never hardcoded results.** Write `sheet['B10'] = '=SUM(B2:B9)'`, not the Python-computed total. The sheet must recalculate when its inputs change.
- **Follow the user's spec literally.** Exact tab names, exact column headers, and the formula they spelled out. A redesign that computes something else fails, however elegant.
- **Document every assumption and hardcoded number** where the reader will see it — a cell comment, or an adjacent cell at a table's end. Cite a real source when one exists (`Source: Company 10-K, FY2024, Page 45, Revenue Note, [SEC EDGAR URL]`); when the number came from the user, say so plainly.
- **A workbook *you create* for someone to fill in** needs a short legend naming which cells to edit, and one example row of realistic values showing the expected format. Never add such a row to a file you were asked to edit.
- **Editing an existing file: match its conventions exactly.** They override every guideline here. Find its designated input cells first — a distinct font color, fill, or shading marks them — write only there, and leave every existing formula untouched. Follow **Editing a user's workbook** below, and never deliver an edit that has not passed the structure preservation gate.
- **A tab modeled on the user's sheet is an edit, not a new workbook.** "Make a similar one", "same format as", or "fill a new tab like this one" means copying their sheet, and its fonts, colors and layout override the font, color and number rules here. Follow **Adding a tab modeled on an existing sheet** below. When the user says "new file or edit, whichever is easier", adding the tab is always the answer.

## Editing a user's workbook

A file the user gave you is usually a form they depend on. Change only what they asked for, and
prove nothing else moved.

1. **Never overwrite the original.** Keep the uploaded file untouched as the reference, and save
   your edit under a new name, such as `/mnt/data/<name>_updated.xlsx`.
2. **Inspect it with cell addresses before planning any write.** `markitdown` shows no addresses,
   so it cannot tell you where to write:
   ```python
   from openpyxl import load_workbook
   wb = load_workbook('/mnt/data/original.xlsx')
   for ws in wb:
       print('##', ws.title, '| merged:', sorted(str(r) for r in ws.merged_cells.ranges))
       for row in ws.iter_rows():
           for cell in row:
               if cell.value is not None:
                   print(cell.coordinate, repr(cell.value))
   ```
3. **Find every target by its label, never by guessing an address.** Locate the table header
   ("Sl. #", "Description"), the total ("Total Estimated cost") and fields such as "Amount in
   words" or "Remarks" in that output, and write relative to them.
4. **Write only to a merged range's top-left cell, and never unmerge.** A `MergedCell` read-only
   error means the address is wrong — you are writing into a title or a label. Stop and inspect
   again. Unmerging to make the write succeed destroys the form's layout.
5. **Do not insert or delete rows or columns, and do not rebuild the workbook,** unless the user
   asked for exactly that. If the items do not fit the existing rows, ask with
   `ask_user_question` instead of restructuring the form.
6. **Fill the inputs and let the existing formulas compute.** Write quantities and unit costs,
   leave the estimated-cost and total formulas in place, and extend a `SUM` range only when you
   were asked to add rows.
7. **Fit your content to the form; never fit the form to your content.** Column widths, row
   heights, margins, the page header and footer, print titles and fit-to-page are part of the
   form. They decide how it prints on the one page the office signs. Never change them unless
   the user asked. When text or a number is too big for its cell, change the content instead:
   use the template's own wording style, abbreviate ("2nd mtg, 24 Nov 2025"), move detail into
   Remarks, or group rows. If it still cannot fit, ask with `ask_user_question`. The gate reports
   anything that no longer fits as a `fit` issue and any changed print layout as a `layout` issue.
8. **Pass the structure preservation gate before you deliver.**

## Adding a tab modeled on an existing sheet

Never rebuild a form by hand. Retyping its cells, merges, widths and borders cannot reproduce it
and is what leaves the new tab broken. Copy the sheet itself, then fill it like any other edit:

1. **Copy it with `copy_sheet.py`,** never with a fresh `Workbook()` or by hand:
   ```bash
   python /mnt/data/skills/xlsx/scripts/copy_sheet.py /mnt/data/original.xlsx /mnt/data/original_updated.xlsx \
     --template 'Sheet1' --name 'Investigation Committee'
   ```
   Then load `original_updated.xlsx` with openpyxl, fill the new tab, and save it under the same
   name. Plain `copy_worksheet` keeps widths, heights, margins and merges but silently drops the
   page header and footer, print titles, print area, page breaks, freeze panes, zoom, data
   validation and conditional formatting. The script copies all of these and places the tab
   right after its template. Neither can copy images or charts, so when `not_copied` lists any,
   tell the user their logo will be missing from the new tab.
2. **Inspect the copy with addresses and map the source data onto the template's columns.**
   Decide which source figure goes into each column before writing (for example: gross amount,
   VAT, tax deducted at source). Keep each row's formulas (such as `=D8-E8-F8`) and the totals.
3. **Clear every leftover value from the template in the item rows,** including the numbers and
   remarks in rows you do not fill. Clear values only and keep the cells' styles and formulas, so
   empty rows stay part of the printed form.
4. **Rewrite every hardcoded field for the new subject,** in the template's exact style: header
   fields (`: 80,000/=`, `: 20/06/2025`), purpose, the advance or deduction lines, and the
   amount in words, which must match the new total. A field you skip still shows the old
   sheet's figures.
5. **Make the items fit the rows the template has.** If there are more items than rows, group
   them naturally (one row per meeting with the head count as quantity, instead of one row per
   person) and say so, or ask with `ask_user_question`. Never `insert_rows`: it moves values but
   leaves every merged range, formula reference and row height where it was, so the signature
   block and totals end up misaligned.
6. **Run the gate with the new tab declared against its template:**
   `--new-sheet 'Investigation Committee:Sheet1'`, with `--allow` ranges on the new tab only. The
   original sheet gets no `--allow` at all, because it must come back unchanged.

## Mandatory structure preservation gate

For any edit to a file the user provided, a clean recalculation is not completion. After saving
under the new name, and after `recalc.py` (which rewrites the file in place):

```bash
python /mnt/data/skills/xlsx/scripts/verify_structure.py /mnt/data/original.xlsx /mnt/data/original_updated.xlsx \
  --allow 'Sheet 2!B12:D14' --allow 'Sheet 2!A19' --allow 'Sheet 2!B20'
```

- `--allow` names exactly the ranges you meant to change: a cell (`A19`), a block (`B12:D14`),
  whole rows (`12:14`) or whole columns (`B:D`). Decide them from the task before you run the
  check, and never widen them to make a failing check pass.
- **Every tab you add must be declared with `--new-sheet`,** or the check fails on the sheet list.
  `--new-sheet 'NEW:TEMPLATE'` declares a tab copied from `TEMPLATE`. It is then compared with
  that template like an edit, so everything outside its `--allow` ranges must still match.
  `--new-sheet 'NEW'` declares a tab with no template (a summary, say), which only has to exist.
  Original sheets must keep their order. New tabs may go anywhere around them.
- It compares sheets, merged ranges, column widths, row heights, hidden rows and columns, the
  print layout (orientation, paper, fit to page, margins, page header and footer, print area and
  titles, page breaks, centering, freeze panes), data validation, conditional formatting, images
  and charts, and the value and formatting of every cell outside the allowed ranges.
- **It also checks that every cell's content fits the sheet's existing widths and heights**
  (`fit` issues): a number that would print as `####`, text cut off by a merged cell or a filled
  neighbour, wrapped text taller than a fixed-height row. A cell that already overflowed in the
  original is not reported. Fix a `fit` issue by changing the content, as in step 7 of
  **Editing a user's workbook**, never by resizing the column or row. It already
  tolerates what LibreOffice rewrites on save: rounded row heights, explicit default alignment,
  color alpha bytes, the automatic color (`indexed 64`) saved as `auto`, and page options the
  original left unset.
- It prints JSON: `status: success` exits 0; `changes_found` exits 2 and lists every difference;
  an `error` key exits 1 for bad arguments.
- **Do not return or attach the workbook unless it reports `success`.** On failure, start again
  from the untouched original — do not patch the broken output.
- **A `media` issue means images or charts were lost.** openpyxl drops logos, pictures and shapes
  on save, so even a correct edit loses them. Never deliver that silently: tell the user what
  would be lost and ask how to proceed.
- In the final response, say which ranges you changed and how many merged ranges and untouched
  cells were verified.

## Mandatory calculation completion gate

For any request involving totals, costs, quantities, subtotals, balances, percentages, or other derived values, saving the workbook is not completion:

1. Put formulas in every requested calculated cell; do not only calculate values in Python.
2. Save the workbook to the final output path.
3. Recalculate it with `python /mnt/data/skills/xlsx/scripts/recalc.py /mnt/data/output.xlsx`.
4. Verify every requested result with `python /mnt/data/skills/xlsx/scripts/verify_calculations.py /mnt/data/output.xlsx --formula 'Sheet!F12' --expect 'Sheet!F12=150000'`.
5. Do not return or attach the workbook unless both commands report success. A saved file with a blank, stale, or hardcoded total is a failed deliverable.
6. State in the final response how many formula cells and calculated values were checked.
7. When the workbook is an edit of a file the user provided, it must also pass the structure
   preservation gate above, run after `recalc.py`.

## Recalculate (mandatory whenever the file contains formulas)

openpyxl writes formulas as strings with **no cached values**. Until you recalculate, every
formula cell reads back as `None` to anything reading cached values — `pandas`,
`load_workbook(data_only=True)`, and most previewers.

```bash
python /mnt/data/skills/xlsx/scripts/recalc.py /mnt/data/output.xlsx [timeout_seconds]   # default 30
```

LibreOffice computes every formula, the file is **rewritten in place**, and you get JSON:
`status` (`success` | `errors_found`), `total_formulas`, `total_errors`, and an
`error_summary` naming up to 100 cells per error type (`locations_truncated` says how many it
withheld — trust `total_errors`, not the length of the list). Fix what it names and run it
again. **JSON with an `error` key instead of a `status` means nothing was recalculated**, and
`errors_found` exits with code 2, so the execution step fails and must be fixed before delivery.

**A green recalc proves your formulas *evaluate*, not that they are *right*.** An off-by-one
range or a reference to the wrong row yields a clean, error-free file with wrong numbers.
Write 2–3 formulas first and check they pull the values you expect, before building out a grid.

**A workbook that links to another file loses those links** if you re-save it with openpyxl and
then recalculate. Such a formula reads `='[1]Returns Analysis'!$B$2` — the `[1]` is an index
into the workbook's external-reference list, naming a *separate file on disk*, not a sheet.
That file is rarely present here, so the cell's cached value is the only thing holding its
data. openpyxl strips that value on save; LibreOffice then has to resolve the reference for
real, fails, writes `#NAME?`, and deletes every link. `recalc.py` refuses to run in that state
— copy those cells' values out of the original before you save over them (`--force` overrides,
and accepts the loss).

## Choosing formulas that survive verification

LibreOffice implements fewer functions than Excel, and one it cannot evaluate becomes a
literal `#NAME?` baked into the file you deliver.

- **Prefer Excel-2007-era functions** — `SUMIFS`, `INDEX`, `MATCH`, `IFERROR`, `SUMPRODUCT` — which need no prefix.
- **Six post-2007 functions work, but only with an `_xlfn.` prefix**, because openpyxl writes your formula into the XML verbatim and Excel stores post-2007 names prefixed (its UI hides the prefix): `_xlfn.TEXTJOIN`, `_xlfn.CONCAT`, `_xlfn.IFS`, `_xlfn.SWITCH`, `_xlfn.MAXIFS`, `_xlfn.MINIFS`. Written bare, each yields `#NAME?`.
- **Never use `XLOOKUP`, `XMATCH`, `SORT`, `FILTER`, `UNIQUE`, or `SEQUENCE`.** The runtime's LibreOffice cannot evaluate them under *any* prefix. Newer builds do evaluate them, but they are spilling array functions and an openpyxl-written file has no spill metadata, so only the top-left cell of the range gets a value — and `recalc.py` reports `total_errors: 0` on the truncated result. Use `INDEX`/`MATCH` for lookups, and sort, filter, and de-duplicate in Python before writing the cells.
- A formula LibreOffice could not parse is written back **lowercased** — a quick tell beside a `#NAME?`.

## openpyxl gotchas

- **Reading a model takes two loads.** `data_only=True` yields cached values with the formulas gone; the default yields formula strings with no values. One pass cannot give you both.
- **`data_only=True` is destructive if you save.** That workbook has no formulas left, so saving replaces every one with a literal — permanently.
- **`data_only=True` on a file openpyxl just wrote returns `None` everywhere** — run `recalc.py` first. (A formula whose result is `""` also reads back as `None`.)
- **`insert_rows` / `delete_rows` only shift cell values.** Merged ranges, formula references (`=SUM(D8:D17)` stays as it was), row heights and data validation stay put, so everything below the insertion point breaks. Avoid them in any user's form.
- **`copy_worksheet` works within one workbook only,** and leaves out the page header and footer, print titles, print area, page breaks, freeze panes, data validation, conditional formatting, images and charts. Use `scripts/copy_sheet.py` instead.
- **`ws.print_title_rows = None` does nothing,** and neither does it for `print_area`. The old value is kept.
- **Merged cells: write the top-left anchor only.** Every other cell in the range is a `MergedCell` whose `.value` is read-only. **Never unmerge to get past that error** — it means the address is wrong.
- **`.xlsm` loses its macros unless you pass `keep_vba=True`** to `load_workbook`.
- **A sheet name containing a space must be quoted** in a cross-sheet reference: `='Assumptions Inputs'!$B$5`. Unquoted, it evaluates to `#VALUE!`.

## Financial models

Unless the user says otherwise, or the existing file already does something else.

**Color:** blue text (`0,0,255`) for hardcoded inputs and scenario levers · black for formulas ·
green (`0,128,0`) for links to another sheet · red (`255,0,0`) for links to another file ·
yellow fill (`255,255,0`) for key assumptions and cells the user should fill in.

**Numbers:** currency `$#,##0`, with the unit named in the header (`Revenue ($mm)`) · zeros
render as `-`, including in percentages (`$#,##0;($#,##0);-`) · negatives in parentheses ·
percentages `0.0%`, **stored as fractions** (`0.15` renders `15.0%`; storing `15` renders
`1500.0%`) · valuation multiples `0.0x` · years as text (`"2024"`, never `2,024`).

**Structure:** every assumption in its own labeled cell, referenced by the formulas that use it
(`=B5*(1+$B$6)`, never `=B5*1.05`) · formulas consistent across every projection period, since a
lone edited cell mid-row is the commonest silent error · guard denominators that can be zero.

## Building a statement from a source document

When the figures are transcribed from a PDF or report — a budget table, an annual-report
schedule, a set of accounts — the workbook is an analysis surface, not a copy of the page. It
must recompute, reconcile against the document, and read as a statement. The colour and number
conventions in *Financial models* apply throughout; this section is about structure.

**Totals are formulas, never figures typed from the document.** A typed total looks correct on
the day and is wrong the moment anyone edits a line above it. Worse, it hides transcription
errors: a budget sheet whose grand total was typed as 5,663.15 while its own lines summed to
5,663.65 shipped with a 0.50 discrepancy nobody could see. Write `=SUM()` for every subtotal,
subtotals-of-subtotals for every total, and then **add a reconciliation row**: the document's
printed total in a blue input cell with a page reference in its comment, and beside it
`=printed - computed`, which must show `-`. If it does not, report the difference to the user
with the page — do not choose a side silently.

**Lay it out as a statement:**

```
UGC Bangladesh — Main Budget Heads
FY 2021–22 · Tk lakh                                      ← unit once, here; never in headers

                          Budget   Revised   Actual   vs Budget     %    Share
Current grants                                                             ← section header
  Salary support           1,178     1,125    1,218        +40   3.4%   20.3%
  …
  Total current            5,553     5,499    5,772       +220   4.0%   96.0%   ← =SUM
Capital grants
  …
  Total capital              105       105      242       +137            4.0%
Total expenditure          5,658     5,604    6,014       +357   6.3%  100.0%   ← =sum of subtotals
Closing balance                6        27       57                              ← outside the block
Grand total                5,664     5,631    6,071                              ← =total + balance
Check: printed grand total 5,664 · difference  -                                 ← must be zero
```

- **Group heads into the sections the document uses** — current vs capital, revenue vs
  expenditure — with a section-header row and indented heads (`alignment.indent = 1`). A flat
  list of eleven heads followed by five bold rows makes the reader reverse-engineer which
  lines feed which total. Give detail rows `outline_level = 1` so the reader can collapse a
  section to its subtotal.
- **Variance is the point of a budget table.** Add `Actual − Budget` as
  `=D5-B5` with format `+#,##0;(#,##0);-`, and `%` as `=IFERROR(D5/B5-1,"-")` with `0.0%`.
  On a small base a percentage misleads — +137 on 105 reads as `+130%` — so on bases under
  roughly a hundred units show the absolute variance only and leave `%` blank.
- **A share column divides by the total of its own kind.** Expenditure share is over total
  expenditure, never over a grand total that also holds an opening or closing balance; a
  balance row gets no share at all. Shares that sum to 99.1% mean the denominator is wrong.
- **Decimals follow the source.** Integers for lakh and crore figures (`#,##0`); `#,##0.00`
  only on rows the document prints with decimals. Every whole number printed as `1,178.00`
  is noise on every line.
- **Headers wrap.** Set `wrap_text=True` on *every* header cell, row height 30 or more, and
  numeric columns at least 14 wide. A header that runs off the cell — `sed budget (Tk lakh)`
  — is the commonest defect in a rendered sheet, and invisible until you render it.
- **Borders mark structure, not rows.** Nothing between body rows. A thin top border on each
  subtotal; thin top plus double bottom on the grand total; a fill on the header row only. Five
  bold rows in three near-identical blues is not a hierarchy.
- **No autofilter across totals.** Sorting a range that includes subtotal rows scrambles them.
  A fixed statement usually needs no filter; if the user wants one, it covers detail rows only.
- **A status or classification column is a dropdown**, not free text:
  `DataValidation(type="list", formula1='"On track,At risk,Over"')` added to the range. It
  survives recalculation.
- **Freeze the header** (`freeze_panes` below it) and set `print_title_rows` so a printed copy
  repeats it.

**Everything above survives `recalc.py`** — formulas, thin and double borders, number formats,
data-validation dropdowns, conditional formatting, cell comments, freeze panes, column widths,
row heights, wrapping, autofilter, outline grouping, print titles; checked on openpyxl 3.1.5
through the sandbox LibreOffice. One thing changes shape without changing meaning: a
format like `+#,##0;(#,##0);"-"` reads back as `\+#,##0;\(#,##0\);\-`. That is the same
format, escaped. Do not "repair" it.

**Render and read the sheet before delivering** — the same `soffice → pdftoppm → Read` check as
for charts. Clipped headers, a wrapped title, a column of `#####` and a total row that lost its
border are all visible only in the render, and `recalc.py` reports none of them.

## Charts

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

## Dependencies

`openpyxl`, `pandas`, `markitdown` (pip, preinstalled — install only if an import fails or the command is missing) · LibreOffice (`soffice`, auto-configured for sandboxed environments via `scripts/office/soffice.py`)
