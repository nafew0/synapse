# Plan: upgrade `@librechat/agents` (3.6.6 → 4.2.12)

Phase C3 of `model-pricing-and-cache-plan.md`. Write-up only; nothing installed or changed. Checked 2026-11-20 by
reading the published tarballs of 3.6.6, 3.9.8 and 4.2.12 (`npm pack`, unpacked in a scratch folder), the
GitHub release notes (`LibreChat-AI/agents`), and Synapse's own code. Anything not run is marked *unverified*.

## Recommendation

**Go straight to 4.2.12** (published 19 Nov 2026, `latest` tag), not 3.9.8.

- 4.0.0 is a major in name only: the 3.9.8 → 4.0.0 diff is one Bedrock reasoning fix plus a version bump
  (`gh compare v3.9.8...v4.0.0`: 2 commits, 6 files). Nothing 3.9.8 has is missing from 4.x.
- 3.9.8 is a dead end (last 3.x, 28 Sep). All later fixes (Claude 5 assistant-prefill strip, summarising the
  pruned window, checkpoint compatibility, token-limit defaults) are 4.x only.
- Upstream LibreChat `main` already pins `^4.2.12` in `api/package.json` and `packages/api/package.json`, so
  4.2.12 is what the code Synapse merges from is tested against.
- Pin exact (`4.2.12`, not `^`): the package moves several releases a week.

## What Synapse depends on

Synapse imports ~134 distinct names from `@librechat/agents` in 194 import sites (`api/`, `packages/api/src`,
`client/src`), plus subpaths `/langchain/{messages,tools,prompts,utils/env,google-common,openai,language_models/chat_models,messages/tool}`.
Heaviest: `Providers`, `GraphEvents`, `Constants`, `LCTool`, `Run`, `HookRegistry`, `SubagentTaskConfig`,
`createContentAggregator`, `StandardGraph`, `formatAgentMessages`, `InMemorySubagentTaskStore`, the Hook* and
Subagent* types, `SummarizationConfig`, `AgentInputs`, `RunConfig`.

Checked: all runtime values from that list that are exported by the 3.6.6 `main.mjs` are still exported by 3.9.8 and
4.2.12 (`AgentConstants` is not an agents export in any version, so it is local). All 8 subpaths still exist; 4.x
adds `./decisions`, `./rerank`, `./runtime`, `./llm/*`, none used by Synapse. *Unverified*: type-level
compatibility. The `dist/types` of `AgentInputs`, `SummarizationConfig`, `ContextPruningConfig`, `RunConfig`,
`StandardGraphConfig` showed no field changes in my diff, but only `tsc` settles it.

Known type change: in `types/stream.d.ts` `provider?: Providers` became `provider?: t.ProviderName` (wider). Code
that narrows on the enum may need a cast or `Providers` guard. 4.x types also use relative imports instead of the
`@/` alias, which removes a TS path-alias problem.

## The patches (every hunk)

| Patch file | Hunk | Status on 4.2.12 |
|---|---|---|
| `@librechat+agents+3.6.6.patch` | `dist/{cjs,esm}/llm/openai/index` : wraps `LibreChatOpenAICompletions._streamResponseChunks` with `dropRepeatedScalarMetadata` (new `_streamUnguardedResponseChunks`) | **Still needed, not upstream.** Upstream only calls it inside `_generate` (line 879) and the OpenRouter class. The hunk's context is byte-identical in 3.9.8 and 4.2.12; `git apply --check` of the existing patch against both unpacked packages **passes**. Only the filename must change to `+4.2.12`. Ask upstream or keep. |
| `@langchain+openai+1.5.5.patch` (top-level `node_modules`) | `converters/completions.{cjs,js}`: copy `message.images` / `delta.images` into `additional_kwargs.images` (OpenRouter image output) | **Still needed.** agents pins `@langchain/openai` **1.5.8** in 3.6.6, 3.9.8 and 4.2.12 alike; the `images` copy is not in agents' own `llm/openai` or `llm/openrouter` code (grep: 0 hits). Whether the top-level 1.5.5 copy is still used by Synapse itself: *unverified*, check with `npm ls @langchain/openai`. |
| `@librechat+agents++@langchain+openai+1.5.8.patch` (nested copy under agents) | same `images` hunk on the 1.5.8 copy | **Still needed**, same reason. Applies unchanged as long as agents keeps `@langchain/openai` at exactly 1.5.8 (true in 4.2.12). Re-check on each bump. |
| **C2 backport** (not yet in the patch file) | 3.8.9 `AgentContext` cache tail + 1-marker prefix | **Dropped by the upgrade.** Present in 4.2.12 (C1: identical in 3.8.9–4.2.12). 3.6.6's `messages/cache` already has `addTailCacheControl` and `stripAnthropicCacheControl`, so the backport is small, and so is its removal. |

Follow-up worth a PR upstream: the `images` pass-through and the stream metadata guard, so the three patches
shrink to zero.

## Behaviour changes that matter to Synapse (from release notes, 3.7.0–4.2.12)

- **Prompt cache**: 3.8.9 caches each step's newest message ("cache tool loops with dynamic instructions", "align
  compaction with provider cache prefixes", "Keep Historical Tool Result Truncation Byte-Stable Across Turns").
  Default TTL is `1h` in both 3.6.6 and 4.2.12 (`DEFAULT_PROMPT_CACHE_TTL`), so no cost-model change from TTL.
  Cache writes at 1h cost more than 5m: P1/P2 prices must include that (already in the pricing plan).
- **Summarisation**: summarisation primitives exported; empty summaries no longer loop compaction; the pruned
  window is summarised safely (4.2.0); `Run` gains fading tiers (`getFadingTier(s)`, `didResetFadingTier`) that
  hosts may persist. Synapse's `SummarizationConfig` use is a single import; *unverified* whether any stored
  summary shape changed — run the summarisation tests.
- **Tools**: tool-call projection, historical tool-result truncation, tool-output redaction scoped to tool calls,
  Stop Agent on aborted tool calls, opt-in tool result caps (4.1.0). The Office Assistant relies on long tool loops
  (kb `office-graph-recursion-limit`): the step/recursion behaviour must be re-tested.
- **Providers**: Anthropic assistant-prefill stripped for Claude 4.6+/5+ (4.0.6, 4.1.0), unlisted Claude models
  default `max_tokens` to current (4.2.0, may change the output cap: kb `quota-output-cap-ignored`), Bedrock
  reasoning replay fix, Gemini 4 input rules. OpenRouter class: scalar-metadata guard kept.
- **Run**: new `getOutputTruncated()`/`getHaltReason()` (`output_truncated`) — hosts can persist a truncated answer
  as unfinished. Not used today; optional later.
- **New opt-in surface, not used**: provider-text protection (`Run` config `providerTextProtection`, throws if
  combined with `graphConfig.providerTextProtection`), decisions, rerank, event actors, harness. Verify none is
  on by default (*unverified*: read `Run` constructor defaults).

## Dependencies

Peer/direct dependency changes 3.6.6 → 4.2.12 (from `npm view`):

- `@langchain/{core 1.2.8, openai 1.5.8, anthropic 1.5.2, langgraph 1.4.8, aws, xai, deepseek, mistralai, google-*}`:
  **identical** to 3.6.6 and 3.9.8. No langchain bump is needed. Synapse's `packages/api` asks
  `@langchain/langgraph ^1.4.5`; keep it deduped to 1.4.8.
- `peerDependencies`: `@anthropic-ai/sandbox-runtime` ^0.0.67 → **^0.0.78** (4.x). Check whether Synapse installs it.
- New/bumped in 4.x: `zod` **4.6.7** (agents' own dependency; Synapse is on `zod ^3.22.4`, so two zods coexist),
  `@langfuse/*` 5.4.1 → **6.1.1**, `@opentelemetry/sdk-node` ^0.220 → **^0.223.2**, `axios` ^1.20, `cheerio` ^1.2, plus `ws`,
  `lodash`, `jsonwebtoken`, `eventsource-parser`. Synapse has `@opentelemetry/sdk-node` at ^0.221 (api) and ^0.218
  (packages/api): expect the lockfile to dedupe or nest; no direct langfuse dependency in Synapse's package.json.
- Node `>=24` unchanged (Synapse runs Node 24).
- Zod 4 (4.2.0, "Migrate to Zod 4"): tool schemas Synapse builds with zod 3 should still work with
  `@langchain/core` 1.2.8, but this is the **top risk to test** (*unverified*).

## Tests to run

1. `npm run build` (all workspaces; type errors surface the `provider` typing and any removed type).
2. `packages/api`: `npx jest` full, then `npm run test:agents-integration` (`src/agents/*.integration.spec.ts`).
3. `api/`: `npx jest server/controllers/agents server/services` (agents client, tools, summarisation).
4. The C2 integration test (3-step agent turn with mocked OpenRouter) unchanged, with the backport removed: the
   newest message must carry `cache_control`, at most 4 markers, none without prompt cache.
5. `npx patch-package --check` equivalent: a clean `npm ci` must apply all three patches with no "version mismatch"
   warning (rename the agents patch to `@librechat+agents+4.2.12.patch`; regenerate the nested `@langchain/openai`
   patch only if the nested version differs).
6. Live local run (see `run-synapse` skill): Office Assistant Word edit, an OpenRouter image-output model, a Claude
   model via OpenRouter with prompt cache, a long chat that triggers summarisation, a tool-heavy run to the step limit,
   a cost-per-run check against the P1/P2 prices, a Langfuse trace check (kb `langfuse-doubled-model-name`).
7. Browser extension and subagent paths (`SubagentTaskConfig`, `InMemorySubagentTaskStore`, hooks) smoke test.

## Risks

1. **Zod 3 vs 4** tool schemas/token accounting across the boundary (*unverified*).
2. **Summarisation and pruning** behaviour changed in many releases; stored conversations may summarise differently.
3. **Default `max_tokens` for unlisted Claude models** can change output caps and cost.
4. **Long Office tool loops**: tool-result truncation and step handling changed; re-run the recursion-limit cases.
5. **Patches**: the stream guard and `images` hunks apply today; any later agents release that moves
   `@langchain/openai` off 1.5.8 breaks the nested patch.
6. **Langfuse 6 / OTel** dependency bumps: trace shape or exporters may differ (no Synapse code imports langfuse directly).
7. **Fast release cadence** (4.2.12 is the 12th 4.2.x in three weeks): pin exactly, upgrade deliberately.
8. **Merge debt** if the fork stays on 3.x while upstream LibreChat moved to 4.x: later upstream merges touching
   agents code assume 4.x.

## Size

About **2–3 days**: 0.5 day bump and install (three `package.json` files, lockfile, patch rename), 0.5–1 day for
build/type fixes, 1 day for tests and the live checks above, 0.5 day buffer. Do it on its own branch from
`feature/quota-plan`, after P1–P3 so price changes and agent changes are not mixed; then drop the C2 backport in the
same change.
