---
name: academic-writing
description: "For a thesis chapter, research paper, proposal, concept note, literature review, reviewer report, response to reviewers or research topic. Never invents references. Not for exams, lecture notes (teaching-materials), letters (official-correspondence)."
user-invocable: false
license: Proprietary. LICENSE.txt has complete terms
---

# Academic writing

Thesis sections, research papers, proposals, concept notes, literature reviews, journal reviewer
reports, responses to reviewers, and research topics, for university staff and PhD students. The
writing is the easy part. What this skill exists to stop is a draft that looks finished and rests on
references, numbers or novelty claims nobody can stand behind: users have caught invented references
before, and the model admitted it had "generated them from general knowledge". A wrong reference in a
thesis or a submitted paper costs the user far more than a gap they can see and fill.

> Script paths below are relative to this skill's directory.

## Pick the document type

Read the one template that matches (`read_file /mnt/data/skills/academic-writing/references/<file>`).
Each gives the sections, what goes in each, typical lengths and the reviewer complaints to avoid.

| The user wants | Template | Deliver as |
|---|---|---|
| A research paper, a paper from given papers, "finalise for a Q1 journal" | `paper-imrad.md` | Word, through the `docx` skill |
| A thesis chapter or section: introduction, literature review, research gap, methodology (3.1–3.5), results, discussion, conclusion | `thesis-chapters.md` | Word for a chapter; text in chat for one section under ~800 words |
| A literature review, a synthesis of supplied papers, a gap statement | `literature-review.md` | Word for a chapter; text in chat for a section |
| A research proposal (objectives, methodology, timeline, budget) | `proposal.md` | Word |
| A concept note for UGC, a ministry or a funder | `concept-note.md` | Word |
| A reviewer report for a journal, from its guideline or comment sheet | `reviewer-report.md` | The journal's sheet filled in if one is attached (Word through `docx`); otherwise text in chat |
| A response to reviewers, point by point | `response-to-reviewers.md` | Word (a table); text in chat for three comments or fewer |
| Refine or generate a research topic or title; check novelty; classify titles into given categories | `research-topic.md` | Text in chat |
| Polish an abstract or description "without changing my ideas" | none: see "Editing someone else's text" | Text in chat, or the user's file edited with tracked changes |

A user's own file to revise (a manuscript, a chapter) is edited in place through the `docx` skill,
keeping its styles; do not rebuild it. Short pieces (an abstract, a paragraph, one research gap,
three titles) go straight into the chat; do not make a file nobody asked for.

## Work it out, then write

Do not ask before writing. Take the journal, funder or university, the citation style, the word
limit, the required sections, the discipline and the study design from the conversation, an
attached guideline, call or sample, or the user's own draft. For the rest use the defaults: APA 7,
British spelling, the template's length range and sections, and the discipline the topic implies.
Say in one line of the reply which defaults you used. Ask only when a wrong guess means different
work, such as two attached drafts and no word on which to revise, and then only once.

## Integrity rules

These are the core of this skill. They hold even when the user asks for something "complete" or
"ready to submit".

1. **Never invent a reference, DOI, author, year, journal, page number or URL.** Cite only works the
   user supplied (attached papers, a pasted reference list) or works found with a search tool in this
   conversation whose details you saw in the result. If a `references` skill is available, use it to
   verify and format them. Nothing from memory, however well known the paper seems.
2. **Where a claim needs support you do not have, write `[citation needed: <the claim>]`** in the text
   and tell the user. That marker is the correct output, not a defect to hide.
3. **Never invent data, results, statistics, sample sizes, response rates, p-values, quotes from
   participants or budget figures.** Use the user's numbers. Where a number is missing, leave a
   visible placeholder (`[n = ...]`, `[XX%]`, `LKR [amount]`) and list it in the reply. A methodology
   chapter may describe a planned sample-size calculation; it may not state the result unless the
   user gave it.
4. **Never call the work "novel", "the first study" or "submission-ready" without stating the basis.**
   Novelty rests on a literature search: say which search, which databases or which supplied papers,
   and that it is not exhaustive. Without a search, write "to be confirmed by a literature search"
   and offer to run one. "Ready to submit" can only mean the checks listed in the reply passed.
5. **"Don't change my ideas" means edit the language only.** Keep every claim, argument, order and
   term; fix grammar, flow and clarity. List the substantive changes you made (or use tracked changes
   in a Word file). If a sentence is unclear enough that fixing it would change its meaning, ask
   rather than guess.
6. **Keep the user's terminology**, variable names, construct names and abbreviations, even where you
   would choose another word.
7. **Spelling follows the target journal or university.** Elsevier, Springer, Wiley and most UK and
   Sri Lankan universities accept British spelling; IEEE, APA journals and many US journals use
   American. Unknown: British, consistently.
8. **Extending given papers into "new research"** means a stated gap from those papers, a question,
   and a design. Do not report results for a study that has not been done.

## Editing someone else's text

Edit language, not content. Keep the argument, structure and terminology. In the reply, give a short
list of the changes that touch wording a reader might care about ("replaced 'proved' with 'showed'
because the study is correlational"), not every comma.

## Check the draft before delivering

Run the checker on the finished draft (the Word file, or a `.md` copy of text going into the chat,
written to `/mnt/data/qa/`):

```bash
python3 /mnt/data/skills/academic-writing/scripts/check_draft.py /mnt/data/output.docx
# --style apa | ieee | numeric to force the citation style; detected otherwise
```

It prints the word count under each heading, the in-text citations found, citations with no entry
in the References section, entries never cited, `[citation needed]` markers, placeholders, and
sentences that claim novelty, a first study or readiness to submit with no citation beside them.
Exit `0` is clean, `2` means issues are listed, `1` means a bad argument.

When it reports issues, fix them in one round:

- a citation with no entry: add the entry only if the work came from the user or a search in this
  conversation; otherwise replace the citation with `[citation needed: ...]`;
- an entry never cited: cite it where it supports the text, or remove it;
- an unsupported claim: add the basis (a supplied or found source), soften it, or mark it.

Never close a gap by inventing a reference. If the user's own document has the mismatch, report it
instead of fixing it silently. Word counts are for checking against the limit, not for padding.

## Final reply

- One or two lines on what was delivered and which template or defaults were used.
- **Every `[citation needed]` marker and placeholder**, listed with its section, so the user knows what
  to fill in. Say plainly when no references were added because none were supplied or found.
- The basis for any novelty statement, or that none was checked.
- For edits made "without changing ideas": the short list of substantive changes.
- No sandbox paths (`/mnt/data/...`), no narration of the steps or tool calls.

## Gotchas

- Users paste text copied from PDFs: broken hyphenation, merged words, stray line numbers. Clean them
  in the user's text without changing its meaning.
- A reviewer comment sheet or journal guideline is the structure to follow; when one is attached,
  use its headings, rating scales and recommendation categories, not the template's.
- Sinhala or Tamil output in a Word file shows empty boxes in the sandbox (no fonts). Write those in
  the chat and say so; Bangla is fine.
- Journal word limits and required sections are not known from memory either: use the guideline the
  user gave, or call a figure typical and to be checked against the journal's author guide.
