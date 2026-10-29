# Teaching-materials spec

`scripts/build.py SPEC.json OUT.docx` reads one JSON object. `kind` selects the layout:

| kind | Builds | Key document |
|---|---|---|
| `exam` | Exam paper: header block, instructions, sections, numbered questions with parts, marks on the right, "End of paper" | Yes, when any question has an answer |
| `mcq` | MCQ set or quiz (same layout as `exam`; marks optional) | Yes |
| `worksheet` | Practice sheet: worked examples, questions with answer lines; marks optional | Yes, when answers are given |
| `questionnaire` | Survey or interview questionnaire: demographics, Likert tables, choice and open questions | No |
| `lecture-notes` | One heading per week: outcomes, content, activities, reading | No |
| `plan` | Lesson or workshop plan: details table, aim, objectives, introduction, timetable, resources, assessment | No |

Fields every kind takes:

```json
"font": {"latin": "Times New Roman", "bangla": "Nikosh", "size": 12},
"labels": {"marks": "নম্বর"},
"header": {"institution": "...", "faculty": "...", "department": "..."}
```

`labels` overrides any fixed wording (see `LABELS` in `build.py`): use it for a paper in Bangla.
Text is plain: no Markdown. A `[Bracketed placeholder]` is reported back so the user can fill it in.

## exam, mcq, worksheet

```json
{
  "kind": "exam",
  "bloom": true,
  "header": {
    "institution": "Faculty of Science, [University name]",
    "department": "Department of Computer Science",
    "exam": "End-of-Semester Examination – Semester II, 2026",
    "course_code": "CS 2104",
    "course_title": "Database Systems",
    "duration": "Two (2) hours",
    "total_marks": 50,
    "index_number": true,
    "instructions": ["Answer ALL questions in Sections A and B, and any ONE question in Section C.",
                     "Calculators are not permitted."]
  },
  "sections": [
    {"title": "Section A", "instructions": "Answer ALL questions.", "marks_each": 2, "questions": [
      {"text": "Which SQL clause filters groups after aggregation?",
       "options": ["WHERE", "HAVING", "ORDER BY", "LIMIT"], "answer": "b", "bloom": "remember",
       "explanation": "HAVING is applied after GROUP BY; WHERE filters rows before grouping."}
    ]},
    {"title": "Section B", "questions": [
      {"text": "A university keeps records of students, courses and lecturers.",
       "points": ["A student enrols in one or more courses.", "Each course is taught by exactly one lecturer."],
       "bloom": "apply",
       "parts": [
         {"text": "Draw an ER diagram that captures the constraints above.", "marks": 8,
          "marking": [{"point": "Entities with keys", "marks": 3}, {"point": "M:N enrolment", "marks": 3},
                      {"point": "Cardinality and participation", "marks": 2}]},
         {"text": "Map your diagram to relational schemas.", "marks": 6, "bloom": "analyse",
          "model_answer": "Student(student_id, name); Course(course_id, title, lecturer_id FK); ..."}
       ]},
      {"text": "Explain how a deadlock can occur under two-phase locking.", "marks": 14, "bloom": "understand"}
    ]},
    {"title": "Section C", "choose": 1, "questions": [
      {"text": "Evaluate normalisation against denormalisation for a reporting database.", "marks": 20, "bloom": "evaluate"},
      {"text": "Design and justify an indexing strategy for a library loans table.", "marks": 20, "bloom": "create"}
    ]}
  ]
}
```

- Questions are numbered 1, 2, 3… across all sections; parts are (a), (b)…; parts of parts (i), (ii)….
- `marks` goes on the leaf (a question without parts, or each part). A question with parts gets
  "[Total N marks]" under it; a `marks` on the question itself must equal its parts' sum.
- `marks_each` (on the spec or a section) is the default for questions without `marks`. A section of
  MCQs that all carry the same marks says "Each question carries N marks." once instead of per question.
- Section `marks` is optional and checked. `choose: N` ("answer any N"): the section counts the N
  largest questions, which should carry equal marks. `header.total_marks` is checked against the sum.
- Question fields shown on the paper: `text`, `points` (bulleted givens, constraints, data), `code`
  (monospace block), `image` (path) with `image_width_cm`, `options` (MCQ, 2–6, laid out a)–d) in
  one, two or four columns by length), `answer_lines` (ruled lines to write on), `parts`.
- Answer fields, written **only** to the key: `answer` (MCQ: a letter `"b"`, or a list for
  `"multi": true`; other questions: the model answer), `model_answer`, `marking` (list of strings or
  `{"point", "marks"}`; weighted points must add up to the question's marks), `explanation`.
- `bloom`: remember, understand, apply, analyse, evaluate, create. On a question it covers its parts
  unless a part sets its own. `"bloom": true` at the top makes a level required on every question; the
  key ends with a level / items / marks table.
- Unnumbered entries in `questions`: `{"type": "text", "text": "..."}` (a passage or case study) and
  `{"type": "example", "text": "...", "solution": "..."}` (a worked example shown **with** its solution
  on the paper, for worksheets).
- `mcq` and `worksheet` may use top-level `"title"`, `"instructions"` and `"questions"` instead of
  `"header"` and `"sections"`; missing header fields are left out instead of becoming placeholders.

### mcq

```json
{
  "kind": "mcq",
  "title": "HTML and CSS Quiz",
  "header": {"course_code": "IT 1203", "course_title": "Web Technologies"},
  "instructions": ["Choose the single best answer for each question."],
  "marks_each": 1,
  "total_marks": 2,
  "questions": [
    {"text": "Which CSS property changes the colour of text?", "options": ["font-color", "color", "text-color", "foreground"], "answer": "b"},
    {"text": "What does this rule select?", "code": "ul > li:first-child { font-weight: bold; }",
     "options": ["Every li in any ul", "The first li that is a direct child of a ul", "The first ul", "All li except the first"], "answer": "b"}
  ]
}
```

### worksheet

```json
{
  "kind": "worksheet",
  "title": "Worksheet 3: Normalisation",
  "sections": [
    {"title": "Worked example", "questions": [
      {"type": "example", "text": "Is R(A, B, C) with A → B and B → C in 3NF?", "solution": "No: C depends on A through B."}]},
    {"title": "Practice", "questions": [
      {"text": "Give one reason for normalising a database.", "answer_lines": 3, "model_answer": "It removes update anomalies."}]}
  ]
}
```

## questionnaire

```json
{
  "kind": "questionnaire",
  "title": "Survey on the Use of ICT Facilities in the University Library",
  "header": {"institution": "[Institution name]", "department": "Library and Information Services"},
  "intro": ["Purpose of the study, that taking part is voluntary, that answers are confidential, time needed."],
  "scale": ["Strongly disagree", "Disagree", "Neither agree nor disagree", "Agree", "Strongly agree"],
  "sections": [
    {"title": "Section A: About you", "type": "demographic", "items": [
      {"text": "Faculty", "options": ["Arts", "Science", "Management"], "other": "Other (please specify)"},
      {"text": "Age in years", "lines": 1}]},
    {"title": "Section B: Access to ICT facilities", "type": "likert", "items": [
      "There are enough computers in the library for students.",
      "The library Wi-Fi is reliable."]},
    {"title": "Section C: Use of services", "type": "choice", "items": [
      {"text": "Which services do you use?", "options": ["E-journals", "Printing", "Catalogue"], "multi": true}]},
    {"title": "Section D: Suggestions", "type": "open", "items": [
      {"text": "What would most improve the library's ICT facilities?", "lines": 4}]}
  ],
  "closing": "Thank you for taking part in this survey."
}
```

- Section `type`: `demographic` and `choice` (tick boxes from `options`; `multi` adds "Tick all that
  apply"; without options, one answer line), `likert` (a table: No. | Statement | one ☐ column per scale
  point, header row repeated on each page), `open` (`lines` answer lines, default 3).
- An **interview** guide is a questionnaire of `open` sections with `"lines": 0` and `probes`:
  `{"text": "How do you prepare students for practical sessions?", "probes": ["Materials?", "Time?"], "lines": 0}`.
- One `scale` for the whole questionnaire. A section may set its own `scale`, but the gate fails
  when Likert sections disagree: use a separate questionnaire or the same scale.
- Items are numbered 1, 2, 3… through the whole questionnaire.

## lecture-notes

```json
{
  "kind": "lecture-notes",
  "title": "Lecture notes",
  "header": {"course_code": "CS 2201", "course_title": "Software Engineering", "department": "Department of Computer Science"},
  "total_weeks": 15,
  "overview": ["What the course covers and how it is assessed."],
  "weeks": [
    {"week": 1, "topic": "Introduction to software engineering",
     "outcomes": ["Define software engineering.", "Describe the stages of the software life cycle."],
     "content": [
       "Software engineering applies systematic, disciplined methods to building and maintaining software.",
       {"heading": "The software life cycle", "text": "Most processes share these activities.",
        "points": ["Requirements", "Design", "Implementation", "Testing", "Maintenance"]},
       {"heading": "Example", "code": "def area(r):\n    return 3.14159 * r * r"}
     ],
     "activities": ["Discuss a software failure you have experienced."],
     "reading": ["Course textbook, chapter 1."],
     "assessment": ["Quiz 1 opens at the end of the week."]}
  ],
  "sections": [{"heading": "Recommended reading", "points": ["..."]}]
}
```

`weeks` must run 1, 2, 3… without gaps; `total_weeks` is checked against them (the example shows
week 1 only, so as written it fails that check). A long course can be
built in one spec; keep each week's content to what the user asked for.

## plan (lesson or workshop)

```json
{
  "kind": "plan",
  "title": "Workshop Plan: Using Generative AI Responsibly in Teaching",
  "details": {"Duration": "3 hours", "Participants": "50 academic staff", "Venue": "[Venue]", "Facilitator": "[Facilitator name]"},
  "duration_minutes": 180,
  "aim": "To help academic staff use generative AI tools in teaching while protecting academic integrity.",
  "objectives": ["Explain what generative AI tools can and cannot do.", "Redesign one assessment task."],
  "objectives_intro": "By the end of the workshop, participants will be able to:",
  "introduction": ["Why the session is needed and who it is for."],
  "timetable": [
    {"time": "09:00–09:20", "activity": "Welcome and introduction", "details": "Aims; ice-breaker", "resources": "Slides"},
    {"time": "09:20–10:45", "activity": "Redesigning assessment", "details": "Group work, tables of five", "resources": "Worksheets"},
    {"time": "10:45–11:00", "activity": "Break"},
    {"time": "11:00–12:00", "activity": "Plenary and evaluation", "details": "Groups present; feedback form"}
  ],
  "resources": ["Projector", "Printed worksheets (50 copies)"],
  "assessment": ["Each group presents one redesigned task."],
  "sections": [{"heading": "Follow-up", "text": "..."}]
}
```

- Timetable columns appear when any row fills them: `time`, `minutes`, `activity`, `details`,
  `method`, `facilitator`, `resources`.
- Write times as `HH:MM–HH:MM`. The gate warns about gaps or overlaps and fails when the span (or the
  `minutes` column) differs from `duration_minutes`.
- A lesson plan uses the same fields: `details` for class, level, date and duration; `aim`;
  `objectives`; the lesson stages in `timetable`; `assessment`.
