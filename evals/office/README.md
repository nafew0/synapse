# Office Assistant evaluation

Runs a set of office tasks against one or more **variants** of the Office Assistant (agent
prompts, skills, models), grades every delivered file, has a judge model score the work, and
writes a report comparing the variants. Nobody needs to watch it: the harness starts its own
server on a throwaway database, answers clarifying questions itself, and cleans up afterwards.

```bash
npm run eval:office                                  # every case × every variant
npm run eval:office -- --cases smoke-* --repeat 3    # pass rates over 3 attempts
npm run eval:office -- --variants prod,single --no-judge
npm run eval:office -- --list                        # what would run
```

The run ends with a leaderboard in the terminal and writes `out/<run id>/report.html` (open it in a
browser) and `report.json`. Each run's files, renders and raw messages are kept under
`out/<run id>/runs/<variant>/<case>-<attempt>/`.

## Requirements

- A **built** app checkout (`npm run build`). By default the harness runs the checkout it lives in;
  `--app PATH` points it at another one.
- MongoDB on `127.0.0.1:27017` as a replica set (the repo's `chat-mongodb` container).
- The real `.env` of the main checkout for secrets (`OPENROUTER_KEY`, JWT secrets, code sandbox).
  The harness never writes to it, and overrides the database, port, domains and Langfuse.

### Code sandbox

Code runs on the **production sandbox** (`LIBRECHAT_CODE_BASEURL` in the main `.env`,
`https://interpreter.bdren.ai/v1`), so every run tests the sandbox's latest deployed code. Eval
sessions and files are keyed by the `eval-office` tenant (sandbox session key
`eval-office:user:<id>`), so they never mix with real users' files, but they share production's
sandbox capacity: keep `--concurrency` low (default 2) during working hours. `--sandbox URL` points
a run at another sandbox. The report header names the sandbox each run used.
- [`uv`](https://docs.astral.sh/uv/) to inspect files: Python packages are fetched into uv's cache,
  nothing is installed globally.
- Optional: LibreOffice (`brew install --cask libreoffice`, or set `SOFFICE`) to render
  docx/pptx/xlsx pages for the report and the judge. Without it PDFs and images still render, and
  office files are judged from their extracted structure and text alone.

Each run spends real model, sandbox and judge budget.

## How a run works

1. Drops and recreates the database (`SynapseEvalOffice`), seeding an institution, an admin and
   one member account per `--concurrency` slot.
2. For every variant, writes its agent manifest with ids suffixed by the variant id
   (`agent_eval_<id>`, `agent_office_images_<id>`, …) and creates the agents with
   `config/sync-office-agents.js`, so all variants live side by side.
3. Writes an eval copy of `librechat.yaml` with one enforced model spec per variant, cloned from
   the Office Assistant's, so requests take the same path as production.
4. Starts the server on port 3190, once per distinct skills directory, and runs the jobs
   (case × variant × attempt) through the real chat API: uploads, chat, polling,
   `ask_user_question` answers, follow-up turns, downloads.
5. Grades each run, asks the judge, totals token cost from the `transactions` collection, collects
   new lines from the server error log, and writes the report.

## Cases

One YAML file per case in `cases/`, with inputs in `fixtures/`. The id is the file name.

```yaml
title: Edit a styled Word policy
category: docx                 # groups cases in the report; also selectable with --cases
repeat: 1                      # attempts per variant (--repeat overrides)
timeout_seconds: 900           # per turn
attach: [fixtures/leave-policy.docx]
prompt: Change the title to "Leave Policy 2027" and …
expect: { … }                  # checks on the reply to the (last) turn
rubric: Sections 1-4 must be unchanged …   # extra instructions for the judge
min_score: 3                   # judge score needed to pass (1-5)
answers: ["Formal", "English"] # replies to ask_user_question, used in order
on_question: first_option      # with no scripted answer: pick the first option, or `fail`
```

Several turns in one conversation use `turns`, each with its own `prompt`, `attach` and `expect`.
A top-level `expect` applies to the last turn.

```yaml
turns:
  - prompt: Write a notice … Deliver the .docx.
    expect: { files: { count: 1 } }
  - prompt: Change the date to 19 November 2026.
    attach: [fixtures/letterhead.png]
```

### `expect`

| Key | Meaning |
|---|---|
| `files.count` / `files.min` / `files.max` | number of delivered files |
| `files.items[]` | one entry per expected file, matched by `ext` / `name` (regex) |
| `  contains` / `not_contains` | text in the file (case- and whitespace-insensitive) |
| `  slides`, `min_slides`, `max_slides` | pptx slide count |
| `  min_pages`, `max_pages` | pdf page count |
| `  sheets`, `min_formulas`, `no_errors` | xlsx sheet names, formula count; error cells and unrecalculated formulas fail unless `no_errors: false` |
| `  fonts`, `min_images` | fonts used, embedded images |
| `  min_width`, `min_height` | generated image size (blank images always fail) |
| `  keeps_text_from`, `keeps_ratio` | for edits: share of the fixture's paragraphs still present (default 0.8) |
| `skills` | skills that must be loaded (SKILL.md `name`) |
| `tools.include` / `tools.exclude` / `tools.max_calls` | tool usage |
| `handoff` / `no_handoff` | specialists (manifest ids) the master must, or must not, hand off to |
| `asks` | `true`: must ask a clarifying question; `false`: must not |
| `reply.contains` / `not_contains` / `language` (`bn`, `en`) / `min_chars` | the chat reply |
| `max_seconds` | turn duration |

Every run also gets the health checks: the turn finished, there is no error in the reply, no known
sandbox failure appears in a tool output, delivered files download and open, and the reply shows
no sandbox path. A run **passes** when every check passes and the judge score is at least
`min_score`.

## Variants

One YAML file per variant in `variants/`. The id (file name) may use `[a-z0-9_]`, up to 16
characters. Paths are relative to the variant file. `app:` paths resolve against the app checkout.

```yaml
label: Single agent on Claude Sonnet
manifest: manifests/single-agent.yaml   # agent manifest to start from (default app:config/phase-one-office-agents.yaml)
skills: skills-v2                       # deployment skills directory (default app:skill)
master:                                 # overrides for the Office Assistant
  model: anthropic/claude-sonnet-5.5
  model_parameters: {}
  instructions_file: prompts/master-v2.md   # replaces the instructions
  # instructions_append: "Always …"         # or adds to them
  # tools: [ask_user_question, execute_code, file_search]
specialists:                            # overrides per specialist, by manifest id
  agent_office_images:
    model: google/gemini-3.1-flash-image
drop_specialists: [agent_office_mail]
```

To try a prompt change, copy a manifest into `variants/manifests/`, edit it, and point a variant
at it. To try a skill change, copy `skill/` to a folder next to the variants, edit the SKILL.md
files, and set `skills:` to it. Variants with different skills directories run on separate server
starts, because the server loads skills at startup.

Included variants: `prod` (what production runs) and `single` (the single-agent manifest from
`feat/single-agent-office`).

## Baselines and regressions

`--accept` saves the run's per-case pass rates and judge scores to `baseline.json`. Later runs
compare against it and list regressions: a pass rate that dropped by a third or more, or a mean
judge score that dropped by a point or more. The exit code is 1 when there are regressions (or,
with `--strict`, when any run failed), so the command can gate a merge.

## Re-grading without chatting

`npm run eval:office -- --regrade evals/office/out/<run id>` re-inspects the files an earlier run
saved and grades them against the current case files, without sending a single chat. Use it after
changing a case's `expect` or `min_score`. The judge's verdicts are kept; add `--rejudge` to score
again (judge cost only).

## Remote mode

`EVAL_EMAIL=… EVAL_PASSWORD=… npm run eval:office -- --remote https://staging.example` runs the
cases against a deployed instance as that account, testing whatever Office Assistant is deployed
there. It skips variants and cost totals, which need the database.
