# Moving a member between institutions

A person's Synapse institution follows bdren.ai coverage (decision:
`kb/decisions/synapse-membership-follows-bdrenai-coverage.md`). When coverage changes, the person
moves with their data:

- **Join**: an individual (no `tenantId`) whom bdren.ai reports as covered by a linked institution X
  moves into X with everything they own.
- **Leave**: a member of a linked X whom bdren.ai no longer covers under X goes back to being an
  individual, keeping their private data. What they shared inside X stays in X.
- **X to Y**: one move from X to Y; the leave rules apply to what they shared in X.

Code: `packages/api/src/bdren/move.ts` (`createMemberMover`), decided by
`reviewExistingMember` in `packages/api/src/bdren/provision.ts`, wired in
`api/server/services/bdrenAllowance.js`.

## Who is never moved

- Members of institutions with no `bdrenOrganizationId` (legacy tenants). A coverage mismatch is
  recorded instead (`member.coverage_mismatch`, reason `legacy_tenant`).
- Platform staff: role `ADMIN` / `PLATFORM_SUPERADMIN`, or an active `PlatformAdmin` row by id or
  email.
- Users of another issuer, or anyone when the bdren.ai link is off.
- Anyone whose answer is the Free fallback or a stale cache (`origin` other than `fresh`/`cache`).
  A member of a linked institution gets one `member.coverage_mismatch` (`unverified_answer`).

Refusals recorded as `member.coverage_mismatch` (once per reason and organization):
`institution_not_linked`, `institution_closed`, `institution_full`, `legacy_tenant`,
`unverified_answer`, and `move_full` / `move_duplicate_account` when the move itself refuses.
A refused join out of X still leaves X.

## Triggers

- **Login** (`api/strategies/openidStrategy.js`): an existing user's review is awaited before the
  session starts, for at most `BDREN_LOGIN_MOVE_WAIT_MS` (default 4 s). Done in time, the login
  carries on with the moved user, so the first session already has the new scope. Past the limit the
  login goes on in the current scope and the move finishes in the background; meanwhile requests get
  `503 ACCOUNT_MOVING` with `Retry-After`, and every request after it reads the new tenant from
  MongoDB. The review never throws; a failed move is resumed later.
- **Webhook** `membership.coverage_changed` naming a person: after any new institution is
  provisioned, the person's allowance is refetched (`fresh`) and the same review runs. Every later
  request reads the user from MongoDB, so it sees the new tenant.
- **Removal by an admin** (`removeInstitutionMember`): in a linked institution it is a leave (account
  and data kept, the person becomes an individual; `member.removed` with `accountKept: true`). bdren.ai
  stays the authority, so a person it still covers rejoins at their next review. Unlinked (legacy)
  institutions still delete the account.
- **Unfinished moves**: every review first finishes the person's unfinished move (a crash, a caught
  failure), then decides from where they really are, so a changed coverage redirects them with a
  second move. A recovery timer in `bdrenAllowance.js` (every 5 minutes) finishes moves whose lease ran
  out and runs due late sweeps.
## Data map

"Owner" is the field matched against the person. Each record also has to be in the `from` tenant.

| Collection (model) | Owner field | Join | Leave | Notes |
|---|---|---|---|---|
| conversations (`Conversation`) | `user` | moved | moved | A copy already in the target (same `conversationId`) is merged, newer write wins. |
| messages (`Message`) | `user` | moved | moved | Merged the same way on `messageId`. |
| toolcalls (`ToolCall`) | `user` | moved | moved | |
| sharedlinks (`SharedLink`) | `user` | moved | moved | A share points at the person's messages, which move; left behind it would 404. Its ACL entries (public grant included) move with it, so the link keeps working. |
| conversationtags (`ConversationTag`) | `user` | moved | moved | Merged on `tag`. |
| chatprojects (`ChatProject`) | `user` | moved | moved | |
| presets (`Preset`) | `user` | moved | moved | Merged on `presetId`. |
| memoryentries (`MemoryEntry`) | `userId` | moved | moved | |
| files (`File`) | `user` | moved | moved, except files any agent staying in X uses (any author); those go to the heir | `storageTenantId` / `storageUserId` record the stored object's key (see below). |
| agents (`Agent`) | `author` | moved | private ones moved; shared ones stay, owned by the heir | Shared = any ACL entry in X for a principal other than the person. `avatar.storageTenantId` keeps the avatar key's tenant. A moving agent loses the names (and tool keys and tool options) of MCP servers in the source tenant that do not move with it, since in the target the name would reach someone else's server; servers from `librechat.yaml` are kept. Audited as `removedServers`. |
| actions (`Action`) | `user` | moved | moved with their agent (or with no agent) | Actions on a kept or a colleague's agent stay, owned by the heir. |
| agentapikeys (`AgentApiKey`) | `userId` | moved | moved | |
| assistants (`Assistant`) | `user` | moved | moved | |
| promptgroups (`PromptGroup`) | `author` | moved | private moved; shared stay (heir) | |
| prompts (`Prompt`) | `author` | moved | moved with their group | Prompts in a shared or a colleague's group stay, owned by the heir. |
| mcpservers (`MCPServer`) | `author` | moved | private moved; shared stay (heir) | `serverName` is unique per tenant: a moving server whose name is taken is renamed `<name>-moved`; the person's moving agents' `mcpServerNames`, tool keys and tool options, their stored credentials (`PluginAuth.pluginKey` `mcp_<name>`) and OAuth tokens (`Token.identifier` `mcp:<name>`, `:client`, `:refresh`) follow before they move. |
| skills (`Skill`) | `author` | moved | private moved; shared stay (heir) | Unique per author and tenant: a taken name is renamed `<name>-moved`. |
| skillfiles (`SkillFile`) | via `skillId` | only with a skill that moved | only with a skill that moved; a kept skill's files go to the heir | `storageTenantId` / `storageUserId` as for files. |
| keys (`Key`) | `userId` | moved | moved | |
| pluginauths (`PluginAuth`) | `userId` | moved | moved | |
| toolfavorites (`ToolFavorite`) | `user` | moved | moved | |
| sessions (`Session`), tokens (`Token`) | `user` / `userId` | moved | moved | Keeps the person signed in. |
| balances (`Balance`) | `user` | moved | moved | Current state, not history. |
| aclentries (`AclEntry`) on moved resources | `resourceId` | moved | moved | The person's and public entries move. Grants to users or groups outside the target tenant, and to roles, are dropped and audited (`droppedGrants`). |
| aclentries (`AclEntry`) of the person on what stays | `principalId` | none | copied to the heir (when a user), then deleted | Only on what the person authored and shared; never on a colleague's prompt group they merely wrote in. |
| aclentries (`AclEntry`) for the person in X | `principalId` | none | deleted | Their access to X's agents, prompts, etc. Never on anything of theirs left behind by a clash. |
| groups (`Group`) in X | `memberIds` | none | person pulled | Tenant agent audience is also re-synced (`syncTenantMember`). |
| configs (`Config`, principal `user`) in X | `principalId` | none | deleted | Per-user settings X's admins set; override caches of both tenants cleared. |
| kbdocuments (`KbDocument`, versions, jobs) | `createdBy` | stays | stays | Institution-owned. |
| transactions, usage buckets/daily/reservations/warnings, cost ledger | | stays | stays | History; see quota below. |
| bdrenallowances (`BdrenAllowance`) | `userId` | not moved | not moved | Keyed by quota account; a move changes the account, so the old entry is ignored and refetched. |
| auditlogs, bannerviews, agent trigger deliveries/lanes | | stays | stays | Not owned work; deliveries in flight finish in the old tenant. |

The user document changes last: `tenantId`, `accountScope` (`institution` / `standalone`),
`membershipStatus` (`active` on join, removed on leave), `INSTITUTION_ADMIN` demoted to `USER`, the
suspension/removal fields and `bdrenNotedOrganizationId` cleared. The account is never deleted.

### What stays: ownership goes to an heir

Tenant isolation filters only requests that carry a tenant; an individual has none, so an
owner-keyed query of theirs (`author` / `user` = them) would still reach items left in X. So what
stays is handed over, not just left: on a leave, kept agents, prompt groups, the person's prompts in
kept or colleagues' groups, MCP servers, skills and their files, actions and files change owner to
the **heir**, with the person kept in `transferredFrom` (and in the audit, `keptOwner`). The heir is
the longest-standing active institution admin of X, who also inherits the person's grants on those
items so the institution can still manage them; with no admin it is the institution's own `_id`,
which is no one's account. Colleagues keep the access they were granted. Making owner checks
also require a matching tenant was the alternative; it would touch every owner shortcut in the
agents, files, prompts, MCP and skills routes, so the transfer is the safer, single-place fix. The
audit lists the kept ids (`keptAgents`, `keptPromptGroups`, `keptMcpServers`, `keptSkills`,
`keptFiles`) and the heir.

## File storage

Local storage paths carry no tenant. S3 and CloudFront keys do (`t/<tenantId>/<basePath>/<userId>/…`).
Bytes are not copied: the record keeps its `filepath`/`storageKey`, so reads and signed URLs work
unchanged. `deleteFileFromS3` compares the key's tenant and user with the record's. A moved record
carries `storageTenantId` (the key's tenant, `null` for none, set on the first move only), and a
record handed to an heir carries `storageUserId` (the key's user); the delete check uses them. Skill
files get the same fields and the skill delete handlers pass them; an agent's avatar records
`avatar.storageTenantId`, which the avatar replacement passes on. No sweeper lists objects by tenant
prefix, so old-prefix objects are not treated as orphans.

## Search index

Meilisearch documents for conversations and messages carry `user`, not `tenantId`; search filters by
`user` and re-reads the hits from MongoDB under the caller's tenant. Moved records are found under
the new tenant with no reindex. RAG embeddings are keyed by `file_id` and are not tenant-scoped.

## Quota accounting

The person is metered under their new account from the next request (`quotaAccountFor`: the
institution, or `__individuals__`). Usage already counted in the current window under the old
account stays there and is not carried over; bdren.ai remains the authority for the limit, and the
cached allowance is refetched because its quota account changed. Transactions keep their old
`tenantId`, so institution usage reports still show what the person used while a member.

## Crash safety and locking

- **Lock**: a `MemberMove` record (`membermoves`) with a unique partial index on
  `{ userId }` where `status: 'running'`. A second trigger gets `busy`. The record has a lease
  (5 minutes); a crashed trigger's lease runs out and the next review or the recovery timer resumes
  the same record. A caught failure releases the lease at once.
- **Plan first**: before touching data the move records what stays, the heir and the renames
  (`plan`), so a resumed move applies the same split even after ACL entries have moved.
- **Seat first**: a join reserves its seat before moving anything (`seatReserved`); a full
  institution refuses the move with nothing moved. Any later refusal gives the seat back.
- **Fence**: `User.movingUntil` is set for the lease while the move runs and renewed with it (every
  checkpoint, and every 100 records inside a long step); `requireJwtAuth` answers
  `503 ACCOUNT_MOVING` with `Retry-After: 5` until it is lifted, so no new request writes into the old
  tenant. Any failure lifts it at once. The client (`packages/data-provider/src/request.ts`) waits as
  asked and retries (at most 6 times), shows `com_ui_account_moving` once per burst
  (`AccountMovingNotice`), and never signs the person out for it (`AuthContext`).
- **Failure limit**: each trigger's attempt is counted. After 5 attempts, or 24 hours, the move is
  marked `failed`: the fence is lifted, a seat it took and never used is given back, a critical
  platform alert (`member_move:<moveId>`) tells a superadmin what was done, and the audit records
  it. A later review can start a fresh move.
- **Admin changes wait**: suspending, reactivating or changing the role of a member who is moving
  answers 409. The seat to give back is decided by the member's status read in the same write that
  switches them, not by what it was when the move started.
- **Transaction** when the deployment supports it (replica set) and the move is light (at most
  5,000 conversations, messages and files): every collection step and the user change commit
  together. A transaction running past 10 s, or failing (for example on a duplicate key), falls back
  to the sequential path.
- **Sequential**: each step is applied with one `updateMany` and checkpointed (`completed`,
  `moved.<step>`), guarded by the lease id. A retry skips completed steps; a step half-applied
  before a crash matches only what is left, because every filter includes the old tenant.
- **User last**: before the switch the move checks again that the target holds no other account of
  the person's (also checked before the first step); one appearing mid-move refuses the move with
  `duplicate_account` and brings the data back. The user change matches `{ _id, tenantId: from }`
  and must match one document. If someone else placed the person elsewhere meanwhile, the move is
  stopped before `userSwitched` and redirected: each source is planned afresh and moved to where the
  person now is. Leave rules (kept items, heir, clean-up) apply only to `from`, and only when the
  person was a member there; the move's own target was never theirs, so everything in it comes
  back. The reserved seat is given back and the record ends `redirected`.
- **Seats once per move**: a seat is taken and given back through `reserveMoveSeat` /
  `releaseMoveSeat` (`packages/api/src/bdren/seats.ts`), which record `reserve:<moveId>` /
  `release:<moveId>` on the institution (`seatOps`) in the same update as the counter, so a crash
  between the counter change and the move's checkpoint cannot count a seat twice. A release that
  finds the counter already at zero is logged as drift and audited (`seatDrift`), not taken as
  success.
- Then seat release (recorded only once it succeeded; a failure is retried with the move), audience
  sync, override-cache clearing, and a sweep of every step.
- **Late sweep**: a request or stream that started under the old tenant can still write after the
  move. A second sweep runs once the longest stream can have ended (`lateSweepMs`, 10 minutes; in
  process, and from the recovery timer after a restart). A record that already exists in the target
  (`conversationId`, `messageId`, `tag`, `presetId`) is merged into it, newer write wins, instead of
  becoming a duplicate. It only runs while the person is still in the target.
- A duplicate key the merge and renames do not cover leaves that record in place, counted in
  `conflicts` and the audit (`conflicts_<step>`); the person keeps their grants on it.
- Known window: when a duplicate account appears after the leave-only steps ran, the data comes
  back but items already handed to the heir stay with the heir.

## Audit

`member.moved` (platform level): `from`, `to`, `reason` (`coverage_joined`, `coverage_left`,
`coverage_changed`, `member_removed`), `mode`, `moved_<step>` counts, `conflicts_<step>`,
`keptOwner`, `heir`, the kept ids, `renamed`, `droppedGrantCount` / `droppedGrants`, and
`redirectedTo` for a redirected move.
