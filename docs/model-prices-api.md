# Model prices API (for the Model prices tab, P3b)

Base: `/api/platform/model-prices`. Every route needs a logged-in **platform superadmin** (`requireJwtAuth` +
`requirePlatformSuperadmin`); anyone else gets 401/403. Prices are platform-wide, not per tenant. Prices are
**USD per 1M tokens** (web search: USD per call). Model ids contain a slash: send them percent-encoded in the
path, e.g. `/api/platform/model-prices/anthropic%2Fclaude-haiku-5.5`.

Price block (`price`, `syncedPrice`, `versions[].price`):
`{ prompt, completion, cacheRead?, cacheWrite?, cacheWrite1h?, reasoning?, image?, imageOutput?, audio?, audioOutput?, webSearch?, contextLength?, tiers: [{ minPromptTokens, prompt, completion, cacheRead?, cacheWrite?, cacheWrite1h? }] }`.
A tier applies when one call's whole prompt (cached tokens included) is `>= minPromptTokens`.

Diff line: `{ field, previous, current, change, changePct, kind: 'changed'|'added'|'removed'|'unchanged' }`;
`field` is `prompt`, `cacheRead`, … or `tier:<minPromptTokens>:<field>`. Unchanged lines are included so the UI can toggle them.

| Endpoint | Purpose |
|---|---|
| `GET /?status=&use=&changedDays=7` | Models in use. Returns `{ lastSync, lastSuccessfulSync, warnings: { noPrice, notListed, syncFailingOver24h }, unseenNotices, models[] }`. Each model: `modelId, name, kind, usedFor[], status ('ok'\|'changed'\|'not_listed'\|'no_price'), source ('openrouter'\|'manual'\|null), price (effective), syncedPrice, override, longPrompt ("×5 above 100,000 tokens"), contextLength, fetchedAt, lastChangedAt, version, unpricedHits`. `changed` = price changed within `changedDays`. Sorted no_price, not_listed, changed, ok. `use` filters by prefix of `usedFor` (`endpoint:`, `spec:`, `title`, `agent`, `ledger`). |
| `GET /changes?since=<ISO>&seen=true\|false&limit=50` | Notices, newest first: `{ _id, modelId, kind ('price_changed'\|'unpriced'\|'not_listed'\|'sync_failing'), version, summary, diff[], seenAt, seenBy, createdAt }`. `sync_failing` has `modelId: '*'`. |
| `GET /:modelId` | `{ model, lastChange (diff lines of the latest change), biggestChangePct, versions[] (newest first: version, effectiveFrom, source 'sync'\|'sync_now'\|'override_set'\|'override_cleared', priceSource, price, previous, diff, actor, note), costEffect }`. `costEffect`: last 30 days of the model's real ledger usage priced tier by tier: `{ windowDays, calls, truncated, recordedUsd, atPreviousUsd, atCurrentUsd, differenceUsd }` (`atPreviousUsd`/`differenceUsd` are null for a first price). 404 if unknown. |
| `GET /:modelId/diff?from=<version>&to=<version>` | Diff between any two stored versions: `{ modelId, from, to, diff[] }`. |
| `POST /changes/:id/seen` | Mark a notice seen. 404 unknown, `{ alreadySeen: true }` if it was. |
| `POST /sync` | Sync now (audited). 200 `{ result: { ok, models, changed, created, notListed } }`, 502 if OpenRouter failed (last prices kept), 409 if another server is already syncing. |
| `PUT /:modelId/override` | Body `{ price: <price block>, reason (3-500 chars, required), until?: ISO date \| null }`. Manual price wins over the synced one until cleared or `until` passes. Audited (`platform.model_price_override_set`). 400 on a bad body or past `until`. Works for models OpenRouter does not list. |
| `DELETE /:modelId/override` | Clear it; the synced price applies again. 404 if none. Audited. |

Notes
- A sync runs on startup and every 6 hours on one server (Redis lock when Redis is on). Every server reloads stored prices
  into memory every minute, and immediately after a sync or override on that server.
- Billing order: manual override, synced price, then the old hand-written tables (last fallback). A model found in none of
  them is billed at the highest price in the table and appears with `status: 'no_price'` and an `unpriced` notice.
- Audit actions: `platform.model_prices_synced`, `platform.model_price_override_set`, `platform.model_price_override_cleared`.
- `x-ai/grok-imagine-image-2.0` is priced outside OpenRouter's list (`UNLISTED_OK` in `packages/api/src/prices/models.ts`)
  and shows no warning.
