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
  session starts, and the login carries on with the moved user, so the first session already has the
  new scope. The login waits for one bdren.ai call (bounded by `BDREN_ALLOWANCE_TIMEOUT_MS`, the ID
  token bypasses the cache) and, when a move is due, for the move itself (one `updateMany` per
  collection). The review never throws; a failed move leaves the login as it was.
- **Webhook** `membership.coverage_changed` naming a person: after any new institution is
  provisioned, the person's allowance is refetched (`fresh`) and the same review runs. Every later
  request reads the user from MongoDB, so it sees the new tenant.

## Data map

"Owner" is the field matched against the person. Each record also has to be in the `from` tenant.

| Collection (model) | Owner field | Join | Leave | Notes |
|---|---|---|---|---|
| conversations (`Conversation`) | `user` | moved | moved | |
| messages (`Message`) | `user` | moved | moved | |
| toolcalls (`ToolCall`) | `user` | moved | moved | |
| sharedlinks (`SharedLink`) | `user` | moved | moved | A share points at the person's messages, which move; left behind it would 404. Its ACL entries (public grant included) move with it, so the link keeps working. |
| conversationtags (`ConversationTag`) | `user` | moved | moved | |
| chatprojects (`ChatProject`) | `user` | moved | moved | |
| presets (`Preset`) | `user` | moved | moved | |
| memoryentries (`MemoryEntry`) | `userId` | moved | moved | |
| files (`File`) | `user` | moved | moved, except files a kept agent uses | `storageTenantId` records the tenant in the stored object's key (see below). |
| agents (`Agent`) | `author` | moved | private ones moved; shared ones stay | Shared = any ACL entry in X for a principal other than the person. |
| actions (`Action`) | `user` | moved | moved with their agent (or with no agent) | Actions on a kept or a colleague's agent stay. |
| agentapikeys (`AgentApiKey`) | `userId` | moved | moved | |
| assistants (`Assistant`) | `user` | moved | moved | |
| promptgroups (`PromptGroup`) | `author` | moved | private moved; shared stay | |
| prompts (`Prompt`) | `author` | moved | moved with their group | Prompts in a shared or a colleague's group stay. |
| mcpservers (`MCPServer`) | `author` | moved | private moved; shared stay | `serverName` is unique per tenant: a clash leaves that server in place, counted as a conflict. |
| skills (`Skill`) | `author` | moved | private moved; shared stay | |
| skillfiles (`SkillFile`) | via `skillId` | moved with their skill | moved with their skill | |
| keys (`Key`) | `userId` | moved | moved | |
| pluginauths (`PluginAuth`) | `userId` | moved | moved | |
| toolfavorites (`ToolFavorite`) | `user` | moved | moved | |
| sessions (`Session`), tokens (`Token`) | `user` / `userId` | moved | moved | Keeps the person signed in. |
| balances (`Balance`) | `user` | moved | moved | Current state, not history. |
| aclentries (`AclEntry`) on moved resources | `resourceId` | moved | moved | Every principal's entry on a moved agent, prompt group, MCP server, skill or shared link. |
| aclentries (`AclEntry`) for the person in X | `principalId` | none | deleted | The person's access to X's agents, prompts, etc., including their owner entry on what stays. |
| groups (`Group`) in X | `memberIds` | none | person pulled | Tenant agent audience is also re-synced (`syncTenantMember`). |
| kbdocuments (`KbDocument`, versions, jobs) | `createdBy` | stays | stays | Institution-owned. |
| transactions, usage buckets/daily/reservations/warnings, cost ledger | | stays | stays | History; see quota below. |
| bdrenallowances (`BdrenAllowance`) | `userId` | not moved | not moved | Keyed by quota account; a move changes the account, so the old entry is ignored and refetched. |
| auditlogs, bannerviews, agent trigger deliveries/lanes | | stays | stays | Not owned work; deliveries in flight finish in the old tenant. |

The user document changes last: `tenantId`, `accountScope` (`institution` / `standalone`),
`membershipStatus` (`active` on join, removed on leave), `INSTITUTION_ADMIN` demoted to `USER`, the
suspension/removal fields and `bdrenNotedOrganizationId` cleared. The account is never deleted.

Items kept in X keep `author` = the person; the `member.moved` audit entry names the owner
(`keptOwner`) and the kept ids (`keptAgents`, `keptPromptGroups`, `keptMcpServers`, `keptSkills`,
`keptFiles`).

## File storage

Local storage paths carry no tenant. S3 and CloudFront keys do (`t/<tenantId>/<basePath>/<userId>/…`).
Bytes are not copied: the record keeps its `filepath`/`storageKey`, so reads and signed URLs work
unchanged. The only check that compared the key's tenant with the record's was
`deleteFileFromS3`; a moved record now carries `storageTenantId` (the key's tenant, `null` for none,
set on the first move only) and the delete check uses it. No sweeper lists objects by tenant prefix,
so old-prefix objects are not treated as orphans.

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
  (5 minutes); a crashed trigger's lease runs out and the next trigger resumes the same record. A
  caught failure releases the lease at once.
- **Plan first**: before touching data the move records what stays (`plan`), so a resumed move
  applies the same split even after ACL entries have moved.
- **Seat first**: a join reserves its seat before moving anything (`seatReserved`); a full
  institution refuses the move with nothing moved.
- **Transaction** when the deployment supports it (replica set): every collection step and the user
  change commit together. A transaction failure (for example a duplicate key) falls back to the
  sequential path.
- **Sequential**: each step is applied with one `updateMany` and checkpointed (`completed`,
  `moved.<step>`), guarded by the lease id. A retry skips completed steps; a step half-applied
  before a crash matches only what is left, because every filter includes the old tenant. The user
  changes last, so they are never in two tenants, then seat release / audience sync (flagged), then a
  sweep runs every step once more to catch records written in the old tenant during the move.
- A duplicate key outside a transaction moves records one by one and leaves the clashing ones in
  place; the final count is in `conflicts` and the audit (`conflicts_<step>`).
- Known windows: a crash between taking or releasing a seat and recording it can leave the seat
  counter off by one; a duplicate account created in the
  target tenant after the pre-check makes the user change fail until it is resolved by hand.

## Audit

`member.moved` (platform level): `from`, `to`, `reason` (`coverage_joined`, `coverage_left`,
`coverage_changed`), `mode`, `moved_<step>` counts, `conflicts_<step>`, `keptOwner` and the kept ids.

## Not changed

Removing a member through the member service (`removeInstitutionMember` →
`removeMemberWithoutTransaction` → `deleteUserAccountData`) still deletes the account and 22
collections of the person's data. For a linked institution that contradicts the coverage rule;
routing it through `moveMember({ from: X, to: null })` is a follow-up.
