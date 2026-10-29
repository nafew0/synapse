# Financial models and statements from a source document

Read this for a financial model, or for a statement (income, balance sheet, cash flow, budget) built from a document the user gave you.

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
