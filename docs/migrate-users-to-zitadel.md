# Migrating Synapse users to bdren.ai SSO (ZITADEL)

Synapse chat becomes SSO-only through bdren.ai. This one-off migration moves every local-password
account to ZITADEL so people keep their account, chats and institution, and sign in with the
password they already have.

Script: `config/migrate-users-to-zitadel.js`. Logic: `packages/api/src/sso/` (`migrate.ts`, `zitadel.ts`).

## What it does

For each Synapse user with `provider: 'local'`:

1. Creates a ZITADEL human user in the user's organization, with:
   - **user id = the Synapse `_id`** (so a rerun recognises it);
   - username and email = the Synapse email (lowercased);
   - Synapse's bcrypt hash as `hashedPassword`, so the old password works unchanged;
   - the email marked verified only if Synapse had it verified (otherwise ZITADEL keeps it
     unverified and no email is sent during the migration);
   - display name = the Synapse name, split into given/family names (ZITADEL needs both; a
     one-word name is used for both);
   - the TOTP secret for 2FA users, when the script can decrypt it (same `CREDS_KEY` as the app).
2. Changes the Synapse account in one write: `provider: 'openid'`, `openidId: <ZITADEL id>`,
   `openidIssuer: <issuer>`, `ssoMigratedAt`, and `bdrenHoldTenantId: <tenantId>` for institution
   members. Nothing else changes: `_id`, `tenantId`, role, chats, files and the password hash stay.

At the first SSO sign-in, Synapse's OpenID login finds the account by `openidId` + issuer, so it is
the same account (no new user, no institution placement).

### Users it leaves alone (reported)

| Status | Meaning |
|---|---|
| `already_linked` | Already an OpenID account for this issuer (a rerun skips everyone already done). |
| `platform_staff` | `ADMIN`/`PLATFORM_SUPERADMIN` role or an active `PlatformAdmin` row. They keep the local login synapse-admin uses. `--include-admins` migrates them too. |
| `other_provider` | Google, another issuer, etc. |
| `no_email` | No email to sign in with. |
| `unmapped_tenant` | Only with `--unmapped skip`. |
| `conflict` | See below. Nothing is written for that user. |
| `error` | A ZITADEL call failed; nothing written. Rerun later. |

Conflicts:

| Reason | What to do |
|---|---|
| `duplicate_email` | Two Synapse accounts share an email. Decide which one is the person's, merge or remove the other, rerun. |
| `email_in_other_organization` | A ZITADEL user with this verified email exists in a different organization (for example someone who signed up at bdren.ai). Decide which organization is right, fix the mapping or move the ZITADEL user, rerun. |
| `email_unverified_in_zitadel` | A ZITADEL user with this email exists but its email is not verified, so it is not proof it is the same person. Verify it or remove it, rerun. |
| `multiple_zitadel_users` | More than one ZITADEL user has this email. Clean up in ZITADEL, rerun. |
| `username_taken` | Someone else in ZITADEL uses this email as username. |
| `id_taken` | A ZITADEL user already has this id but another email. Investigate. |
| `synapse_account_exists` | Another Synapse account is already linked to that ZITADEL identity (the person already signed in by SSO and got a second account). Merge by hand. |
| `changed_during_migration` | The account changed while the script ran. Rerun. |

A ZITADEL user that already exists with the **same verified email in the same organization** is
linked instead of created (`linked_existing`). One the script created in an earlier, interrupted
run is linked as `resumed`.

## Prerequisites

1. **Issuer.** The production `OPENID_ISSUER` Synapse uses (e.g. `https://auth.bdren.ai`), exactly
   as Synapse is configured; the script normalises a trailing slash the way the login does.
2. **Service user and token.** In ZITADEL, a machine user (e.g. `synapse-migrator`) with the
   instance role **`IAM_USER_MANAGER`** (create, read and search users in every organization), and a
   personal access token with a short expiry. If you prefer organization roles, give it
   `ORG_USER_MANAGER` in every target organization instead. Delete the token (or the machine user)
   after the migration.
   Provide it only as the `ZITADEL_MIGRATION_TOKEN` environment variable; it is never printed or
   written to the report.
3. **Organizations.**
   - Default organization: where individuals (no institution) go, and institutions without a
     mapping (`--org-id`, or `ZITADEL_DEFAULT_ORG_ID`).
   - Mapping file for institutions (`--org-map map.json`): keys are a Synapse `tenantId` or an
     institution's `bdrenOrganizationId`; values are the ZITADEL organization id. Take the ZITADEL
     org id from bdren.ai (`Organization.zitadel_organization_id`, superadmin → Organizations) for each
     institution:
     ```json
     { "learn": "312345678901234567", "bdren": "312345678901234999" }
     ```
   The dry run lists every tenant with its user count, organization, whether it was mapped, and
   whether the institution is active, closed or linked to bdren.ai.
4. **Synapse env.** Run from the deployed Synapse checkout (built `packages/api`) with the app's
   `.env` (for `MONGO_URI` and `CREDS_KEY`, which decrypts 2FA secrets). Take a database backup
   (`mongodump`) first.
5. **ZITADEL hash support.** ZITADEL verifies `$2a$`/`$2b$`/`$2y$` bcrypt hashes by default (checked
   against ZITADEL v4: the migrated users signed in with their old password).
6. **Synapse login settings.** Set `OPENID_NAME_CLAIM=name` so the first SSO login keeps the Synapse
   display name (otherwise a one-word name becomes "Name Name"). Note that the first SSO login sets
   the Synapse username to the ZITADEL login name (the email); this is how the OpenID login works.

## Dry run

Default mode. With a token it asks ZITADEL read-only questions (does this id or email exist?) and
predicts `would_create`, `would_link`, `would_resume` and the conflicts; without one (or with
`--offline`) it plans without ZITADEL.

```bash
export ZITADEL_MIGRATION_TOKEN=...            # from your password manager; not in shell history
node config/migrate-users-to-zitadel.js \
  --db <synapse-db> --i-know-this-is-production \
  --issuer https://auth.bdren.ai --zitadel-url https://auth.bdren.ai \
  --org-id <individuals-org-id> --org-map map.json
```

Any database whose name contains "prod" needs `--i-know-this-is-production`. Other options:
`--batch-size <n>` (users handled concurrently, default 20), `--user <id>` (repeatable; try a few
accounts first), `--unmapped skip`, `--include-admins`, `--report <file>`.

The report is written to `logs/zitadel-migration/<db>-<mode>-<time>.json` (mode 600) after every
batch. It has counts, flags and one row per user keyed by Synapse `_id` only: no emails, names or
hashes.

## Apply

1. Put Synapse in maintenance or run at a quiet time; the script is safe to run while people use
   the app (one guarded write per user), but a person changing their email mid-run gets
   `changed_during_migration`.
2. Try one or two accounts: `... --apply --user <id>`; sign in as them via SSO (see Verification).
3. Run everyone: the same command with `--apply`.
4. Rerun until only the conflicts you have decided to handle by hand remain. Reruns skip
   everyone already linked.
5. Only then switch Synapse to SSO-only.

## Verification

- Report: `created + linked_existing + resumed` equals the expected number; review every
  `conflict` and `error` row.
- Database: `db.users.countDocuments({ ssoMigratedAt: { $exists: true } })`, and
  `db.users.countDocuments({ provider: 'local' })` should be only staff and conflicts.
- Sign in through SSO as a migrated test account: the same `_id`, tenant and chats appear.
- ZITADEL: users appear in the right organizations, with "password set" and the expected email
  verification state.

## Institution coverage after migration

bdren.ai decides whether a person is covered by their institution. A migrated member is new to
bdren.ai: their first SSO login makes them known there, but not covered until their institution
admin adds them to the package. Synapse's coverage review would normally move a not-covered member
out of an institution linked to bdren.ai, so the migration sets `bdrenHoldTenantId`: while it is set,
a "not covered" answer records `member.coverage_mismatch` with reason `migrated_not_covered` and
keeps them in place. The hold ends the first time bdren.ai covers them in that institution; after
that the normal rules apply. Coverage by a different institution still moves them as usual.
Institutions not linked to bdren.ai are never moved at all.

Until an institution admin covers them in bdren.ai, a held member's usage limits are whatever
bdren.ai answers for them. Ask institution admins to add their members to the package soon after
the migration.

## Users who need to act

- **No password in Synapse** (invited and never set one, `noPassword` in the report): use
  "Forgot password" on the bdren.ai sign-in page. ZITADEL sends the reset email.
- **Email not verified in Synapse** (`emailUnverified`): ZITADEL asks them to verify their email at
  the first sign-in and can resend the code.
- **2FA users** (`twoFactor`): when the secret could be decrypted (`totpImported`) their
  authenticator app keeps working. Synapse backup codes are not imported; they should set up new
  recovery options in their bdren.ai account. If the secret could not be read, they sign in with
  their password and ZITADEL asks them to set up a second factor again if the login policy
  requires one.
- **Platform staff**: not migrated by default; they keep using synapse-admin's own login.

## Rollback

One account back to its local password (the hash was never removed):

```bash
node config/migrate-users-to-zitadel.js --db <synapse-db> --i-know-this-is-production --unlink <userId>
```

This only touches accounts the migration changed (`ssoMigratedAt` set): `provider` goes back to
`local` and `openidId`, `openidIssuer`, `ssoMigratedAt` and `bdrenHoldTenantId` are removed. The
username or name the first SSO login wrote stay. The ZITADEL user is left in place; delete it in
ZITADEL if the person should not keep it (a rerun would then create it again with the same id).

Everyone (only before Synapse is switched to SSO-only):

```js
db.users.updateMany(
  { provider: 'openid', ssoMigratedAt: { $exists: true } },
  { $set: { provider: 'local' }, $unset: { openidId: '', openidIssuer: '', ssoMigratedAt: '', bdrenHoldTenantId: '' } },
);
```

Restoring the pre-migration backup is the last resort; it loses anything written since.
