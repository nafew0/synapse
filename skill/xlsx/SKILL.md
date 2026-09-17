---
name: xlsx
description: "Use this skill any time a spreadsheet file is the primary input or output. This means any task where the user wants to: open, read, edit, or fix an existing .xlsx, .xlsm, .xltx, .csv, or .tsv file (e.g., adding columns, computing formulas, formatting, charting, cleaning messy data); create a new spreadsheet from scratch or from other data sources; or convert between tabular file formats. Trigger especially when the user references a spreadsheet file by name or path — even casually (like \"the xlsx in my downloads\") — and wants something done to it or produced from it. Also trigger for cleaning or restructuring messy tabular data files (malformed rows, misplaced headers, junk data) into proper spreadsheets. The deliverable must be a spreadsheet file. Do NOT trigger when the primary deliverable is a Word document, HTML report, standalone Python script, database pipeline, or Google Sheets API integration, even if tabular data is involved."
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
7. **Pass the structure preservation gate before you deliver.**

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
- It compares sheets, merged ranges, column widths, row heights, data validation, conditional
  formatting, images and charts, and the value and formatting of every cell outside the allowed
  ranges. It already tolerates what LibreOffice rewrites on save: rounded row heights, explicit
  default alignment and color alpha bytes.
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

## Dependencies

`openpyxl`, `pandas`, `markitdown` (pip, preinstalled — install only if an import fails or the command is missing) · LibreOffice (`soffice`, auto-configured for sandboxed environments via `scripts/office/soffice.py`)
