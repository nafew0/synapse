# The $5 Synapse Plan — Feature Map, Credit System, and Caps

Companion to `docs/pricing-rate-management.md`. That doc explains the billing
mechanics; this one designs one concrete product: a **$5/month plan built only
from features that exist and are enabled today**, priced against the three
providers currently in `librechat.yaml`.

Nothing here requires a new provider, a new model, or a payment gateway to
be *designed* — only the last section (self-serve top-up) is gated on payments.

---

## 1. What we are actually selling (features enabled today)

Taken from `librechat.yaml` as deployed — `modelSpecs.enforce: true`, so users
get exactly this list and nothing else.

| Capability | Where it comes from | In the $5 plan? |
|---|---|---|
| **Office Assistant** agent (default spec) | `agents` endpoint, `agent_office_assistant` | Yes |
| Chat — **ChatGPT** (`openai/gpt-5.6-luna`, OpenRouter) | `OpenRouter` endpoint | Yes |
| Chat — **Claude** (`claude-haiku-4-5`, prompt cache on) | `Claude` endpoint | Yes |
| **Image generation** (`google/gemini-3.1-flash-image`) | `OpenRouter Image` endpoint | Yes (metered, sub-capped) |
| GLM 5.2 (`z-ai/glm-5.2`, NVIDIA) | `NVIDIA` endpoint | **Exclude** — see §7 |
| Document / spreadsheet / presentation editing | agent `skills` + `execute_code` | Yes |
| File upload, OCR, **file search / RAG** | `fileSearch: true`, self-hosted `rag_api` | Yes |
| Code interpreter | self-hosted `code-interpreter/` | Yes |
| Artifacts, tools, subagents, `ask_user_question` | agent `capabilities` | Yes |
| Speech-to-text | `speech.speechTab`, browser engine | Yes (zero marginal cost) |
| Context pruning / summarization | `summarization.contextPruning` | Yes — **cost control, not a feature** |
| Presets, prompts, bookmarks, multi-convo, marketplace | disabled in `interface` | Not sold |

Two of these are self-hosted (`rag_api`, `code-interpreter`), so their marginal
cost per call is ~0 — it is fixed infra, not COGS. That is a real advantage
here: the heaviest-looking features on the list cost nothing extra per use.

---

## 2. Cost truth: the three providers

Real provider rates ($/1M tokens), per `packages/data-schemas/src/methods/tx.ts`:

| Model | Input | Output | Cache write | Cache read |
|---|---|---|---|---|
| `openai/gpt-5.6-luna` | 0.20 | 1.20 | 0.25 | 0.02 |
| `claude-haiku-4-5` | 1.00 | 5.00 | 1.25 | 0.10 |
| `x-ai/grok-imagine-image-2.0` | 0 (no text price) | **$0.01 per image** (~4,175 img tokens ⇒ ~2.395/1M) | — | — |

**Done 2026-09-07.** The image model previously matched the generic `grok`
*text* key in `tx.ts` (2 / 10) by substring. A `tokenConfig` block on the
`OpenRouter Image` endpoint now prices it explicitly, `titleConvo` is off (title
runs were generating a second billed image), and gemini/qwen are removed.

Note images are the **dearest token in the system** (~$9.58/1M when expressed per
token), which is why §5 gives them a hard per-model sub-cap.

---

## 3. What the user sees vs. what we track

**Superseded 2026-09-08.** The earlier design put a display unit ("Synapse
Credits") in front of the cost ledger. The plan is now metered in **raw tokens**,
so no abstraction layer is needed — the user-facing unit and the enforced unit
are the same thing.

| Layer | Unit | Meaning | Who sees it |
|---|---|---|---|
| **Enforcement** | **tokens** | Aggregate across all models. `usagePolicy.limits` already meters in this unit. | Users ("8.2M of 12M left") |
| **Cost ledger** | `tokenCredits` | 1 credit = $0.000001 of real provider cost. Unchanged. | Admins, margin reporting |

Both are written per request today — `Transaction.rawAmount` is the token count
and `Transaction.tokenValue` the cost — so tokens can be enforced and cost
reported from the same records, with no second ledger and no reconciliation.

Rules that still hold:

1. **`tx.ts` / `tokenConfig` rates always equal the provider's real price.** The
   rate table is a *cost* table; never bury margin in it.
2. **Margin lives in the price/allowance ratio**, not the charge.
3. The user never sees a model name attached to a price — they see a BdREN plan,
   a token balance, and the action guide in §5.

## 4. Feature priority — where the money goes

Synapse's core product is **file editing**. The budget is shaped around that,
not split evenly. Three classes:

| Class | What's in it | Budget treatment |
|---|---|---|
| **Core — document work** | Create/edit documents, spreadsheets, presentations; file upload + OCR; file search / document Q&A; code interpreter | **Uncapped within the plan pool** — gets everything the other two classes don't take |
| **Secondary — chat** | Plain conversation, quick questions, email drafting | Shares the core pool (≈1 SC/turn — rounding error) |
| **Metered — premium & images** | Claude-tier "deep" turns, image generation | **Hard monthly sub-caps** |

### The routing decision that actually creates the capacity

Document editing on `claude-haiku-4-5` costs **~30 SC** per 5-page edit.
The same edit on `openai/gpt-5.6-luna` costs **~8 SC** — output tokens are
$1.20/1M vs $5.00/1M, and the edit loop is output-heavy.

**So: run the document agent on ChatGPT by default, and escalate to Claude
only on explicit user request ("Deep edit") or on retry after a failed edit.**
That single change roughly **quadruples** how much file editing $5 buys, at
identical COGS. It is the highest-leverage item in this document — far more
than any allowance number below.

Prompt caching (`promptCache: true`) and `contextPruning` are already on and
are assumed by every figure here; both matter most on exactly the long,
repetitive file-editing sessions this plan is built around.

---

## 5. The plan — weighted tokens + a separate image allowance

**Revised 2026-09-08.** Intent:

1. **No margin.** Recover real provider cost; do not price above it.
2. **Hard walls.** Hitting a cap blocks use until that window resets.
3. **Two meters**, because the two products are billed in different units.

The purpose is to end unlimited burst usage, not to make money.

### Two meters, because the providers bill in two units

| Meter | Unit | Why |
|---|---|---|
| **Text & agent work** | weighted tokens | Providers bill per token |
| **Image generation** | **images** | Grok bills **per image** — $0.04 output, $0.01 per input (reference) image. Token count is incidental (a flat 4,175 per generation). |

Metering images in tokens was a modelling error: it forced a 20× weight to
approximate a price that is not token-based in the first place. Counting images
is both simpler and exact.

### Meter 1 — weighted tokens

Quota is **billing tokens** = `raw tokens × weight`:

| Path | Identified by | Weight | Real $/1M raw | **$/1M billing** |
|---|---|---|---|---|
| Office Assistant (agent) | `endpoint = agents` | **1×** | 0.27 | **0.27** |
| Direct ChatGPT | `endpoint = OpenAI/OpenRouter` | **1×** | 0.549 | **0.549** |
| **Direct Claude** | `endpoint = Claude` | **2×** | 1.135 | **0.568** |

All measured from the ledger. The weight collapses a 4.2× spread into 2.1×.

**Why 2× on direct Claude:** measured at $1.135/1M against direct ChatGPT's
$0.549 — a ratio of **2.07**. The 2× weight lands it at $0.568, within 4% of
ChatGPT. It is also where the burn is: **1.27M tokens direct vs 0.37M** through
the agent.

**Why the agent stays 1×:** Claude inside the Office Assistant costs $0.741/1M
but is ~5% of an agent job's tokens post-delegation-fix. Leaving it unweighted
makes the agent the cheapest path — the incentive points where you want it.

### Meter 2 — images

Counted per image. **$0.05 worst case** per image (generation $0.04 + one
reference image $0.01); a plain text→image generation is $0.04.

Generous is cheap here relative to fear: **all users combined generated 26
images in six weeks.** An allowance of 30/month is already ~7× observed
behaviour per user.

### Caps — hard walls, fixed windows

| Meter | Weekly | Monthly | On hit |
|---|---|---|---|
| Billing tokens | **3,000,000** | **12,000,000** | Text/agent models blocked until that window resets |
| Images | **10** | **30** | Image generation blocked until that window resets |

Use **fixed calendar windows, not rolling** — a hard wall needs a definite reset
instant to display ("resets Monday 00:00"). The two meters are independent: an
exhausted image allowance never blocks document work, and vice versa.

### What it costs — and therefore the price

```
Text worst case   12M × $0.568/1M   = $6.82
Images worst case 30 × $0.05        = $1.50
                                    -------
                                      $8.32
```

At cost recovery the price is the worst case. Three internally consistent
configurations:

| | Price | Tokens (wk / mo) | Images (wk / mo) | Worst-case cost |
|---|---|---|---|---|
| **A — keep the caps** | **$8.50** / ৳1,020 | 3M / 12M | 10 / 30 | $8.32 |
| **B — mid** | $7.00 / ৳840 | 2.4M / 9.5M | 10 / 30 | $6.90 |
| **C — keep $5** | $5.00 / ৳600 | 1.75M / 7M | 5 / 20 | $4.98 |

For scale: an average document job measures ~35,000 tokens, so 12M ≈ **340
document jobs/month**, 9.5M ≈ 270, 7M ≈ 200. Every user combined consumed 4.78M
tokens in six weeks, so all three sit far above observed use — the caps bite
only the outliers they exist to stop.

**Recommendation: B.** It keeps a round price, keeps images genuinely generous
(30/month against 26 observed across all users in six weeks), and still allows
~270 document jobs. A is only worth it if the round 3M/12M numbers matter more
than the price point.

### A second tier for people who need more

**Added 2026-09-10.** Some members will legitimately exceed the Office
allowance. They move to a bigger tier — **not** to an uncapped account.

| Tier | Tokens / week | Tokens / month | Images / week | Images / month | Worst-case cost |
|---|---|---|---|---|---|
| **Office** | 3,000,000 | 12,000,000 | 10 | 30 | ~$8.32 |
| **Business** *(shown as "Unlimited")* | 15,000,000 | 60,000,000 | 50 | 150 | ~$41.60 |

Business is 5x Office: ~$34 of tokens at the measured $0.568/1M worst case, plus
~$7.50 of images. At cost recovery that prices around **$42/month**.

**Why not an actual unlimited account:** a `null` limit is unbounded cost
exposure — one runaway agent loop or one compromised account can burn arbitrarily
much, with no number to alert on and no liability to size in advance. A high
ceiling is metered, reported and bounded by the same machinery as every other
tier. "Unlimited" is the label; the ceiling is real, and deliberately set to a
cost we are willing to underwrite.

The meter tells the truth when it matters: it reads "Unlimited" below 80% of the
ceiling and reveals the real remaining above it, so nobody on "Unlimited" hits a
wall unwarned.

### Known gap

The **$0.01 input-image charge has no token to hang off**, so an image *edit*
supplying a reference under-reports by $0.01 in the cost ledger. Quota is
enforced per image, so this affects reporting only, not limits. Worst case at
30 images/month is $0.30.

---

## 6. Implementation plan

Ordered by dependency. Steps 1–3 are the launch-blocking set.

### Step 1 — Make cost truth accurate (blocking, ~1h)
- Add the `tokenConfig` block from §2 for `google/gemini-3.1-flash-image`.
- Add `tokenConfig` for `z-ai/glm-5.2` (currently `defaultRate = 6/6`) even if
  it is excluded from the plan, so shadow reporting isn't polluted.
- Add a `getValueKey` assertion per model to
  `packages/data-schemas/src/methods/tx.spec.ts`; run
  `cd packages/data-schemas && npx jest tx.spec.ts`.

### Step 2 — Define the usage policy (config, ~1h)
Enforcement is `UsagePolicy`, not `Balance`: the caps are token limits, and
`policy.limits` already carries `memberTokens` and `modelTokens`. Seed a
version-2 policy per tenant with:

```
mode:   enforce            # currently 'shadow' — see config/migrate-usage-policies.js
period: rolling_week + calendar_month   (see Step 5)
limits:
  memberTokens: 12_000_000          # monthly, WEIGHTED (see §5 meter 1)
  memberTokensWeekly: 3_000_000     # new window
  memberImages: 30                  # monthly, meter 2 (count, not tokens)
  memberImagesWeekly: 10
```

`Balance` / `creditPackages` remain the **money** side (what was paid, by whom)
and are unchanged; they are no longer the enforcement mechanism.

### Step 3 — Show tokens remaining, not raw credits (frontend, ~2h)
Three call sites render the cost ledger today:
- `client/src/components/Nav/AccountSettings.tsx:157`
- `client/src/components/Nav/Settings/BillingControls.tsx:19`
- `client/src/components/Nav/SettingsTabs/Balance/TokenCreditsItem.tsx:22`

Replace with **tokens remaining against the weekly and monthly caps** ("8.2M of
12M this month · 1.4M of 3M this week"), sourced from the usage buckets rather
than `Balance`. Add localized keys (`com_ui_tokens_remaining`,
`com_ui_weekly_allowance`, `com_ui_cap_reached_weekly`, …) to
`client/src/locales/en/translation.json`.

### Step 4 — Route document work to ChatGPT — **DONE 2026-09-06**
Per §4 this is worth more than every allowance decision combined. Change the
`agent_office_assistant` model to `openai/gpt-5.6-luna`, and expose escalation
to `claude-haiku-4-5` as an explicit user action ("Deep edit") plus an
automatic retry path when an edit fails validation. Keep `promptCache` and
`contextPruning` on — the plan's numbers assume both.

### Step 5 — Calendar-week window + weighted accounting (backend, ~2 days)
The reservation infrastructure already exists and is the right home:
`api/server/services/usageQuota.js` (`reserveUsage` / `settleUsage` /
`releaseUsage`) over `packages/data-schemas/src/schema/usageBucket.ts` and
`usageReservation.ts`. Model-scoped sub-caps (§5) already work via
`policy.limits.modelTokens` + `getModelLimit` — **nothing to build there**.

What is missing is only the **window**: `usagePolicy.period` is
`enum: ['calendar_month']`, and `getCalendarMonthRange` is the only range
builder.

- Extend the enum to `['calendar_month', 'calendar_week']`. Fixed windows, not
  rolling — a hard wall needs a definite reset instant to display.
- `getCalendarWeekRange` mirrors the existing `getCalendarMonthRange`
  (`usageQuota.js:106`), same `{ periodStart, periodEnd }` shape, so
  `loadBucket`/`reserveBucket` need no change.
- **Apply the §5 weight before reserving.** The weight is a function of the
  request `endpoint`, which is known at reservation time (`Conversation.endpoint`
  confirms the split: `Claude` = direct, `agents` = Office Assistant).
  `providerKey` does NOT discriminate — both report `anthropic`.
- Add `getRollingWindowRange(unit, timeZone, now)` beside
  `getCalendarMonthRange`, returning the same `{ periodStart, periodEnd }`
  shape so `loadBucket` / `reserveBucket` need no change.
- Weekly rollover: carry unused capacity forward, clamped to `1 × weeklyCap`.
- Reserve against **all active windows in a single pass** inside the existing
  `buildScopes` loop — do not add a round trip per window.
- New backend code goes in `packages/api` (TypeScript); keep `usageQuota.js` a
  thin caller, per the workspace boundaries.
- Return a typed denial (`WEEKLY_CAP`, `MONTHLY_CAP`, `IMAGE_WEEKLY_CAP`,
  `IMAGE_MONTHLY_CAP`) carrying the window's reset instant.
- **The image meter is a second bucket, not a `modelTokens` entry** — it counts
  requests, not tokens. `UsageReservation.usageUnit` already has an `'images'`
  value; reserve 1 unit per image request against the image bucket and skip the
  token bucket entirely for that endpoint.

### Step 5b — Hard wall (backend, ~0.5 day)
No degradation ladder. On a cap denial, block every model and return the typed
code plus the **reset instant** for that window, so the UI can say
*"Weekly limit reached — resets Monday 00:00 (in 2 days 14 hours)."*
This is simpler than the earlier degradation design and is what the product
actually wants: stop the burst.

### Step 6 — Margin reporting (~1 day, post-launch)
No dashboard exists. Build a single aggregation over `Transaction` grouped by
`tenantId` / model / period producing `creditsConsumed`, `COGS = credits ×
1e-6`, revenue from `CreditGrant`, and `grossMargin`. This is what converts the
70% design assumption into a measured number.

---

## 7. Decisions and open items

- **GLM 5.2 excluded.** It is unpriced (`defaultRate`), served via NVIDIA, and
  adds a fourth cost profile for no product benefit at this price point.
  Include it only after Step 1 gives it a real rate.
- **Claude Sonnet 5 stays off.** It is in the `Claude` endpoint's model list but
  not exposed via `modelSpecs`. At 2/10 it is 2x Haiku; adding it at $5 would
  cut worst-case margin from 70% to roughly 40%. If it is wanted, gate it
  behind a higher tier, not this one.
- **Prompt caching is a margin lever, not a nicety.** Cache reads are ~10x
  cheaper than fresh input on both models (Claude 0.10 vs 1.00; ChatGPT 0.02 vs
  0.20). Every figure here assumes `promptCache: true` and `contextPruning`
  (both already on). Turning either off materially changes §5's margin —
  and file editing, with its long repeated context, is where it bites hardest.
- **The 5-hour window alone does not pace anything.** If the weekly layer is
  dropped, a user can still drain the month in under two days (§5). Either ship
  both windows or accept single-day exhaustion as a deliberate choice.
- **Landed COGS not included.** Numbers are raw inference only — no infra
  allocation for `rag_api`, `code-interpreter`, storage, or FX spread. Expect
  the real margin a few points below 70%.
- **FX at 120 BDT/USD.** Margin scales roughly linearly; re-check the ৳600
  price if the rate moves materially.
- **Self-serve top-up is gated on payments.** No gateway (bKash / Nagad /
  SSLCommerz) is wired in. When one is: a **300 SC booster for ৳180** ($1.50,
  COGS $0.30, 80% margin) reuses the existing `creditPackages` / `CreditGrant`
  flow with no new mechanism. Until then, top-ups stay admin-granted.
