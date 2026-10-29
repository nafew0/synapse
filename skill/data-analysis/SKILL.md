---
name: data-analysis
description: "Statistics and interpretation: descriptives, t-test, ANOVA, regression, correlation, chi-square, reliability (Cronbach's alpha), low marks in mark sheets, group comparisons, SPSS output. Building or formatting a workbook without analysis: xlsx."
user-invocable: false
license: Proprietary. LICENSE.txt has complete terms
---

# Data analysis: statistics, marks and comparisons

Analyse the user's data (mark sheets, surveys, salary tables, research data) and explain the
result in plain language. Two scripts do the work: `profile_data.py` reads the file and reports what
is in it, `stats.py` runs one test and writes its tables plus an interpretation. The xlsx skill
owns the delivered workbook's layout, formulas and checks; this skill decides what to compute
and what it means.

> Script paths below are relative to this skill's directory.

## The user wants → do this

| The user wants | Run |
|---|---|
| To know what is in a file, or anything below (always first) | `scripts/profile_data.py IN [--sheet S]` |
| Mean, SD, median, frequencies; "descriptive statistics for my survey" | `stats.py describe IN [--cols ...] [--group G]` |
| Students (rows) with low marks in any module | `stats.py flag IN --cols M1 M2 ... --below 40 [--id Name RegNo]` |
| Salaries, allowances or marks side by side by university, post, gender | `stats.py compare IN --group University Post --cols Basic Allowance [--stats count,mean,min,max] [--total]` |
| Two groups differ? (male/female, two batches) | `stats.py ttest IN --dv Score --group Gender` (Levene decides Student or Welch) |
| Before and after on the same people | `stats.py ttest IN --cols Pre Post` |
| Mean against a fixed value | `stats.py ttest IN --cols Score --mu 50` |
| Three or more groups; one-way ANOVA | `stats.py anova IN --dv Score --iv Faculty` |
| Two factors and their interaction (two-way ANOVA) | `stats.py anova IN --dv Score --iv Faculty Gender` |
| Predict one variable from others; regression | `stats.py regression IN --dv Y --iv X1 X2 ...` (text columns become dummies) |
| Relationship between numeric variables | `stats.py correlation IN --cols A B C [--method spearman]` (Spearman for Likert or ranks) |
| Association between two categories (cross-tab) | `stats.py chisq IN --row Faculty --col Response` |
| Reliability of a questionnaire scale; Cronbach's alpha | `stats.py reliability IN --cols Q1 Q2 Q3 ... [--reverse Q4 --scale-min 1 --scale-max 5]` |
| Totals with VAT, percent progress on an action plan, grades converted to marks | No test: xlsx skill, with formulas (`=ROUND(B2*(1+$F$1),2)` with the VAT rate in its own cell, `=C2/D2`, an `INDEX/MATCH` against a grade table the user gives) |
| "Interpret this SPSS output" (pasted tables, no data) | Explain from the numbers given; see below. Run nothing |

All `stats.py` subcommands take `IN --sheet NAME --header-row N --out PATH --out-sheet NAME`.
`--out` defaults to `/mnt/data/qa/results.xlsx`; each subcommand writes or replaces its own sheet
there, so several analyses collect in one workbook. A `.csv` path writes the tables stacked.
Column names are matched without regard to case. `stats.py SUBCOMMAND -h` lists every option.

## Workflow

1. **Profile.** `python3 /mnt/data/skills/data-analysis/scripts/profile_data.py /mnt/data/<file>`.
   It finds the header row (skipping a title row or a merged group header), and lists each
   column's type, n, missing, unique, range and top values. Exit 2 lists data problems: numbers
   mixed with text (`AB`, `absent`, `-`), more than 20% missing, empty columns. Those cells are
   treated as missing by every test; tell the user how many and where. If the header row is
   wrong, rerun with `--header-row N` (the sheet's row number).
2. **Choose the test** from the table above and the profile: the DV must be numeric, groups
   come from a text or code column. When the user names a test, run that one. When the
   question is vague ("analyse this"), run `describe` and the one test that answers the
   obvious question, and say which you chose and why. Ask only when the variables cannot be
   told apart from the column names; if the user does not answer, make the most reasonable
   choice and state it.
3. **Run it**: one call per test, all in the same tool call where possible. Read the report:
   the tables, `Warnings:`, then `Interpretation:`.
4. **Write the results** where the user will see them: tables in the reply for a short answer,
   or a workbook for a mark sheet, a comparison or anything the user will keep. For a workbook,
   use the xlsx skill: copy the tables from `/mnt/data/qa/results.xlsx` into a new sheet of the
   user's workbook (`cells.py`/`copy_sheet.py` rules there) or into a new file, add the
   interpretation under the tables, charts via `xlsx/references/charts.md`.
5. **Check the workbook** with the xlsx skill's `scripts/check.py` before delivering, once.
   Totals and counts you report must match the source: add `--expect` for each.

Spend few tool calls: profile once, run the tests in one call, build the workbook in one script,
check once, fix in one round. Exit 2 from `stats.py` means the results are valid but a warning
must reach the user; it is not a reason to rerun.

## Reporting rules

- **Every test result names**: the test, n (per group where there are groups), the statistic
  with its df, the p-value, an effect size, and the assumptions checked. Example:
  `t(58) = 2.41, p = .019, d = 0.62` · `F(2, 54) = 4.90, p = .011, partial eta squared = .15`.
- **p-values**: `p < .001` below .001, otherwise three decimals with no leading zero
  (`p = .034`). Never `p = .000`; SPSS prints `.000` for `p < .001`.
- **When an assumption fails, say so and name the alternative** the script used: Welch's t
  (unequal variances), Mann-Whitney or Wilcoxon (non-normal, small n), Welch's ANOVA or
  Kruskal-Wallis (one-way), HC3 robust standard errors (regression heteroscedasticity),
  Fisher's exact test (sparse 2x2 table), Spearman (non-normal correlation).
- **Interpretation in plain English** for the user's purpose: what the result means for their
  question (which students to check, which university pays more, whether the scale is
  reliable), then the statistics in brackets. Significant is not the same as important: give
  the effect size word (small, medium, large). Correlation is not cause.
- **Never invent data**: no made-up rows, means or p-values, and no "example" numbers presented
  as results. If the data needed for a test is missing, say what is needed. Never report a
  p-value without its test and n.
- **Reliability is not validity.** Cronbach's alpha shows internal consistency (.7 acceptable,
  .8 good). Validity questions (content, construct, convergent, discriminant) need expert
  review, factor analysis or correlation with another measure; explain that, and run
  `correlation` when the user has the other measure.
- **Marks:** `flag` uses strictly below the threshold (`--inclusive` for at or below) and
  reports sheet row numbers; non-numeric entries such as `AB` are listed separately for a
  person to check, never counted as zero.
- Answer in the language of the user's request; keep variable names as they appear in the file.

## Interpreting pasted SPSS output

When the user pastes or photographs SPSS (or Excel, jamovi, R) tables with no data file:

- Explain from the numbers given; never recompute or invent missing values. If a needed number
  is absent (no df, no n), say what it would add and interpret what is there.
- Go table by table: Descriptives (means, SDs), Levene's test (Sig. < .05 means unequal
  variances; read the "Equal variances not assumed" row), the test table (F or t, df, Sig.),
  effect sizes (partial eta squared: .01 small, .06 medium, .14 large), post-hoc tables.
- For a two-way ANOVA read the interaction row first: if `A * B` is significant, the effect of
  one factor depends on the other and the main effects must be read through the cell means.
- For regression: Model Summary (R squared = share of variance explained), ANOVA table (is the
  model significant), Coefficients (B = change in Y per unit of X, Beta to compare predictors,
  Sig. for each, VIF above 10 means collinearity).
- Report SPSS's `Sig. = .000` as `p < .001`. Close with a short paragraph the user can put in a
  thesis results section, in APA style.

## Deliverables

- Files the user receives go at the top of `/mnt/data` (`/mnt/data/marks_flagged.xlsx`); working
  files, including `results.xlsx`, stay in `/mnt/data/qa/`. Subdirectories are not delivered.
- Never overwrite the user's file; save an edit under a new name (xlsx skill rules).
- The final reply gives the findings and interpretation, names the file, and has no paths, no
  script names and no narration of steps.

## Gotchas

- `profile_data.py` and `stats.py` read the first sheet unless `--sheet` is given; the profile
  lists every sheet name.
- Two header rows (a merged "Module 1" over "CA" and "Exam"): duplicate names are prefixed with
  the group, so they become `Module 1 CA`, `Module 1 Exam`. Use the names the profile prints.
- Numbers stored as text, with thousands separators or `%`, are converted (`45%` becomes 0.45).
- `anova` uses Type III sums of squares, as SPSS does (`--ss 2` for Type II). Each factor
  combination needs at least two values.
- Shapiro-Wilk failing with n of 30 or more per group is reported but not warned about: the
  tests are robust there.
- `.xls` files are converted through LibreOffice when `xlrd` is missing; that needs the xlsx
  skill loaded too.
