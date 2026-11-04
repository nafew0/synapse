---
name: latex
description: "LaTeX: solutions, papers, exam class, Beamer, thesis chapters, tables or equations as LaTeX; Word to LaTeX; a university .cls; fixing a pasted compile error. Delivers clean .tex source, statically checked; does not compile it."
user-invocable: false
license: Proprietary. LICENSE.txt has complete terms
---

# LaTeX

Lecturers and PhD students ask for "the solution in LaTeX", "standard LaTeX", a Word file converted
to LaTeX, a paper in their conference's class file, an exam in the `exam` class, Beamer slides, or a
fix for a compile error they paste. The sandbox has **no TeX**: this skill writes clean, standard
LaTeX source that the user compiles in Overleaf or their own TeX, and checks it with a static linter.
Quality comes from following the standards below and passing the checker, never from claiming a
compile that did not happen.

> Script paths below are relative to this skill's directory.

## Pick the job

| The user wants | Do this |
|---|---|
| A worked solution, derivation, numerical method ("give the solution in LaTeX") | `templates/solution-sheet.tex` |
| A paper, report or article | `templates/article.tex`, plus `templates/references.bib` only for references the user gave |
| An exam or test paper, with or without a marking scheme | `templates/exam.tex` (exam class, `\printanswers` switch) |
| Slides, a presentation | `templates/beamer.tex` |
| A thesis chapter | `templates/thesis-chapter.tex` (a file for `\include`); a whole thesis: `report` class main file that `\include`s the chapters |
| Only a table, an equation, one environment ("LaTeX code for this table") | Answer in the chat in a ```latex block; no file. Still follow the standards and name the packages it needs |
| A Word document as LaTeX | pandoc, then `scripts/clean_pandoc.py` (below) |
| The paper in their own class (`icas_UoV.cls`, a journal template) | Read the uploaded `.cls`/`.sty`/sample `.tex` first. Use `\documentclass{<their class>}`, fill every metadata macro it defines (title, authors, affiliations, keywords, abstract), use only commands it documents or standard ones, and do not load packages it already loads. Deliver their `.cls` back inside the zip |
| A compile error fixed (they paste the log or the error) | Find the cause in the table under "Fixing a pasted error"; return the corrected file (or the corrected lines for a large file) and one line on the cause |
| An existing `.tex` improved or converted to standard LaTeX | Keep their content and labels; fix what the checker reports |

Copy a template with `cat` (skill files are read-only), e.g.
`cat /mnt/data/skills/latex/templates/exam.tex > /mnt/data/qa/exam.tex`, then edit the copy.

## Never invent

- **References**: cite only works the user supplied or a search in this conversation returned. Where
  a claim needs one you do not have, put a visible `[citation needed]` and `% TODO: citation
  needed` there instead of a `\cite`, and list it in the reply. The template `.bib` entries are
  examples: delete them.
- **Data, marks, results, names, course codes, dates**: use the user's; otherwise leave the
  template's `% TODO` placeholder and list it.
- **Mathematics**: check every step of a derivation (substitute back, check a special case, use
  `sympy` in the sandbox for algebra, integrals and numerical values). A wrong solution typeset
  beautifully is still wrong.

## Write, check, deliver

1. Write in `/mnt/data/qa/<name>.tex` (and `<name>.bib`). `<name>` is short and descriptive
   (`ma2013-tutorial3-solutions`), not `main` or `output`.
2. Check it (one round, two at most):

```bash
python3 /mnt/data/skills/latex/scripts/check_tex.py /mnt/data/qa/<name>.tex
# --bib refs.bib     check \cite keys (found automatically from \bibliography{...} when local)
# --engine xelatex   the engine the user will use, when it is not pdfLaTeX
# --snippet          a chapter or fragment: no \documentclass needed, package checks skipped
```

   Exit `0` clean, `2` defects listed, `1` bad argument. Fix every **error** in one edit; fix
   warnings unless the user's own file had them and they asked for minimal changes. If an error
   looks wrong, read the line before changing the document (the checker is heuristic).
3. Deliver at the top of `/mnt/data`: `<name>.tex`, `<name>.bib` when there are references, and the
   images the document uses. With 3 or more files, also deliver one `<name>.zip` laid out the way
   Overleaf expects (main `.tex` and `.bib` at the root, images in `figures/` with matching
   `\includegraphics{figures/...}` paths, any user `.cls`/`.sty` at the root):

```bash
cd /mnt/data/qa/<name> && python3 -c "import shutil; shutil.make_archive('/mnt/data/<name>', 'zip', '.')"
```

### Word to LaTeX

```bash
cd /mnt/data/qa && pandoc /mnt/data/<file>.docx -s -o raw.tex --extract-media=figures
python3 /mnt/data/skills/latex/scripts/clean_pandoc.py raw.tex /mnt/data/qa/<name>.tex
```

It keeps the body and title, rebuilds a minimal preamble from what the body uses, removes pandoc
noise (`\tightlist`, `\def\labelenumi`, `\hypertarget`, `\pandocbounded`), turns longtables of 30
rows or fewer into `table` + `tabular` with booktabs, uses `$...$` inline and `\[...\]` display,
drops manual heading numbers, then prints the checker report. Then read the result once: equations
from Word's equation editor, merged table cells and text boxes need a manual look. Images land in
`figures/media/`; deliver them in the zip.

## LaTeX standards

The checker enforces most of these; follow all of them.

- **Structure**: `\documentclass` → preamble → `\begin{document}` … `\end{document}`; a complete,
  compilable document unless the user asked for a snippet. Indent environment bodies by two
  spaces; one sentence per line or lines wrapped at 100 columns; comments only where they help.
- **Packages**: load only what is used. `hyperref` near last, `cleveref` after it. Standard set:
  `amsmath`, `amssymb`, `amsthm`, `graphicx`, `booktabs`, `siunitx`, `geometry`, `enumitem`.
- **Maths**: amsmath environments — `equation`, `align` (never `eqnarray`), `aligned`/`gathered`
  inside `\[...\]` (never `align` inside `\[...\]` or `$$`), `cases`, `pmatrix`; `\text{...}` for
  words, `\operatorname`/`\DeclareMathOperator` for operators; `\[...\]` not `$$...$$`;
  `\left`/`\right` pairs on one row; `\dots`/`\cdots` not `...`. In running text use `\frac` or
  `\tfrac`; `\dfrac` only in displays (it makes inline fractions too big).
- **Obsolete commands**: no `\bf \it \rm \sc \tt \over \centerline`; MathJax-only `\bbox` does not
  exist in LaTeX.
- **Floats**: `figure`/`table` with `[htbp]`, `\centering` (not a `center` environment),
  `\caption` then `\label`; `\includegraphics[width=\linewidth]{...}` or a fraction of it.
- **Tables**: `booktabs` (`\toprule`, `\midrule`, `\bottomrule`), no vertical rules; `siunitx`
  `S` columns to align numbers, `\qty{9.81}{\metre\per\second\squared}` for units.
- **Cross-references**: `\label{fig:...}`, `tab:`, `eq:`, `sec:`, `ch:`; a non-breaking space:
  `Figure~\ref{fig:x}`, `equation~\eqref{eq:y}`, or `\cref{...}`.
- **Text**: escape `\% \& \# \_ \$ \{ \}`, `\textasciitilde`, `\textasciicircum`,
  `\textbackslash`; quotes ``like this''; ranges `1--5`; dashes `---`.
- **References**: BibTeX (`\bibliographystyle{plain}` + `\bibliography{name}`) or biblatex
  (`\addbibresource{name.bib}` + `\printbibliography`) — the user's or the class's choice. Keys
  `surname2023keyword`. Every `\cite` key must be in the `.bib`.
- **Beamer**: `[fragile]` on every frame with `lstlisting`, `verbatim`, `minted` or `\verb`
  (otherwise "Runaway argument … \lst@next"); one idea per frame; `\pause` sparingly.
- **Exam class**: `\question[marks]`, `\part[marks]`, `\begin{solution}` after each question;
  `\printanswers` in the preamble prints the marking scheme, commented out for the student copy;
  `addpoints` class option for `\numpoints` and `\gradetable`.
- **Language**: English only, compiled with pdfLaTeX. Bangla, Sinhala, Tamil and other non-Latin
  scripts are not supported: say so and offer the document in English, or a Word file with the
  `docx` skill for Bangla. The checker reports such text as an error.

## Fixing a pasted error

| Error text | Usual cause and fix |
|---|---|
| `Runaway argument? ! Paragraph ended before \lst@next was complete` | listing or verbatim in a Beamer frame: `\begin{frame}[fragile]` |
| `Undefined control sequence` | missing package (the checker names it) or a typo; `\bbox` is MathJax-only |
| `Missing $ inserted` | `_` or `^` in text, a maths command outside maths, or a blank line inside an equation |
| `Misplaced alignment tab character &` | `&` in text: `\&`; or `align` content outside an alignment |
| `Environment ... undefined` | missing package, or `\newtheorem` not declared |
| `Extra }, or forgotten \right` / `Missing \right. inserted` | `\left`/`\right` split across `\\`: close each row with `\right.` and reopen with `\left.` |
| `File '...sty' not found` / `.cls not found` | package not installed, or the user's class file not uploaded next to the `.tex` |
| `Unicode character ... not set up for use with LaTeX` | Greek or symbols typed directly: write `\alpha`, `\leq` |
| `Citation ... undefined` / `Reference ... undefined` | run BibTeX/compile twice; key or label missing (the checker lists them) |

## Final reply

- One line on what was produced (`exam paper with marking scheme, 3 questions, 30 marks`).
- The engine: "Compile with pdfLaTeX" (or the user's own engine) and "upload to Overleaf or compile
  with `latexmk`".
- That it was checked but **not compiled**.
- Every `% TODO` placeholder and `[citation needed]` the checker's info line lists.
- No sandbox paths (`/mnt/data/...`), no narration of steps.

## Gotchas

- The checker cannot prove the document compiles: it misses wrong package options, undefined
  commands from unknown packages, overfull boxes and font problems. Never say "compiles" or
  "tested"; say "checked, not compiled".
- A user's class file overrides the standards: if it says `\maketitle` is automatic or requires
  `\keywords{...}`, follow the class. Read its sample `.tex` when one is uploaded.
- `exam` hides solutions unless `\printanswers` is on: deliver the student copy, and the marking
  scheme only when asked (or both, as two files).
- Pandoc cannot read `.doc`; convert it to `.docx` with the `docx` skill's LibreOffice helper first.
