# H3 merge notes: `bdren-prod` into `feature/quota-plan`

Real merge (no rebase). Seven files conflicted; everything else auto-merged.
Rule applied: the quota engine keeps `feature/quota-plan` behaviour, production fixes around it are kept.

| File | Choice | Why |
|---|---|---|
| `api/server/routes/platform/institutions.js` | Imports combined (`isUsageAccount`, `isReservedTenantId` from quota-plan + `isChatAccessContact` from prod). Quota-plan side kept for the two `InstitutionPackage` blocks (create-with-`packageId`, `POST /:tenantId/package`); prod's versions dropped. | quota-plan removed the old institution packages (`e8f486216`) in favour of usage packages; the `InstitutionPackage` model no longer exists, so prod's blocks would crash. |
| `api/server/services/institutionMembers.js` | Standalone invite: quota-plan side (`usagePackageKey`, prod's `creditPackageId`/`pkg.id` dropped) **plus** prod's `expiresAt: invite.expiresAt` passed to `sendInstitutionInviteEmail`. Platform member list: prod's `inviteFilter` (`$and` form, so the search filter is applied correctly). Also removed a duplicate `visibleMembershipFilter` key in `module.exports` (auto-merge left both sides' entry; lint error `no-dupe-keys`). | Usage packages are the quota engine; the invite-expiry email and invite filter are production fixes unrelated to metering. |
| `client/src/components/Chat/Messages/Content/MessageContent.tsx` | Both: `parseAccessEnded` check first (prod chat-access-ended notice), then quota-plan's `getErrorSeverity === 'notice'` branch. | Two independent notice types; neither replaces the other. |
| `client/src/components/Messages/Content/Error.tsx` | Both import sets (`QuotaNotice`, `extractJson` + `Deliverables`). | Independent features. |
| `client/src/hooks/SSE/errors.ts` | Both helpers (`quotaDisplay`, `accessEndedInfo`); `toErrorText` emits quota display fields and the access-ended `info`. | The live refusal must keep quota reset fields and prod's `chat_access_ended` info. |
| `packages/data-provider/src/config.ts` | Both `ErrorTypes` members: `TOKEN_QUOTA_EXCEEDED` and `CHAT_ACCESS_ENDED`. | Independent codes. |
| `librechat.yaml` | OpenRouter `tokenConfig`: both sides' entries kept (`deepseek-v4-flash-0731`, `claude-haiku-4.5` from quota-plan; `gpt-6-luna`, `claude-haiku-5.5` from prod). Prod's legal-page links and `gpt-6-luna` title model auto-merged. quota-plan's removal of `creditPackages` stands. | Pricing entries feed credit metering; dropping either side would bill at fallback rates. |

## Unstructured OCR Transaction rows
No conflict in `packages/api/src/files/unstructured/*` or the Transaction schema/methods; the OCR charge rows from prod merged in untouched.

## Verification
- Builds: `npx turbo run build --force` (5/5 tasks).
- `packages/api` `src/usage`: 98/98. `packages/data-schemas` transaction specs: 40/40.
- `api` usageQuota (integration, credits, individuals), institutionMembers, usageCatalog, platform routes: all pass when run alone (`-i`); under parallel load the replica-set specs time out (infrastructure, not code).
- Known failures not caused by the merge: `api/server/routes/platform/users.test.js` (`createMethods is not a function`; both the test and `users.js` are byte-identical to `feature/quota-plan`'s pre-merge versions); in `packages/api`: `app/service.spec`, `admin/secrets.integration.spec`, `agents/hooks/executor.spec` (sources identical on both parents) and Redis-backed stream/mcp/cache integration specs (no Redis locally). Not re-run on a clean `bdren-prod` checkout.
- App: local Synapse, member `run-member@example.test`: a chat was metered (member_credits bucket settled, Transaction rows written); after setting a tiny package limit and the tenant policy to enforce, the next chat was refused with the "Usage limit reached" notice including the new "contact your administrator" line.
