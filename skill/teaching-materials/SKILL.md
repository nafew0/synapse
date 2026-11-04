---
name: teaching-materials
description: "Use for exam papers, MCQs with answer keys, marking schemes, worksheets, lecture notes, lesson or workshop plans, and survey or interview questionnaires, as Word. Not for research papers, theses or proposals (use academic-writing)."
user-invocable: false
license: Proprietary. LICENSE.txt has complete terms
---

# Teaching materials

Builds university teaching documents as Word files: exam papers with a separate answer key and
marking scheme, MCQ sets, worksheets, week-by-week lecture notes, lesson and workshop plans, and
research questionnaires. You write the content as a JSON spec; one script lays it out, writes the
answers to a separate key, checks the result and prints a short report.

> Script paths below are relative to this skill's directory.

## Which job is this

| The user wants | kind | Notes |
|---|---|---|
| An exam or test paper, mid-term, end-of-semester paper, "questions with marks" | `exam` | Sections, marks per question, key with model answers and marking scheme |
| MCQs, a quiz, "20 questions with answers" | `mcq` | Key lists the letter and the option; `explanation` per question if asked |
| A worksheet, tutorial sheet, practice questions with sample answers | `worksheet` | Worked examples shown on the sheet; answers to the practice questions in the key |
| Lecture notes, course notes for N weeks | `lecture-notes` | One heading per week: outcomes, content, activities, reading |
| A lesson plan, session plan, workshop or training plan | `plan` | Aim, objectives, introduction, timetable with times, resources, assessment |
| A survey, Likert questionnaire, interview guide or interview questions | `questionnaire` | Likert items in a table with tick boxes; interview = open items with probes |
| A research paper, thesis chapter, proposal or literature review | not this skill | `academic-writing` |
| Edit a Word file the user uploaded | not this skill | `docx` |

The full spec, with one example per kind, is in `references/spec.md`. Read it before writing a spec.

## Ask once, then build

Ask in **one** message, only for what the request leaves open:

- course code and title, level (year, semester), and the institution, faculty or department for the header;
- for exams: duration, total marks, sections and question types, number of questions, which
  sections are "answer all" or "answer any N", and whether they want a Bloom-level spread;
- for questionnaires: the study's purpose, the target group, and the constructs to measure;
- for plans: duration, number of participants, and the audience.

If the user skips the questions or says "just make it", build anyway with sensible defaults
(2 hours, 100 marks, sections A/B/C) and say what you assumed. **Never invent** a course code,
institution, university name, lecturer or venue: leave the field out of the spec, and the paper
gets a `[Course code]`-style placeholder that the report lists. Write placeholders yourself in the
same form, e.g. `"[Venue]"`.

If the user pasted an existing paper (plain text, Word or a LaTeX `exam`-class source), carry its
sections, questions and marks over into the spec as they are; do not rewrite questions they did
not ask you to change.

## Build

1. Write the spec to `/mnt/data/qa/spec.json` (create the folder; `qa/` is never delivered).
2. Run one command:

   ```bash
   python3 scripts/build.py /mnt/data/qa/spec.json /mnt/data/<Course>_<Paper>.docx
   ```

   It writes the paper and, when the spec has any answers, `/mnt/data/<Course>_<Paper>-answer-key.docx`
   (`--key PATH` to choose). It then runs the gate (`scripts/check.py`) and, when LibreOffice is
   installed, renders page 1 to `/mnt/data/qa/<name>-page.png`.
3. Read the report. Exit 0 means deliver. Exit 2 lists defects: fix the **spec**, then run the
   same command again. One round, two at most. Read the page image once, if it was written, to
   confirm the header and layout look right; do not read more pages.

Never write the document with your own python-docx or docx-js code, and never edit the built file
by hand: change the spec and rebuild, so the gate always checks what you deliver. To re-check a
file without rebuilding: `python3 scripts/check.py SPEC.json PAPER.docx --key KEY.docx [--render]`.

## The gate (what exit 2 means)

| Report line | Fix in the spec |
|---|---|
| `total marks stated as X but the questions add up to Y` / `Section … says …` / `Q4 says 15 marks but its parts add up to 14` | Change the marks of a question or part, or the stated total, so they agree. Ask the user which is right if both are plausible |
| `Q4(a) marking scheme gives 9 marks but the question carries 8` | Make the weighted marking points add up to the part's marks |
| `Q5 has no marks` | Every exam question or part needs `marks` (or a section `marks_each`) |
| `Q3 (MCQ) has no answer in the key` / `keys 2 answers` / `answer 'e' is not one of its options` | Give exactly one letter per MCQ; `"multi": true` only when the user wants multiple-answer items |
| `answer text for Q5 appears in the student paper` / `the student paper contains 'Answer:'` | Move the answer out of `text` / `points` into `answer`, `model_answer` or `marking` |
| `Q1 and Q5 are the same question` | Replace one of them |
| `paper` / `key numbering does not match` | You checked against a different spec or an old key: rebuild both from the current spec |
| `Section C uses a different scale` | Use one Likert scale for every Likert section |
| `the timetable spans 180 minutes but the plan is 150 minutes long` | Fix the times or `duration_minutes` |
| `weeks are not numbered 1 to N` / `the course has 15 weeks but the notes cover 12` | Add the missing weeks or renumber |

If a defect looks wrong, re-read the spec before changing the content: the gate reads the spec,
so a slip there (a `marks` field on the question instead of its parts, an answer under the wrong
question) is the usual cause. Warnings (possible double-barrelled Likert items, gaps between timetable rows, fewer
than three Bloom levels) do not block delivery; fix them if it is quick, or mention them.

## Writing rules

- **Page and font.** Everything is A4, Times New Roman, 11 pt body; headings and the paper's title are
  larger. Leave `font` out of the spec unless the user asks for something else. The gate checks this.
- **Explanations are on by default and brief.** Every answered question gets an `explanation` in the
  key: one or two sentences, at most 40 words, saying why the answer is right. Do not repeat the model
  answer. Set `"explanations": false` only if the user asks for none, and
  `"explanation_length": "detailed"` only if they ask for longer ones.
- **Answers never go on the student paper.** Model answers, MCQ keys, marking schemes and
  explanations go only in the answer fields; the build puts them in the key. Worked examples on a
  worksheet are the one exception (`"type": "example"`).
- **Marks per question**: every exam question or part carries marks; parts add up to the question,
  sections to the stated total. State "Answer any N" sections with `choose`.
- **MCQs**: one clearly correct option and three plausible distractors of similar length; no "all of
  the above" or "none of the above" unless asked; spread the correct letters across a–d; one idea
  per stem; code in `code`, not in the stem.
- **Bloom levels** when the user asks for them (or for outcome-based papers): set `"bloom": true`,
  tag each question, and spread the marks from remember/understand up to analyse/evaluate/create as
  the level suits (first-year papers weight the lower levels, final-year papers the higher ones).
- **Constructed questions**: give the scenario and constraints as `points` (for example the ER
  constraints the student must model), then ask in parts with marks.
- **Likert scales**: one scale for the whole questionnaire, five points by default, worded
  "Strongly disagree – Disagree – Neither agree nor disagree – Agree – Strongly agree", negative to
  positive from left to right. Frequency items use "Never – Rarely – Sometimes – Often – Always" in a
  separate questionnaire. One idea per statement (no "and"/"or"), no double negatives, statements not
  questions. Put demographics first, open questions last, a consent and confidentiality note in `intro`.
- **Interview guides**: open questions from general to specific, each with one or two `probes`, `"lines": 0`.
- **Plans**: objectives start with an action verb ("Explain", "Design"); the timetable has start and
  end times that fill the session, with breaks as rows.
- **Lecture notes**: each week has a topic, 2–4 outcomes, the content as short paragraphs and
  points, activities and reading. For a long course keep each week short; offer to expand weeks later.
- **Language**: British spelling (organisation, programme, analyse, colour) in English documents.
  For a Bangla document write the content in Bangla and translate the fixed wording with `labels`
  (see `references/spec.md`); Bangla is set in Nikosh automatically. Sinhala and Tamil fonts are not
  installed yet: say so and offer English instead of delivering a file of empty boxes.
- **LaTeX** cannot be compiled here. Deliver Word; if the user insists on LaTeX, also give the
  `.tex` source in the reply and say it has not been compiled.

## The final reply

Say what was made and what to check, in a few lines:

- the paper (and the separate answer key, when there is one): number of questions, sections and
  the total marks, or the number of items / weeks / timetable rows;
- the placeholders the user must fill in (from the report), and any assumption you made;
- any warning you chose not to fix.

Do not mention `/mnt/data`, `qa/`, the spec, the scripts or the gate by name, and do not narrate the
steps. Do not paste the questions into the chat unless the user asked to see them there.

## Gotchas

- Only files at the top of `/mnt/data` reach the user. Keep the spec and renders in `/mnt/data/qa/`.
- Run `python3 scripts/...`, never `./scripts/...` (`/mnt/data` is `noexec`).
- JSON needs `\n` for line breaks and `\"` for quotes inside strings (code snippets, HTML tags).
- Text is plain: `**bold**` prints the asterisks. Use the section `instructions` for emphasis such as "Answer ALL questions".
- Questions are numbered 1, 2, 3… across sections; do not number them in `text`.
