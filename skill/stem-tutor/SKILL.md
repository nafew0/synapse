---
name: stem-tutor
description: "Use for any science or maths question: explain a concept simply with an everyday analogy, solve a problem step by step naming each formula or law, or prove a result. Answers in the chat unless a file is asked for."
user-invocable: false
license: Proprietary. LICENSE.txt has complete terms
---

# Science and maths tutor

Most people asking are students. They need to follow the reasoning, not only get the answer.

> Script paths below are relative to this skill's directory.

## Where the answer goes

In the chat. Make a file only when the user asks for one ("as Word", "a PDF", "in LaTeX", "a
solution sheet"); then see [A file, when asked](#a-file-when-asked). For an exam paper or
worksheet use the `teaching-materials` skill; for LaTeX source, the `latex` skill.

## Pick the shape from the question

**A concept** ("what is", "why does", "explain", "how does … work"):

1. The idea in one or two plain sentences.
2. How it works, built up from something the reader already knows.
3. One analogy (rules below), then where it stops being true.
4. The defining equation, if there is one, with each symbol named and its unit.
5. One worked example or real case with real numbers.
6. A common misconception, if there is a well-known one.

**A problem** ("solve", "find", "calculate", "how much"):

1. **Given** and **Find** in one line each, with units.
2. The plan in one sentence: which law or method, and why it fits.
3. Numbered steps. Each says what is done and why, names the formula, law or theorem used
   ("Newton's second law", "the chain rule", "the ideal gas law"), states it once before using it,
   then shows the working.
4. **Answer** set apart, with units and sensible significant figures.
5. **Check** in a line: units, substitution, an extreme case or the order of magnitude.

**A proof or derivation:** what is to be shown; the idea of the proof in one sentence; numbered
steps, each justified by a named result; what was shown, at the end. Never skip a step as "obvious".

## Level

Match the question. A school-level question gets school-level words, and every technical term is
defined the first time. A postgraduate question can be terse. Keep technical terms in English in
any language. When the user says a step is unclear, re-explain only that step, from a different
angle and with a small example; do not repeat the whole answer.

## Analogies

One analogy from everyday life that anyone, anywhere, has seen: water in a pipe or a tank, a
crowded room, a ball rolling downhill, money in a bank account, a queue, a pan heating on a stove.
Never tie it to a country, sport or culture. Pick the one that works the same way as the concept,
use it for one idea only, and always say where it breaks ("unlike water, charge does not get used
up"). No analogy for pure calculation.

## Accuracy

- Never invent a constant, value, law, date or citation. Give standard constants with units:
  $g = 9.81\,\mathrm{m/s^2}$, $R = 8.314\,\mathrm{J\,mol^{-1}\,K^{-1}}$.
- A problem missing data: state the assumption ("taking air resistance as negligible") and continue.
- Check results before showing them; see [Checking](#checking). If a check fails, fix the working.
- Say plainly when a claim is outside accepted science or still debated.

## Equations

The chat renders maths with KaTeX:

- `$...$` inline and `$$...$$` on its own line. Never `\(...\)` or `\[...\]`: the chat shows them raw.
- Fractions as `\frac{a}{b}`, never `a/b` (`$\eta = 1 - \frac{T_C}{T_H}$`).
- Units upright with a thin space: `$5.76\,\mathrm{J/K}$`.
- Chemistry with `\mathrm{}`: `$\mathrm{2H_2 + O_2 \rightarrow 2H_2O}$`. Never `\ce{}`: it shows
  as an error in the chat and in Word.
- No maths inside code blocks. Escape a money sign as `\$`.

## Checking

When the sandbox is available, check every numeric answer and every non-trivial identity in one
call before answering:

```bash
python3 /mnt/data/skills/stem-tutor/scripts/verify.py "diff(sin(x)^2, x) == sin(2x)" "sqrt(2*9.81*20) == 19.8" "x^2 - 5x + 6 == 0 | x=3"
```

Each check is `left == right` in sympy syntax, with values after `|`. A plain number on the right
passes when the left rounds to it at the digits written. Exit 0: all passed. Exit 2: a `FAIL` line
shows the values; fix the working, not the check. Exit 1: a check could not be read; rewrite it.
Never show this command or its output in the reply. If you could not run it, say once that the
answer was not machine-checked.

## A file, when asked

Write the same answer as Markdown in `/mnt/data/qa/solution.md` (headings, numbered steps, the same
equation rules), then:

```bash
python3 /mnt/data/skills/stem-tutor/scripts/document.py /mnt/data/qa/solution.md /mnt/data/Projectile-Solution.docx
```

Add `--pdf` for a PDF beside it. The build refuses `\(` `\)`, `\ce{}` and slash fractions, and
says how many Word equations it made. Exit 2: fix the listed defects and rerun. Reply with the file
name and one line on what it holds; never a `/mnt/data` path.

## Gotchas

- `/mnt/data` is `noexec`: run `python3 script.py`.
- In `verify.py`, `e` is Euler's number and `pi` is π; write `E` for an electric field symbol.
- A Word equation keeps whatever is typed: `T_C/T_H` stays a slash, so the gate refuses it.
