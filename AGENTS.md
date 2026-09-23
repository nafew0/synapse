See CLAUDE.md.

## Knowledge base (`kb/`)

`kb/` at the repo root is a local, git-ignored record of every bug, production error, decision and
gotcha. It is shared by all branches and worktrees, and it is the project's memory of mistakes
already made. If the directory is absent (a fresh clone), skip this section.

- **Before debugging**, search it and start from any matching root cause:
  `grep -ril "<error text or symbol>" kb/issues kb/gotchas kb/decisions`. `kb/INDEX.md` lists
  everything in one line each.
- **After fixing a bug, a failing test, a config mistake or a production error**, write an entry in
  `kb/issues/YYYY-MM-DD-slug.md` before finishing. Decisions go in `kb/decisions/`, non-obvious
  behaviour in `kb/gotchas/`. One file per root cause; update an existing entry rather than adding a
  near-duplicate, and add or update its one-line entry in `kb/INDEX.md`.
- Use the template in `kb/README.md`. Keep the evidence: exact error text, trace ids, failing test
  names, log lines, repro steps, root cause with `file:line`, the fix, tests added, `commits:`, and a
  **Lesson** line saying how to avoid a repeat. List touched paths in `files:` and key functions in
  `symbols:`, then run `python3 kb/tools/sync.py` to link the entry to the code graph.
- `kb/PENDING.md` (written by a git hook) lists fix commits that still have no entry — clear a line
  by writing its entry with that sha in `commits:`, not by deleting the line. `kb/deploys.md` records
  what was pushed to `bdren-prod`; both files are generated, so do not hand-edit them.
- Never `git add kb/`, and never put secrets or personal user data in it.

## Frontend theming and styling

For frontend work, compose existing `@librechat/client` primitives and variants before adding
feature-local styles. Use semantic theme/Tailwind roles for color and shared appearance; do not
introduce raw palette utilities, hard-coded colors, or arbitrary theme CSS. If the system cannot
express a reusable design need, deepen the shared primitive or versioned theme-token registry
instead of copying classes into a feature. Keep genuine layout and behavior local, and document
why any new custom CSS cannot be expressed by the shared system. See the detailed policy in
`CLAUDE.md` under “Theming and styling.”

When adding or changing code that mutates user documents, invalidate the auth user document cache for affected users. This includes single-user updates and bulk role/user mutations; otherwise OpenID JWT request burst caching can serve a stale `req.user` until its TTL expires.
