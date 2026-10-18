# Quota plan: remaining implementation

Branch: `feature/quota-plan` in synapse and in synapse-admin. Written 2026-10-18.

This plan finishes the money-based package system. A package gives a member or an
institution a monthly allowance in taka at provider cost, converted to dollar credits, with a
weekly cap as a percentage of the month. Both the member and the institution have a monthly
and a weekly cap. A request is refused when any of them runs out.

Companion documents: `docs/usage-limits-implementation.md` (the September token-based plan this
replaces in part) and `docs/synapse-ai-pricing-calculator.xlsx` (package sizing).

**Assumes the single-model Office Assistant.** This plan is written for the Office Assistant on
branch `feat/single-agent-office` (`5dafcde22`, kb `decisions/2026-10-07-single-agent-office-assistant.md`).
`agent_office_assistant` runs one model, `openai/gpt-5.6-luna`, and chooses the docx, xlsx, pptx and
pdf skills itself. Its only handoff is image generation to `agent_office_images` on the OpenRouter
Image endpoint. The old Claude router and the four text specialists are gone. So:

- An Office Assistant request is priced at one known model when it is reserved, like a direct chat.
- The only cost not known at reserve time is an image from the image handoff (about $0.034 to
  $0.067 each).
- That branch ships **before** this one is enforced (phase 7), so the shadow week measures the
  model setup that will actually be billed.

---

## 0. Where things stand

| Built | Where |
|---|---|
| Weekly and monthly windows, typed refusals (`WEEKLY_CAP`, `MONTHLY_CAP`, ...) with the reset instant, refusal persisted in the thread | `api/server/services/usageQuota.js`, `packages/api/src/usage/denials.ts` |
| Member and institution scopes; institution is monthly only | `buildScopes`, `usageQuota.js:299` |
| `GET /api/quota` and the settings panel showing remaining allowance | `api/server/routes/quota.js`, `client/src/components/Nav/SettingsTabs/Balance/UsageQuotaItem.tsx` |
| Package catalogue and BDT pricing, superadmin API, audit | `packages/api/src/usage/packages.ts`, `/api/platform/usage-packages` |
| Packages page | synapse-admin `src/components/packages/` |

Nothing assigns a package to anyone, and the engine still meters **weighted tokens**
(`weightFor` 2× for direct Claude, `usageQuota.js:475`) plus a separate image count. Until
phases 1 to 3 land, packages do not limit anyone.

## Progress

| Phase | State | Commit |
|---|---|---|
| 1 Rate table | Done. Also fixed Claude Haiku 4.5, which fell back to `claude-` (0.8/2.4, 100K context). | `b0bcbad3d` |
| 2 Credit meter | Done, with the differences below | `2bc11a1f5` |
| 3 Package limits, institution weekly cap, assignment API | Done | `2bc11a1f5` |
| 4 Admin assignment screens | Institution and user pickers done (synapse-admin `fa0510b`; API field `4d68083af`). Institution usage panel shows the credit pool and members in taka (synapse-admin `1eac6fc`, API `4b22a624f`). Standalone invite dialog still picks a yaml credit package: waits on the individuals decision (phase 6). | `1eac6fc` |
| 5 User display | Done: settings panel in taka with bars, Unlimited below 80%, institution pool shown only when used up | `5796aadfd` |
| 6 Retire old systems | Done. The production copy (2026-10-07) had 0 institution packages, 0 assignments, 0 credit grants. Removed `InstitutionPackage`, `packageAssignment`, yaml `creditPackages`, `CreditGrant` and the grant routes; invites carry a usage package. | `e8f486216`, `4b763c4c5` |
| 6b Individuals | Done. Users outside any institution are metered under the `__individuals__` quota account (not an institution): a trial package by default, their own package when assigned, no shared pool, platform staff exempt. Admin page `/individuals`. Billing records are planned in `docs/billing-records-plan.md`. | `781cab2ba`, `0f77b3845`; admin `f622183`, `4f82df9` |
| 7 Rollout | Rebased onto bdren-prod on 2026-10-18 (`2365379dd`). Waits on `feat/single-agent-office`. | |

**In-app test, 2026-10-18** (local backend + synapse-admin on the `SynapseQuotaTest` database, a
member on a ৳0.50/month package): packages, pricing and assignments worked through both the API and the
admin UI, with audit entries; wrong-scope assignments were refused (400) and members were refused the
admin API (403); every settled reservation matched its `Transaction` credits; the weekly wall refused
with "You've used this week's allowance … Resets Mon, Oct 19, 6:00 AM"; a member override lifted the
wall at once. Four bugs found and fixed (`c5052dcc0`, `1438f474a`): a header crash on trimmed
requests (latent on bdren-prod), the output cap never reaching the model, the input estimate missing
the instructions, and the live notice and saved refusal losing their details or thread.
Titles and activity labels were metered afterwards (`2d974d433`).

**Second in-app test, 2026-10-18** (`SynapseRunTest`, member on a ৳3/month package, ৳1.05 a week):
an Image Generation request was refused before any provider call (no Transaction, no reservation);
a text chat then went through and reply 204.8 + title 50 credits matched the member meter (255);
the admin Usage & limits tab showed ৳0.03 of ৳350 / ৳1,000 for the pool and the member against
৳1.05 / ৳3; the package picker showed `$0.0085/week` instead of `$0.00`; the message navigation
labelled saved refusals "Image limit reached". Found and fixed:

- Changing a usage policy answered 500 after saving it: the audit action
  `institution.usage_policy_changed` was missing from the enum. **Also on bdren-prod** (`04b7ab881`).
- An image the allowance could not cover was refused as "You've used this week's allowance"; it is
  now `IMAGE_CREDITS_LOW`, "Not enough of your allowance is left for an image" (`f9a0d7588`).
- Title and label charges counted as 100% underestimates in the shadow gate (19.6% overage after one
  chat; the gate needs < 0.5%), so a credit tenant could never pass it (`f8075dc71`).
- The message navigation used a generic title for every refusal (`f15c73917`).

Note for rollout: once a tenant has any policy version, switching to `enforce` requires the shadow
gate (`QUOTA_SHADOW_GATE_NOT_MET`, 409); only the very first policy (version 0 → 1) can be `enforce`
directly.

**Differences from this plan, as built:**

- **Credits and tokens side by side.** A request is metered in credits only when its institution
  or member has a package (`usesCredits`). Tenants without one keep the token policy unchanged,
  so tenants move over as packages are assigned. Phase 6 removes the token path.
- **Image pre-check** (`525ba4e71`). A request on the image endpoint is reserved as one whole image
  (500 input + 1,120 output tokens at the image model's rates) and never trimmed; it is refused with
  `IMAGE_CREDITS_LOW` when the allowance cannot cover it. On the Office Assistant, `applyQuotaToRun`
  drops the image hand-off for that run when the remaining credits are below one image, and tells
  the agent images are unavailable.
- **Auth.** Assignment routes use `requirePlatformSuperadmin`, like every other `/api/platform`
  route, instead of a new `MANAGE_USAGE` capability. Institution admins cannot reach them.
- **Rates come from the client.** `AgentClient.getQuotaPricingContext()` prices the agent's model
  with `getMultiplier` and passes `{ model, endpoint, rates }` to `reserveUsage`, so the quota
  engine does not load the data-layer methods.
- **Not metered:** Firecrawl per-call fees (left out for now).
- **DeepSeek V4 Flash** is priced at OpenRouter's listing on 2026-10-18 (0.10/0.30, cache read
  0.03), which changed during the day from 0.0075/1.28.

## 1. Decisions

Defaults chosen so work can start. Each can be changed before the phase that depends on it.

| Decision | Default | Why |
|---|---|---|
| Unit of the meter | **Credits**: 1 credit = $0.000001, the unit of `Transaction.tokenValue` | Real cost. No per-model weight, and images are charged at their real price. |
| Month and week boundaries | **Calendar**, as today: month starts on the 1st, week on Monday, in the institution's timezone | Already built and tested. Per-member join-date anchoring (`usage-limits-implementation.md` Phase 3b) can follow without changing the meter. |
| Where a member's limit comes from | The member's own package, else the institution's default member package, else no member limit | Lets an institution put all members on one package and still upgrade individuals. |
| Where the institution's limit comes from | The institution's package (scope `institution`) | Its own pooled budget, as decided on 2026-10-17. |
| "Unlimited" | A package with a high real ceiling and `unlimited: true` for display | No `null` limit is assignable to a customer. |
| Who can assign | Platform superadmin only (`MANAGE_USAGE`) | Institution admins must not raise their own tenant's limits. |
| Promotional discounts | **Workbook only** in this plan | Discounts change what the customer pays, not the allowance. Recording a discounted price on an assignment is a billing feature for later. |
| Rollout | Shadow mode for one week, then enforce | `UsagePolicy.mode` already supports it. |

## 2. Phases

Each phase ends green: tests pass, `packages/api` and `client` type-check, lint is clean.

### Phase 1: Fix the rate table (prerequisite, small)

Credits are only as right as the prices behind them. Two models are under-charged today
(OpenRouter list prices, 2026-10-18):

| Model | Charged now | Real |
|---|---|---|
| `deepseek/deepseek-v4-flash-0731` | input 0.14, output 0.28 (`tx.ts:202`, key `deepseek-v4-flash`) | input 0.0075, output 1.28, cache read 0.0075 |
| `google/gemini-3.8-flash` | 0.75 / 3.75 (`librechat.yaml` tokenConfig) | 0.825 / 4.125, cache read 0.0825, cache write 0.0417 |

- Add a `tokenConfig` entry for the DeepSeek id on the OpenRouter endpoint, and correct the Gemini entry. Prefer `librechat.yaml` over editing `tx.ts`, which is shared with upstream.
- Confirm or remove `x-ai/grok-imagine-image-2.0`. It is no longer listed on OpenRouter.
- Test: extend `packages/api/src/endpoints/pricing.spec.ts` so each served model resolves to its own rate key and not a family fallback (the same trap as kb `issues/2026-09-22-claude-dotted-model-names.md`).

### Phase 2: Meter in credits

**Goal:** buckets count credits. A reservation holds the estimated cost, and settlement
replaces it with the actual cost.

1. **Separate credit scopes.** Add `member_credits` and `institution_credits` to
   `UsageBucket.scopeType` (`packages/data-schemas/src/schema/usageBucket.ts`). Reuse
   `usedTokens`/`reservedTokens` as the counters, documented as credits for these scopes. New
   scope types keep this month's token buckets from mixing with credits, and need no
   migration. Add `unit: 'credits'` to `UsageReservation.unit`.
2. **Pricing in `packages/api`** (new `packages/api/src/usage/credits.ts`, pure functions):
   - `estimateCredits({ inputTokens, outputTokens, model, endpoint, endpointTokenConfig, pricing })`
     uses `getMultiplier` / `getCacheMultiplier` (data-schemas `tx.ts`), the same functions
     `Transaction` uses.
   - `settledCredits(collectedUsage, pricing, endpointTokenConfig)` sums
     `computeUsageCostUSD` (`packages/api/src/agents/usage.ts:176`) per call × 1e6. Every
     call is priced at its own model, so an Office Assistant run that used Claude and GPT, or
     generated an image, is charged exactly. This replaces `splitImageUsage` for metering.
   - `outputTokensForCredits(remainingCredits, outputRate)` converts the remaining allowance
     to an output-token cap, so the existing output-cap logic still trims an over-long request
     instead of refusing it.
3. **Engine (`usageQuota.js`, kept a thin caller):**
   - `reserveUsage` reserves `estimateCredits(input × safety factor, output cap)` against the
     credit scopes, priced at the request's own model. For the Office Assistant, that is the
     agent's model (`gpt-5.6-luna`), read from the agent record that `BaseClient` already has
     (`this.options.agent.model`), not from the `agents` endpoint name.
   - **Image handoff.** The image is not known at reserve time. Before the handoff runs, check
     that the remaining allowance covers one image at the image model's price (new
     `canAffordImage` check on the handoff path), and refuse the image with
     `IMAGE_NEEDS_ALLOWANCE` if not, while the text answer still goes through. Settlement then
     charges the image's real cost. This bounds the overshoot to zero for images.
   - Skill and sandbox calls (`execute_code`) cost no tokens, and the sandbox is self-hosted, so
     neither is metered. Firecrawl calls are an external per-call cost that `Transaction` does
     not record. They are left unmetered here (see section 4).
   - `settleUsage` takes `credits` from the client (new `getQuotaCredits()` on `AgentClient`
     and `BaseClient`, beside `getQuotaUsage`) and writes it to the bucket.
   - Remove the weight (`weightFor`, `toBillingTokens`) and the separate image meter from the
     request path. Keep reading legacy token reservations, so ones in flight during deploy
     still settle.
4. **Late usage.** With the single-model assistant, the image handoff is the only child run. If
   its usage can be reported after the parent settles (`createDetachedSubagentUsageRecorder`),
   settle it as a second, idempotent increment keyed on the reservation and the child run id.
   Otherwise remove the code path from the quota flow. Check which one applies on
   `feat/single-agent-office` before writing it.

**Tests** (`api/server/services/usageQuota.integration.spec.js`, real replica set):
- A request's settled credits equal the sum of the `Transaction.tokenValue` rows it wrote.
- An Office Assistant run reserves at `gpt-5.6-luna` prices and settles its text at that price
  and its image at the image model's price.
- An Office Assistant run with too little allowance left for an image returns the text answer
  and refuses only the image.
- Reservation over-estimate is returned. A request cut short by the output cap never exceeds
  the remaining allowance by more than one call.
- Legacy token reservations still settle after the change.

### Phase 3: Package-driven limits, and the institution weekly cap

**Goal:** the limits come from assigned packages, with no extra database read per request.

1. **Assignment fields** (data-schemas):
   - `Institution.usagePackage = { packageKey, memberPackageKey, assignedAt, assignedBy }`:
     the institution's own package and the default for its members. This replaces
     `packageAssignment`, which belongs to the old `InstitutionPackage`.
   - `User.usagePackage = { packageKey, assignedAt, assignedBy, expiresAt }`. Check that the
     JWT strategy's `getUserById` projection (`api/strategies/jwtStrategy.js:38`) returns it.
     It excludes only secrets today.
   - Store the **key**, not the numbers. Editing a package on the Packages page then applies
     to everyone on it.
2. **Limit resolution** (`packages/api/src/usage/limits.ts`, pure):
   `resolveCreditLimits({ institution, user, packages, pricing })` returns
   `{ institution: { month, week }, member: { month, week }, unlimited }` in credits, using
   `priceUsagePackage` (`packages/api/src/usage/packages.ts`). An expired member assignment
   falls back to the institution default.
3. **Load without extra round trips.** `getActivePolicy` already reads the `Institution`
   (`usageQuota.js:238`). The member assignment comes from `req.user`. Packages and pricing
   are few, platform-wide rows: cache them in memory and invalidate when the package API
   writes. Pass the user's assignment into `reserveUsage` from `BaseClient.js:784`, which
   already has `this.options.req.user`.
4. **Scopes.** In `buildScopes`, emit `institution_credits` for both month and **week**, and
   `member_credits` for month and week. Keep the per-model token scope for now; it is unused
   by packages. Map denials to the existing limit codes, and add `INSTITUTION_WEEKLY_CAP`
   (client copy in `QuotaNotice.tsx`).
5. **Assignment API** (superadmin only, `requireCapability(MANAGE_USAGE)`; add the capability
   to `packages/data-schemas/src/admin/capabilities.ts`):
   - `PUT /api/platform/institutions/:tenantId/usage-package` with `{ packageKey, memberPackageKey }`
   - `PUT /api/platform/users/:userId/usage-package` with `{ packageKey, expiresAt? }`
   - `DELETE` on both, to revoke.
   - Reject a package whose `scopes` do not include the target, or that is archived. Write a
     fail-closed audit entry (`platform.usage_package_assigned` / `_revoked`) on every change.
6. **Quota view.** `getMemberQuota` and `GET /api/quota` return credits as both a percentage
   used and ৳ remaining, plus `unlimited`. For an unlimited package, show "Unlimited" below 80%
   used and the real remaining amount above it.

**Tests:**
- Member and institution limits from packages. A member package overrides the institution
  default.
- An institution weekly cap refuses everyone in the tenant, with `INSTITUTION_WEEKLY_CAP` and
  the Monday reset.
- An archived or wrong-scope package cannot be assigned (400). An institution admin gets 403.
- Editing a package's allowance changes the next request's limit with no restart.
- An expired member assignment falls back.
- Assignment adds no database read per request: spy on `Institution.findOne`, `User.findById`
  and `UsagePackage.find`.

### Phase 4: Admin assignment screens (synapse-admin)

1. Institution detail page: an **Institution package** picker and a **Default member package**
   picker, showing the ৳ allowance and weekly cap of each choice.
2. User detail page: a **Member package** picker with an optional expiry, and a "using
   institution default" state.
3. Invite dialogs (`InviteIndividualUserDialog.tsx`, institution invites): choose a usage
   package instead of the yaml `creditPackages` list.
4. Institution quota panel (`InstitutionDetailPage.tsx`, tested in
   `__tests__/InstitutionModelQuota.test.tsx`): show credits used against the package limits,
   week and month, instead of token limits per model.
5. Tests per component, using the Packages page tests as the pattern
   (`src/components/packages/__tests__/PackagesPage.test.tsx`).

### Phase 5: User-facing display (client)

1. `UsageQuotaItem.tsx`: show this week and this month as a bar with % used, ৳ remaining and
   the reset time. Unlimited packages follow the 80% rule.
2. `QuotaNotice.tsx`: the copy names the exhausted allowance (yours or your institution's,
   weekly or monthly), with the absolute reset time. Remove the image-meter wording.
3. Update the English keys in `client/src/locales/en/translation.json` only. Tests in
   `__tests__/UsageQuotaItem.spec.tsx` and `QuotaError.spec.tsx`.

### Phase 6: Retire the old package systems

Only after phases 3 and 4 have shipped.

- Remove `InstitutionPackage` (model, schema, `api/server/routes/platform/institutionPackages.js`,
  its use in `api/server/routes/platform/institutions.js:309` and `:499`) and
  `Institution.packageAssignment`. First check production for documents in the collection;
  carry any over to `usagePackage`.
- Remove `creditPackages` from `librechat.yaml` and its readers (12 call sites in `api/server`,
  including `admin/billing.js`, `platform/users.js` and `institutionMembers.js`), together with
  the credit-grant flow, unless top-up billing is wanted later.
- Remove the per-model token policy editor in synapse-admin if nothing uses token limits.

### Phase 7: Rollout

1. Ship the single-model Office Assistant first: merge `feat/single-agent-office` to
   `bdren-prod`, run `node config/sync-office-agents.js --apply`, and reload. Then rebase
   `feature/quota-plan` onto `bdren-prod` (2 commits behind on 2026-10-18), rebuild and boot
   (kb `issues/2026-09-19-merge-duplicate-declaration.md`). Merge synapse-admin
   `feat/admin-redesign` too; the Packages page is built on it.
2. Create the packages from `docs/synapse-ai-pricing-calculator.xlsx` and save the pricing
   (exchange rate, top-up fee). Assign packages to every institution and set a default member
   package.
3. Turn on a `mode: 'shadow'` policy per tenant: usage is recorded but nothing is refused.
   `getShadowReadiness` requires 7 days and 1,000 calls.
4. After a week, compare: settled credits against `Transaction.tokenValue` per tenant (they
   should match within rounding), and the real per-member distribution against the workbook's
   light, moderate and heavy profiles. Adjust package sizes if many members would have hit a
   wall.
5. Switch to `mode: 'enforce'`. `mode` is immutable, so this is a new policy version. Announce
   the reset times in the release notes.

## 3. Order and effort

| Phase | Depends on | Effort |
|---|---|---|
| 1 Rate table | — | 0.5 day |
| 2 Credit meter | 1 | 1.5 days |
| 3 Package limits and institution weekly cap | 2 | 2 days |
| 4 Admin assignment screens | 3 | 1.5 days |
| 5 User display | 3 | 1 day |
| 6 Retire old systems | 3, 4 | 0.5 day |
| 7 Rollout | all | 0.5 day + 1 week shadow |
| **Total** | | **about 7.5 days + 1 week shadow** |

Phases 4 and 5 can run in parallel once phase 3 is merged. The credit meter is half a day
shorter than it would be with the router, because a request is priced at one known model and
only the image handoff needs special handling.

**Pricing workbook.** `docs/synapse-ai-pricing-calculator.xlsx` still models the Office
Assistant as Claude Haiku plus GPT specialists (Components sheet). Change those rows to
`gpt-5.6-luna` only before sizing packages; it lowers the cost of document, spreadsheet and
presentation tasks.

## 4. Risks

1. **Order of releases.** This plan assumes the single-model Office Assistant. Enforcing credits
   while the old router (Claude in front of GPT specialists) is still live would under-reserve
   every Office Assistant request, because the reservation would be priced at the agent's model
   only. Mitigation: ship `feat/single-agent-office` first (phase 7, step 1).
2. **Firecrawl and other per-call tool fees** are real costs outside the token meter. Measure
   them during shadow week. If they matter, charge a fixed number of credits per call.
3. **A wrong rate leaks free usage.** A model missing from the rate table falls back to a cheap
   family default. Mitigation: the phase 1 test fails when a served model has no exact rate.
4. **Detached subagent usage** can arrive after settlement (phase 2, step 4).
5. **Exchange-rate edits reprice everyone at once.** A rate change shrinks or grows every
   dollar allowance immediately. Every change is audited; announce changes before making
   them.
6. **Cache staleness.** Package and pricing caches must be invalidated on every write and
   across processes (Redis or a short TTL), or an edit takes effect on only one server.
