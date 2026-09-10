# Implementation Plan — Weighted Quota, Two Meters, Split Reporting

Companion to `docs/plan-5-dollar.md` (which sets the numbers) and
`docs/agent-cost-optimization.md` (which sets the agent topology). This document
is the build order.

**Goal:** end unlimited burst usage with hard weekly/monthly walls, recover real
provider cost, and keep cost reporting honest at three different audiences.

---

## 0. The invariant everything else depends on

Get this wrong and the reporting requirement becomes impossible to satisfy later.

| Store | Contains | Weighted? | Audience |
|---|---|---|---|
| **`Transaction`** | real provider cost + raw tokens | **NEVER** | Superadmin, margin reporting |
| **`UsageBucket`** | quota consumption | **YES** (2× direct Claude) | Enforcement, institution-admin quota view |
| **Langfuse** | raw provider `usage_metadata` | **NEVER** | Engineering |

**The weight is a billing construct, not a cost construct.** It must never touch
`tx.ts`, `tokenConfig`, `Transaction`, or anything Langfuse sees. Applying it in
exactly one place — the quota reservation — is what lets superadmin and Langfuse
show unmultiplied truth while institutional admins see what the user's plan
actually charged.

Langfuse needs **no work at all**: LibreChat forwards raw `usage_metadata` and
sends no cost, so it is unweighted by construction.

---

## 1. Scope decisions (settled)

| Decision | Value |
|---|---|
| Image generation path | **Both.** Office Assistant (needs Phase 4 attribution) and the standalone Image spec (attributed at reserve time). |
| Weights | Office Assistant 1× · Direct ChatGPT 1× · **Direct Claude 2×** |
| Meters | Meter 1 = weighted tokens · Meter 2 = image count |
| Windows | Week + month, **anchored per member** to their join date (Phase 3b); institution/model scopes stay calendar |
| Reset timezone | **UTC** — the international standard. Every tenant turns over at the same instant; `policy.timezone` governs display and emails only. |
| On cap | **Hard wall** until that window resets. No degradation ladder. |
| Margin | None. Cost recovery only. |
| Capacity beyond the default | A higher **tier** with a real ceiling, presented as "Unlimited". Never a `null` limit. |

Weight identification is by **request endpoint**, which `reserveUsage` already
receives as `provider` (`api/app/clients/BaseClient.js:786`).
`Transaction.providerKey` does **not** work — direct Claude and agent Claude both
report `anthropic`.

---

## 2. What already exists (do not rebuild)

Verified in the codebase:

- `reserveUsage` / `settleUsage` / `releaseUsage` — `api/server/services/usageQuota.js`
- Called from `BaseClient.sendMessage:783`; **`AgentClient extends BaseClient` and
  calls `super.sendMessage()`**, so agent runs and direct chat both reserve today.
- `provider` (the endpoint) is already passed into the reservation.
- `UsageBucket`, `UsageReservation`, `UsagePolicy`, `UsageWarning` schemas.
- Idempotent reservation keys, expiry TTL, reconciliation, warning emails.
- Institutional usage reporting over `Transaction` —
  `api/server/services/institutionUsage.js` (summary / members / models /
  timeseries / CSV) behind `api/server/routes/admin/usage.js`.
- `Transaction.usageUnit` already has an `'images'` enum value.
- `mode: 'shadow' | 'enforce'` on `UsagePolicy` — shadow-first rollout is supported.

---

## 3. Phases

### Phase 1 — Cost truth (prerequisite) — ~1h, mostly DONE

Every number downstream assumes the rate table is real.

- [x] `tokenConfig` for `x-ai/grok-imagine-image-2.0` — `prompt: 0`,
      `completion: 9.581` ($0.04 ÷ 4,175 image tokens), `context: 65536`.
      Without it the model matched the generic `grok` **text** key (2/10).
- [x] `titleConvo: false` on `OpenRouter Image` — title runs were generating a
      second **billed** image.
- [ ] ~~Remove the direct image modelSpec~~ — **deferred by decision
      2026-09-08.** The standalone Image Generation spec stays for now. Note the
      consequence: images generated through it reserve under
      `provider = 'OpenRouter Image'` and hit the image meter directly (correct),
      while images via the Office Assistant need Phase 4's settle-time
      attribution. Both paths must therefore work.
- [ ] Add a `getValueKey` / `tokenConfig` assertion to
      `packages/api/src/endpoints/pricing.spec.ts`.

**Known gap, accepted:** the $0.01 input-image charge has no token to hang off,
so an image *edit* supplying a reference under-reports by $0.01 in `Transaction`.
Reporting only — quota counts images. ≤$0.30/month at 30 images.

### Phase 2 — Schema — **DONE 2026-09-08**

Implemented in `packages/data-schemas/src/{schema,types}/`:

1. **`usagePolicy.ts`**
   - `period` enum → `['calendar_month', 'calendar_week']`
   - `limits.memberTokensWeekly: Number`
   - `limits.memberImages: Number`, `limits.memberImagesWeekly: Number`
2. **`usageBucket.ts`**
   - `scopeType` enum → add `'member_images'`
   - Reuse `usedTokens`/`reservedTokens` as the counter. **Do not add a `unit`
     field** — it would belong in the unique index `usage_bucket_scope_period`,
     forcing an index migration on a live collection. `scopeType` is already part
     of that key. Add a JSDoc line saying the counter holds images for this scope.
3. **`usageReservation.ts`**
   - `weight` (default 1) — recorded so a settled reservation can be audited
     and un-weighted later.
   - `unit: 'tokens' | 'images'`
   - **`scopes[]`** (added during implementation, not foreseen in the plan): a
     request now spans several windows, so the bucket a settlement must return
     capacity to can no longer be derived from a single `periodStart`. Readers
     fall back to the legacy institution/member/model triple when it is empty,
     so reservations in flight during deploy still settle correctly.
   - All are new *fields*, not index members — no migration needed.

`period` became an **array** (`['calendar_month','calendar_week']`). Safe: it was
written in two places and never read for behaviour before this change.

### Phase 3 — Quota engine — **DONE 2026-09-08**

`api/server/services/usageQuota.js`, with new logic in **`packages/api`
(TypeScript)** per the workspace rules; keep the JS file a thin caller.

1. **`getCalendarWeekRange(timeZone, now)`** beside `getCalendarMonthRange`
   (`usageQuota.js:106`). Same `{ periodStart, periodEnd }` shape, so
   `loadBucket` / `reserveBucket` need no change.

   **Reset semantics — the weekly allowance resets in full at each week
   boundary.** Monday 00:00 **UTC**, no rollover and no carry-over
   of unused tokens. A new week writes a **new bucket** (the unique index is
   `{tenantId, periodStart, scopeType, scopeKey}`), so the reset needs no job and
   no mutation — the old bucket simply stops being the current period. This is
   also why fixed windows beat rolling ones here: a hard wall needs a definite
   reset instant to show the user, and a rolling window never fully resets.
2. **`weightFor(provider)`** → `2` when the endpoint is the direct `Claude`
   endpoint, else `1`.
3. **`unitFor(provider)`** → `'images'` for the image endpoint, else `'tokens'`.
4. In `reserveUsage`:
   - `reservedTokens = ceil(rawReserved × weight)` for the token unit.
   - Reserve against **all active windows in one pass** inside the existing
     `buildScopes` loop — no extra round trip per window.
   - Persist `weight` and `unit` on the reservation.
5. In `settleUsage`: apply the reservation's stored `weight` to `actualTokens`
   before writing the bucket. Read the weight from the reservation, never
   recompute it — the policy may have changed mid-flight.

**Do not** apply the weight in `spendTokens` / `recordCollectedUsage`.
`Transaction` stays raw (§0).

**Implemented as:** `packages/api/src/usage/weights.ts` (`weightFor`, `unitFor`,
`toBillingTokens` — pure, no DB), with `usageQuota.js` as the caller.
`getCalendarWeekRange` / `getPolicyRanges` sit beside `getCalendarMonthRange`.
`BaseClient.js` now passes `endpoint` into `reserveUsage` alongside `provider`,
because `provider` collapses direct Claude and agent Claude to `anthropic`.

Two things the plan did not anticipate:
- The **output-cap machinery had to be bypassed for images.** It trims a token
  budget to fit the remaining allowance; an image is indivisible, so capping its
  "output tokens" denied every request whose token estimate exceeded the image
  allowance (a 3-image limit rejected a 4,175-token generation).
- **Weekday must come from the local calendar date, not the UTC instant.** East
  of UTC, local midnight falls on the previous UTC day, which shifted the week
  boundary by a day.

**Tests:** `packages/api/src/usage/weights.spec.ts` (11) and 8 new cases in
`api/server/services/usageQuota.integration.spec.js` against a real replica set,
covering both windows, the 2x weight, weight-stability across a mid-request
policy edit, the image meter's independence from the token meter, weekly
exhaustion with monthly room remaining, and `null` = unlimited-but-recorded.
`usageQuota.spec.js` covers week boundaries incl. a DST week that is 167 hours.

### Phase 3b — Per-member anchored billing periods — ~1.5 days

**Added 2026-09-10. This revises shipped Phase 3 behaviour.** Windows are
currently **calendar** — everyone resets on the 1st and on Mondays. A member who
joins on the 15th therefore gets a half-length first month, and their reset falls
on the same day as someone who joined on the 1st.

Required instead: a member joining mid-month runs **15th → 15th**, and their
reset dates differ from everyone else's.

#### What this buys, and what it costs

Anchoring removes the need to pro-rate: the first period is a full period, so a
member gets what they paid for regardless of join date. The cost is that
`periodStart` stops being a shared constant and becomes a per-member value.

#### Only member-scoped meters may be anchored

This is the constraint that shapes the whole design. Buckets are keyed on
`(tenantId, periodStart, scopeType, scopeKey)`:

| Scope | Window | Why |
|---|---|---|
| `member`, `member_images` | **per-member anchor** | The bucket is already per-member; a per-member `periodStart` is just another dimension of the same row. |
| `institution`, `model` | **calendar, unchanged** | These buckets are **shared across members.** Anchoring them would give each member a different `periodStart`, silently fragmenting one institution bucket into one per member — the institution cap would stop being an institution cap while still appearing to work. |

Anchoring institution scope is not a smaller version of this feature. It is a
correctness bug that hides itself.

#### The anchor

New `User.billingAnchorAt: Date`, set once at enrolment and **immutable
thereafter** — a moving anchor would let a member reset their own allowance.

- Backfill existing members from `InstitutionInvite.acceptedAt`, falling back to
  `User.createdAt` (verified equal for invited users on live data).
- A member with no anchor falls back to calendar windows, so nothing breaks
  before the backfill runs.
- If you prefer to bill from first use rather than enrolment, set the anchor at
  the first metered request instead — the field and every consumer stay the same.
  On live data these differ by up to a week, and some accepted members have never
  used the product at all.

#### Window arithmetic

`getAnchoredMonthRange(anchorAt, now)` and `getAnchoredWeekRange(anchorAt, now)`
join `getCalendarMonthRange` / `getCalendarWeekRange`, same
`{ start, end }` shape, so `loadBucket` / `reserveBucket` need no change.

- **Monthly**: period runs from the anchor's day-of-month to the same day next
  month. **Clamp short months** — an anchor on the 31st gives 28/29 February.
- **Always derive from the ORIGINAL anchor day, never from the clamped date.**
  Re-deriving from the clamp walks the anchor backwards permanently: 31 → Feb 28
  → Mar 28 → … Anchor day 31 must return to 31 in March.
- **Weekly**: anchored to the anchor's weekday, not Monday. A Wednesday joiner
  resets Wednesdays.
- UTC throughout, as with the calendar windows.

#### Cutover

Members mid-period when this ships hold a calendar bucket that the anchored
window does not match. Simplest correct rule: **the first anchored period begins
at the cutover instant**, making it short — the member is not charged twice for
overlapping days, and every period after it is full length. Note it in the
release notes; a shortened first period is easier to explain than a doubled one.

#### Consequences to check

- `computePeriodTotals` matches on `{ tenantId, periodStart }`. It still works —
  it is already keyed by period — but there are now many more distinct
  `periodStart` values per tenant. Confirm the reconciliation sweep enumerates
  them rather than assuming one current period.
- `getQuotaHealth` queries `periodStart: { $in: [...] }` for the tenant's current
  windows; with anchoring there is no single tenant-wide "current" member window.
  It must resolve per member, or report institution/model scopes only.
- A **tier change mid-period keeps the anchor** and swaps the limits. Restarting
  the window on an upgrade would hand out a free extra period.

#### Acceptance

1. A member anchored on the 15th has `periodStart` on the 15th and `periodEnd` on
   the 15th of the next month.
2. A member anchored on the 31st gets 28 Feb in a non-leap year and **31 Mar**
   after it — the anchor does not drift.
3. Two members with different anchors have different `resetsAt` for the same
   meter, and neither can consume the other's allowance.
4. The `institution` bucket still has **one** row per calendar period regardless
   of how many differently-anchored members wrote to it.
5. A member with no `billingAnchorAt` still gets calendar windows.

### Phase 4 — Image attribution from the Office Assistant — **DONE 2026-09-08**

The hard part, and the reason Phase 3 alone is not enough.

**Problem:** the reservation is made once per user message, keyed on the
top-level endpoint (`agents`), *before* any subagent runs. An image generated by
`agent_office_images` therefore lands on the **token** meter as ~4,175 tokens
(≈$0.001) instead of the **image** meter (≈$0.04).

**Fix — settle-time attribution.** The per-model breakdown already exists:
`AgentClient.collectedUsage` (`api/server/controllers/agents/client.js:210`,
passed to `recordCollectedUsage` at `:2381`).

1. Extend the `settleUsage({ tenantId, reservationKey, usage })` contract to take
   an optional `perModel` breakdown. Today it collapses everything into one
   `actualTokens` (`usageQuota.js:565-570`).
2. At settlement, partition `collectedUsage` by model:
   - rows on the image model → `imageCount` (count of generations, not tokens)
   - everything else → weighted tokens
3. Settle **two** buckets from one reservation: decrement the token bucket by the
   text portion and the image bucket by `imageCount`.
4. Pre-flight check stays on the token meter (the image count is unknown until
   the run completes); the image bucket is checked at the *start* of the next
   request. A user can therefore overshoot the image cap by at most one
   generation — acceptable at $0.04, and worth stating in the plan rather than
   engineering around.

**Implemented as:**
- `splitImageUsage()` / `isImageModel()` in `packages/api/src/usage/weights.ts`
  partition one run's `collectedUsage` into text rows and an image count. Model
  id is the only identifier that survives into `collectedUsage`, so detection is
  pattern-based — **keep the pattern list in step with the image models exposed
  in `librechat.yaml`**; a missed entry silently meters an image as ~4,175
  tokens (~$0.001) instead of one image (~$0.04).
- `AgentClient.getQuotaUsage()` now excludes image rows, and a new
  `getQuotaImageCount()` reports them. `BaseClient` passes `images` into the
  settlement through the hook that already existed for `getQuotaUsage`.
- `consumeSettledImages()` in `usageQuota.js` takes image capacity *after the
  fact*, since none was reserved. Idempotent via `imagesSettled` on the
  reservation, so a replayed settlement cannot double-count.
- A generation that produced **no output** is not counted: the provider does not
  bill a refused or failed generation, so neither do we.

**Acceptance — met:** one Office Assistant request producing an image decrements
both image buckets by exactly 1 and adds only the text tokens to the token
buckets. Covered by 4 integration tests (attribution, replay idempotency, no-image
run, accepted single-run overshoot) and 6 unit tests.

### Phase 5 — Hard wall + reset UX — **DONE 2026-09-08**

1. Typed denials from `reserveUsage`: `WEEKLY_CAP`, `MONTHLY_CAP`,
   `IMAGE_WEEKLY_CAP`, `IMAGE_MONTHLY_CAP`, each carrying the window's
   **reset instant**.
2. Block **all** models on a token-cap denial. The two meters are independent: an
   exhausted image allowance must not block document work, and vice versa.
3. Frontend — replace the three cost-ledger render sites:
   - `client/src/components/Nav/AccountSettings.tsx:157`
   - `client/src/components/Nav/Settings/BillingControls.tsx:19`
   - `client/src/components/Nav/SettingsTabs/Balance/TokenCreditsItem.tsx:22`

   Show remaining against both meters and both windows, e.g.
   *"8.2M of 12M this month · 1.4M of 3M this week · 22 of 30 images"*.
4. Localized keys in `client/src/locales/en/translation.json` only:
   `com_ui_tokens_remaining`, `com_ui_images_remaining`,
   `com_ui_cap_reached_weekly`, `com_ui_cap_reached_monthly`,
   `com_ui_cap_resets_in`.
5. Wall copy must name the reset:
   *"Weekly limit reached — resets Monday 00:00 (in 2 days 14 hours)."*

**The refusal message needed a JSON envelope, not prose.** A denial first
surfaced in chat as *"Something went wrong. Here's the specific error message we
encountered: Token quota exceeded"* — the generic wrapper, with no reset time.
Two things caused it, and both had to be fixed:
- `handleAbortError` (`api/server/middleware/abortMiddleware.js:270`) forwards
  `error.message` to the client **only when it contains `"type"`**; anything else
  becomes a generic apology.
- The client's renderer (`client/src/components/Messages/Content/Error.tsx`) keys
  its localized copy off `json.code || json.type`, so the message has to be JSON.

So `QuotaError.message` is now a JSON envelope carrying `type`, `limitCode`,
`window`, `meter` and `resetAt` — **display fields only, never the institution's
limits**, which a member should not see. `ErrorTypes.TOKEN_QUOTA_EXCEEDED` was
added to data-provider, and `Error.tsx` renders a titled two-line message naming
the exhausted allowance and the absolute reset date. `error.details` keeps the
full record for logs.

Copy decisions: the reset is an **absolute local date-time**, not "in 2 days" —
a relative phrase goes stale as the message sits in the conversation. Images get
their own wording ending *"Everything else still works"*, because an exhausted
image allowance must not read as everything having stopped. If no reset instant
is known the message falls back to generic copy rather than rendering a sentence
with a blank where the date belongs. 7 tests cover it.

**Implemented as:**
- `resolveLimitCode()` in `usageQuota.js` adds `limitCode`
  (`WEEKLY_CAP` / `MONTHLY_CAP` / `IMAGE_WEEKLY_CAP` / `IMAGE_MONTHLY_CAP` /
  `MODEL_CAP` / `INSTITUTION_CAP`), `window`, `meter` and the **exhausted
  window's own** `resetAt` to every denial, at both the pre-flight and the
  atomic-reserve sites.
- **`code` deliberately stays `TOKEN_QUOTA_EXCEEDED`.** `FAIL_CLOSED_QUOTA_CODES`
  and existing callers branch on it, and a refusal they do not recognise would be
  treated as an availability blip and let the request through. `limitCode`
  narrows the same refusal for display; it does not replace it. A test asserts
  the wall still reports as an enforcement denial.
- **`GET /api/quota`** (`api/server/routes/quota.js` → `getMemberQuota()`):
  the caller's own remaining allowance on both meters and both windows. Scoped
  to `req.user` — it never accepts a user id — and reads only the current
  windows, so it cannot be walked backwards into a usage-history API.
- Data-provider: `TQuotaResponse` / `TQuotaMeterState` types, `quota()` endpoint,
  `getUserQuota()`, `QueryKeys.quota`, and a `useGetUserQuota` hook that refetches
  on focus so a wall hit in another tab is visible before the next send.
- `UsageQuotaItem.tsx` renders remaining per meter, weekly before monthly
  (the window that blocks first is the one to see first), with the reset instant
  and an "unlimited" state for an override. `TokenCredits` shows it when a usage
  policy applies and falls back to the credit ledger otherwise — **the two are
  never shown together**, since one is weighted billing tokens and the other is
  real cost.
- 13 localized keys added to `en/translation.json` **in place**, without
  reordering the file.

**Gap found after the fact:** the only billing row in the settings registry was
gated on `ctx.balanceEnabled`, which is `false` on a usage plan
(`librechat.yaml` sets `balance.enabled: false`) — so the quota panel rendered
nowhere. Fixed by adding a `quotaEnabled` flag to the settings context (derived
from the quota endpoint returning meters, since it 204s for a member with no
policy) and a dedicated `usageQuota` registry row. The two rows are **mutually
exclusive by construction** — `tokenCredits` now requires
`balanceEnabled && !quotaEnabled` — because weighted billing tokens and real
cost are different units, and showing both would present two disagreeing numbers
with no way to tell which one blocks a request. Four registry tests pin it.

### Phase 6 — Plan tiers, and a Business tier called "Unlimited" — ~1 day

**Revised 2026-09-10.** The earlier design granted a `null` limit — genuinely
uncapped. Replaced, because:

- **A `null` limit is unbounded cost exposure.** One runaway agent loop or one
  compromised account can burn arbitrarily much, and nothing in the system stops
  it. There is no number to alert on, no ceiling to reason about, and no way to
  size the liability in advance.
- **A high limit is still a limit.** It is metered, reported, alerted on, and
  bounded — the same machinery as every other plan, with no special case.

So there is no "unlimited" state. There is a **Business tier with a high
ceiling**, which is *presented* as unlimited. That is what "unlimited" means at
almost every SaaS: a fair-use ceiling nobody normally reaches.

`null` survives in the engine — shadow mode relies on it — but it is **never
assignable to a customer.**

#### Plan catalogue, not free-form numbers

Superadmins assign a **named tier**, not arbitrary limits. Limits then come from
one reviewed table rather than whatever a hurried admin typed at 2am, which keeps
them auditable, consistent between tenants, and costable in advance.

| Tier | Tokens / week | Tokens / month | Images / week | Images / month | Worst-case cost |
|---|---|---|---|---|---|
| `office` | 3,000,000 | 12,000,000 | 10 | 30 | ~$8.32 |
| `business` *(shown as "Unlimited")* | 15,000,000 | 60,000,000 | 50 | 150 | ~$41.60 |

Business is 5x Office. At the measured $0.568/1M worst-case billing rate that is
~$34 of tokens plus ~$7.50 of images. **Size the tier to a cost you are willing
to underwrite** — that number is the whole point of not using `null`.

#### Schema — `packages/data-schemas/src/schema/usageAssignment.ts`

```
tenantId    : String, indexed
scopeType   : 'institution' | 'member'
scopeKey    : String            # tenantId, or userId
tier        : String            # a key from the catalogue — NOT raw numbers
reason      : String, required  # forces a written justification
grantedBy   : ObjectId -> User
expiresAt   : Date | null       # null = until revoked
```

Index `{ tenantId, scopeType, scopeKey, expiresAt }`.

Storing the **tier key** rather than the numbers means a later change to what
Business includes applies to everyone on it, instead of leaving each grant frozen
at the numbers in force the day it was made.

Expiry stays **optional** here, unlike the override design: a paid tier is a
standing arrangement, not an escape hatch. Set it for a trial.

#### Request-path cost: zero extra reads

`getActivePolicy` already reads `Institution` + `UsagePolicy` per request. Do
**not** add a third read (see CLAUDE.md — serial reads on the request path).

Denormalise the active tier onto the user document —
`user.usageTier = { tier, expiresAt }` — so the request path reads it for free
from the already-loaded `req.user`. `UsageAssignment` remains the auditable
record; the User field is a cache written on grant/revoke/expiry.

*Verify `req.user` actually carries the field; if the JWT strategy projects a
subset, add it there.*

#### Enforcement

In `buildScopes` (`usageQuota.js:184`), resolve limits from the assigned tier
rather than the policy defaults when an active, unexpired assignment matches.
The scopes, buckets, windows and denial codes are **unchanged** — a Business
member simply has larger numbers. Nothing new can deny, and nothing new can fail
to deny.

An institution-scoped assignment applies to every member of that tenant. Member
scope is the narrower, preferred grant.

#### Presenting it as "Unlimited"

The label is a product decision; the meter stays honest.

- **Show "Unlimited"** in place of a remaining count while consumption is below
  **80%** of the tier ceiling. Nobody wants a counter they will never reach.
- **Reveal the real numbers above 80%.** A user on "Unlimited" who hits a wall
  with no warning is the worst outcome of this design, and the one thing the
  label must not cause.
- The refusal message (Phase 5) is unchanged — it already names the window and
  the reset.

#### API and permission

- New capability **`MANAGE_USAGE: 'manage:usage'`** in
  `packages/data-schemas/src/admin/capabilities.ts` — only `READ_USAGE` exists
  today. Grant it to the platform/superadmin role **only**; institution admins
  must not be able to raise their own tenant's tier.
- Routes on `api/server/routes/admin/usage.js`, behind `requireCapability(MANAGE_USAGE)`:
  - `GET    /api/admin/usage/tiers` — the catalogue
  - `POST   /api/admin/usage/assignments` — assign (scope, key, tier, reason, expiresAt)
  - `GET    /api/admin/usage/assignments` — list active + expired
  - `DELETE /api/admin/usage/assignments/:id` — revoke, returning the scope to its default tier
- Write an entry via the existing `packages/api/src/admin/auditLog.ts` on every
  assignment, change and revoke. Reason and grantee must appear in the log.

#### Permission boundary — strict

| Action | Superadmin | Institution admin |
|---|---|---|
| Assign / change / revoke a tier | **yes** | **no — 403** |
| See the assignment list / audit log | yes | no |
| See a member's remaining quota | yes | **yes (view only)** |

The endpoints are not merely hidden from the institution admin UI — they **reject
with 403** at the route, because the caller lacks `MANAGE_USAGE`.

A Business member shows as **"Business"** in the institution admin's view, so a
member who never hits a wall is not a mystery, without exposing who granted it or
why.

#### Acceptance

1. A Business member passes 12,000,000 billing tokens without being denied, and
   **is** denied at 60,000,000 — the ceiling is real.
2. Their `Transaction` and `UsageBucket` rows are written throughout and appear
   in both reporting surfaces.
3. The user-facing meter reads "Unlimited" below 80% and shows real remaining
   above it.
4. When `expiresAt` passes, the next request is enforced at the default tier with
   no intervention.
5. An institution admin calling the assignment endpoints gets **403**.
6. **No code path can assign a `null` limit to a customer.** `null` remains
   reachable only for shadow mode.

### Phase 7 — Split reporting — ~1 day

The requirement: **Langfuse and superadmin see actual, unmultiplied usage and
real cost. Institution admins see quota only — tokens used against the limit,
and nothing else.**

| Surface | Source | Shows |
|---|---|---|
| Langfuse | OTEL `usage_metadata` | raw tokens — **no change needed** |
| **Superadmin** (`synapse-admin`) | `Transaction` + `UsageBucket` | actual tokens, **real cost**, per-model, timeseries, CSV, override audit |
| **Institution admin** | `UsageBucket` only | **billing tokens used / limit / remaining / resets.** No cost, no per-model, no history. View only. |

#### Why the institution admin view is narrow

Deliberate, not an omission:

- **Quotas are per member, not a shared tenant pool.** No member can starve
  another, so there is nothing for an admin to arbitrate — which is the usual
  reason such a role needs consumption detail.
- **Per-member consumption history is employee monitoring.** In an academic
  setting that is surveillance the institution did not ask for. *Remaining
  quota* is current state and answers a support question; *history* is a
  behavioural record and answers nothing they can act on.
- **Cost figures are our economics.** Even at cost recovery, a $ column exposes
  provider rates. An institution admin has no use for it.

#### Show billing tokens only — never both

The institution admin sees **billing tokens** (the weighted, enforced number),
never raw tokens beside them. If a member used 5M raw but the meter reads
"8.2M of 12M" because direct Claude counts double, showing both makes
*remaining* ambiguous — and the admin cannot act on the difference anyway.

One line of copy carries the explanation:
*"Claude used directly counts double toward your limit."*

#### The view

Per member, and the same shape for the tenant total:

| | Used | Limit | Remaining | Resets |
|---|---|---|---|---|
| Tokens, this week | 1.4M | 3M | 1.6M | Mon 00:00 |
| Tokens, this month | 8.2M | 12M | 3.8M | 1 Oct |
| Images, this month | 8 | 30 | 22 | 1 Oct |

Sourced from `UsageBucket` for the current windows only — no historical range
query. An overridden member (Phase 6) shows **"Unlimited"** in place of the
limit, with no grant details.

#### Implementation — gate, do not delete

`institutionUsage.js` already implements summary / members / models / timeseries
/ CSV over `Transaction`, and `synapse-admin` calls the **same**
`/api/admin/usage/*` routes (`synapse-admin/src/server/usage.test.ts:50`). Do not
remove that work — **re-gate it**, so restoring detail for institution admins is
later a one-line capability change rather than a rebuild.

1. Add capability **`READ_USAGE_DETAIL: 'read:usage_detail'`** to
   `packages/data-schemas/src/admin/capabilities.ts`. Grant to superadmin only.
2. In `api/server/routes/admin/usage.js`, move the existing detail routes —
   `/summary`, `/members`, `/models`, `/timeseries`, `/export.csv` — from
   `requireReadUsage` to `requireCapability(READ_USAGE_DETAIL)`. Their handlers
   and `institutionUsage.js` are unchanged.
3. Add **`GET /api/admin/usage/quota`** behind the existing `READ_USAGE`, reading
   `UsageBucket` for the current week/month windows and returning only:
   `{ scope, billingTokensUsed, tokenLimit, tokensRemaining, resetsAt,
      imagesUsed, imageLimit, imagesRemaining, unlimited }`.
   **No cost field. No per-model field. No date-range parameter** — current
   windows only, so the endpoint cannot be walked backwards into a history API.
4. Superadmin additionally gets `billingTokens` / `weightApplied` /
   `tier` on the detail routes, so it can reconcile enforced quota
   against real cost. Its existing unweighted fields stay exactly as they are —
   that is what keeps superadmin agreeing with Langfuse and the provider.
5. Institution admin UI renders only the table above. No override controls, no
   policy editing, no cap changes: everything that mutates quota is behind
   `MANAGE_USAGE` (Phase 6) and superadmin-only.

**Acceptance:**
1. Superadmin totals and Langfuse totals match the provider's own numbers for a
   tenant whose users ran direct Claude.
2. An institution admin calling `/members`, `/models`, `/timeseries` or
   `/export.csv` gets **403**.
3. `/quota` returns no cost field and no per-model field, and rejects any
   date-range parameter.
4. An institution admin cannot reach any endpoint that changes quota (403).
5. After a week boundary passes, the weekly remaining figure returns to the full
   allowance with no job having run.

### Phase 8 — Rollout — ~0.5 day + 1 week soak

1. Seed a v2 `UsagePolicy` per tenant with `mode: 'shadow'`
   (`config/migrate-usage-policies.js` is the existing harness):
   ```
   period: [calendar_month, calendar_week]
   limits:
     memberTokens:        12_000_000     # weighted
     memberTokensWeekly:   3_000_000
     memberImages:                30
     memberImagesWeekly:          10
   ```
2. Run **shadow for one week.** `getShadowReadiness` (`usageQuota.js:1001`)
   already exists and requires ≥7 days and ≥1,000 calls.
3. Review the real per-user distribution. Current aggregate is **4.78M tokens
   across all users in six weeks** and **26 images**, so almost nobody should hit
   a wall. If many do, the caps are wrong — not the users.
   Anyone who genuinely needs more moves to the **Business** tier (Phase 6),
   which is a bigger number rather than no number.
4. Flip `mode: 'enforce'`. Note `mode` is `immutable` on the schema, so this is a
   **new policy version**, not an update.
5. Keep margin/consumption reporting (Phase 6) running from day one.

---

## 4. Effort

| Phase | Effort |
|---|---|
| 1 — Cost truth | ~1h (mostly done) |
| 2 — Schema | 0.5 day |
| 3 — Quota engine | 1.5 days |
| 3b — Per-member anchored windows | 1.5 days |
| 4 — Image attribution | 1 day |
| 5 — Hard wall + UX | 1 day |
| 6 — Plan tiers + Business tier | 1 day |
| 7 — Split reporting | 1 day |
| 8 — Rollout | 0.5 day + 1 week soak |
| **Total** | **~8 days + soak** |

## 5. Risks

1. **Weight leaking into cost.** The single biggest correctness risk. If the
   weight ever reaches `Transaction`, superadmin and Langfuse stop agreeing with
   the provider and the error is invisible. Mitigate with a test asserting that a
   direct-Claude request writes `Transaction.rawAmount` equal to the provider's
   raw token count.
2. **Image overshoot by one generation** (Phase 4). Accepted at $0.04.
3. **Weekly window boundary.** Users near a boundary can spend 3M on Sunday and
   3M on Monday. That is inherent to fixed windows and is the price of a definite
   reset time; the monthly cap bounds the month regardless.
4. **Overrides becoming permanent.** An unlimited grant with no expiry is a
   silent, unbounded cost hole. Default `expiresAt` to 30 days, require a written
   `reason`, and review the active-override list as part of monthly reporting.
5. **Shadow mode masking bugs.** Shadow records but never denies, so a
   miscalculated weight looks fine until enforcement. Compare shadow bucket totals
   against `Transaction` totals × expected weight before flipping.
