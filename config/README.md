# `config/` scripts

Operational scripts for running Synapse: user and balance admin, institutions and
tenancy, agents, billing, observability, data migrations, and install/update tooling.

- [Before you run anything](#before-you-run-anything)
- [Which script do I need?](#which-script-do-i-need)
- [Users](#users)
- [Balances and usage stats](#balances-and-usage-stats)
- [Banners and terms](#banners-and-terms)
- [Cache and search](#cache-and-search)
- [Institutions and tenancy](#institutions-and-tenancy)
- [Agents](#agents)
- [Usage policies and billing](#usage-policies-and-billing)
- [Langfuse cost tracking](#langfuse-cost-tracking)
- [Data migrations](#data-migrations)
- [Install, update, and process control](#install-update-and-process-control)
- [Developer utilities](#developer-utilities)
- [Internal modules](#internal-modules)
- [Known issues](#known-issues)

---

## Before you run anything

**Run from the repository root.** Every example below assumes your shell is in the
repo root (`/opt/synapse` on the production app server). The scripts read `.env`
from there, and those that touch the database connect with `MONGO_URI`, so the
database you hit is whichever `.env` points at.

**Two ways to invoke.** Scripts with an npm shortcut can run either way:

```bash
npm run create-user                 # npm shortcut
node config/create-user.js          # direct
```

With npm, put `--` before the arguments so npm passes them through:

```bash
npm run sync-langfuse-models -- --dry-run
```

Scripts without a shortcut are run with `node config/<script>.js`. Some of them
print `npm run node -- config/...` in their `--help` text; there is no `node` npm
script, so use `node config/...` instead.

**Know which scripts write by default.** Most scripts that change data in bulk are
**dry run unless you pass `--apply`**. A few use the opposite convention and write
unless you pass `--dry-run`. Each section below says which. When in doubt, run the
dry-run form first and read the output.

| Convention                                | Scripts                                                                                                                                                                                             |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dry run by default; `--apply` to write    | `migrate-institution-admins`, `repair-institution-tenancy`, `grant-office-agent-multi-tenant`, `sync-office-agents`, `seed-document-agent`, `migrate-usage-policies`                                |
| Writes by default; `--dry-run` to preview | `migrate-agent-permissions`, `migrate-prompt-permissions`, `migrate-shared-link-permissions`, `migrate-orphaned-agent-files`, `migrate-code-file-duplicates`, `flush-cache`, `sync-langfuse-models` |
| Asks for confirmation interactively       | `delete-user`, `delete-banner`, `reset-terms`, `reset-meili-sync`                                                                                                                                   |
| Read-only                                 | `list-users`, `list-balances`, `user-stats`, `report-duplicate-usage-keys`                                                                                                                          |

**Back up production first.** Before any bulk write against production, take a
dump with `scripts/db-dump-remote.sh`.

---

## Which script do I need?

| I want to…                                                      | Script                                                                                                                  |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Create an account by hand                                       | [`create-user`](#create-user)                                                                                           |
| Email someone an invite link                                    | [`invite-user`](#invite-user)                                                                                           |
| See every user                                                  | [`list-users`](#list-users)                                                                                             |
| Reset a user's password                                         | [`reset-password`](#reset-password)                                                                                     |
| Temporarily block a user                                        | [`ban-user`](#ban-user)                                                                                                 |
| Permanently remove a user and their data                        | [`delete-user`](#delete-user)                                                                                           |
| Give a user more credits                                        | [`add-balance`](#add-balance)                                                                                           |
| Set a user's credits to an exact number                         | [`set-balance`](#set-balance)                                                                                           |
| See everyone's credits                                          | [`list-balances`](#list-balances)                                                                                       |
| See conversation/message counts per user                        | [`user-stats`](#user-stats)                                                                                             |
| Show or remove a site-wide banner                               | [`update-banner`](#update-banner), [`delete-banner`](#delete-banner)                                                    |
| Make everyone re-accept the terms                               | [`reset-terms`](#reset-terms)                                                                                           |
| Log everyone out / clear stale cached config                    | [`flush-cache`](#flush-cache)                                                                                           |
| Rebuild search after MeiliSearch data loss                      | [`reset-meili-sync`](#reset-meili-sync)                                                                                 |
| Fix "You do not have admin privileges" for an institution admin | [`repair-institution-tenancy --grants`](#repair-institution-tenancy)                                                    |
| Make a platform-created agent visible to a tenant               | [`repair-institution-tenancy --adopt-agents`](#repair-institution-tenancy)                                              |
| Convert old tenant `ADMIN` users to `INSTITUTION_ADMIN`         | [`migrate-institution-admins`](#migrate-institution-admins)                                                             |
| Create or update the Office Assistant and its specialists       | [`sync-office-agents`](#sync-office-agents)                                                                             |
| Share one Office Assistant across several tenants               | [`grant-office-agent-multi-tenant`](#grant-office-agent-multi-tenant)                                                   |
| Recreate the Document Assistant in a fresh environment          | [`seed-document-agent`](#seed-document-agent)                                                                           |
| Set up usage policies / ledger indexes                          | [`report-duplicate-usage-keys`](#report-duplicate-usage-keys), then [`migrate-usage-policies`](#migrate-usage-policies) |
| Make Langfuse show correct costs for a model                    | [`sync-langfuse-models`](#sync-langfuse-models)                                                                         |
| Pull, reinstall, and rebuild                                    | [`smart-reinstall`](#smart-reinstall)                                                                                   |

---

## Users

### `create-user`

Creates an account directly in the database, with no email verification step.
Prompts for anything you leave out.

```bash
# Fully interactive
npm run create-user

# Pass email, name, username; you'll be prompted for a password (blank = generated)
npm run create-user -- jane@example.edu.bd "Jane Rahman" jane

# Create the account with email marked as NOT verified
npm run create-user -- jane@example.edu.bd "Jane Rahman" jane --email-verified=false

# Record a different auth provider on the account (omit for a normal email/password account)
npm run create-user -- jane@example.edu.bd "Jane Rahman" jane --provider=google
```

A password can be given as a fourth positional argument, but it ends up in your
shell history. Leave it out and type it at the prompt instead.

### `invite-user`

Creates a registration token and emails the user a `/register?token=…` link.
Fails if the address already has an account.

```bash
npm run invite-user -- jane@example.edu.bd
```

Requires a working email service in `.env`. The script exits with
`Email service is not enabled` otherwise. To invite many people from an
institution, use the bulk-invite and resend flows in the admin panel instead.

### `list-users`

Prints every user: id, email, username, name, provider, created date, and terms
acceptance. Read-only.

```bash
npm run list-users
npm run list-users > users.txt     # save the output
```

### `reset-password`

Sets a new password for a user. Prompts for the email, then the new password
twice (input is hidden). Takes no arguments.

```bash
npm run reset-password
```

### `ban-user`

Bans a user for a number of **minutes**.

```bash
npm run ban-user -- jane@example.edu.bd 1440      # one day
npm run ban-user -- jane@example.edu.bd 10080     # one week
npm run ban-user                                  # prompts for both
```

### `delete-user`

Permanently deletes a user and **all** of their data: conversations, messages,
files, agents, prompts, presets, shared links, keys, memories, sessions, ACL
entries and group membership. It asks you to confirm the deletion, then asks
separately whether to delete their transaction (billing) history too.

```bash
npm run delete-user -- jane@example.edu.bd
```

- Answer **N** to the transaction-history question unless you have a reason not
  to. Keeping it preserves your billing and COGS records.
- If Redis generation coordination is unavailable, the script asks you to confirm
  that **every** LibreChat app, worker and other deletion process is stopped. Only
  answer `y` if that's true; a still-running process can write data for the user
  while the delete is in progress.

This cannot be undone. Take a database dump first.

---

## Balances and usage stats

`add-balance` and `set-balance` only work when balances are enabled in
`librechat.yaml` (`balance.enabled: true`); otherwise they exit with
`Balance is not enabled`. Amounts are **token credits**: 1 credit = $0.000001, so
1,000,000 credits = $1.

### `add-balance`

Adds credits on top of the user's current balance, recorded as a transaction.

```bash
npm run add-balance -- jane@example.edu.bd 500000     # +$0.50 worth
npm run add-balance -- jane@example.edu.bd            # prompts; blank = 1000
```

### `set-balance`

Sets the balance to an exact amount, whatever it was before. Shows the current
balance first.

```bash
npm run set-balance -- jane@example.edu.bd 350000
```

### `list-balances`

Prints every user's current credit balance. Read-only.

```bash
npm run list-balances
```

### `user-stats`

Prints each user with their conversation and message counts. Read-only, but it
runs two count queries per user, so it's slow on a large database. Avoid running
it against production during peak hours.

```bash
npm run user-stats
```

---

## Banners and terms

### `update-banner`

Creates or replaces the site-wide banner. Arguments, in order: start time, end
time, message, public (shown to logged-out visitors), persistable (cannot be
dismissed). Times are ISO 8601 UTC.

```bash
# Interactive (blank start time = now)
npm run update-banner

# Maintenance notice for one evening, visible to everyone, dismissible
npm run update-banner -- 2026-09-12T12:00:00Z 2026-09-12T16:00:00Z \
  "Synapse will be down for maintenance 6-10pm BST." true false
```

### `delete-banner`

Shows the current banner and removes it after you confirm.

```bash
npm run delete-banner
```

### `reset-terms`

Marks **every** user as not having accepted the terms, so all of them are asked
again at next login. Asks for confirmation. Use it after a material change to the
terms of service.

```bash
npm run reset-terms
```

---

## Cache and search

### `flush-cache`

Clears the Redis cache (keys under the configured prefix) or, without Redis, the
file cache (`./data/logs.json`, `./data/violations.json`). Use it when cached
config, model lists or rate-limit state are stale after a config change. **This
logs out every user.** Writes by default.

```bash
npm run flush-cache -- --dry-run        # show what would be cleared
npm run flush-cache -- --dry-run -v     # same, with key detail
npm run flush-cache                     # do it
```

### `reset-meili-sync`

Resets the "already indexed" flags on conversations and messages in MongoDB, so
the backend re-indexes everything into MeiliSearch on its next sync. Use it when
MeiliSearch data was deleted or corrupted and search results are missing. Asks
for confirmation and offers advanced options.

```bash
npm run reset-meili-sync
```

Restart the backend afterwards to start the re-sync. On a large database the
re-index takes a while.

---

## Institutions and tenancy

These scripts work across tenants under system context. All are **dry run unless
`--apply`**, and each accepts `--help`.

### `repair-institution-tenancy`

Fixes tenancy state that was set up outside the normal admin flows. You pick one
or more repairs, and at least one `--tenant` is required.

| Flag                               | Fixes                                                                                                                                                                                                           |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--grants`                         | A user has `role: INSTITUTION_ADMIN` but the role's capability grants were never created (usually because the role was set directly in the DB), so the admin panel says **"You do not have admin privileges"**. |
| `--adopt-agents`                   | Agents created by a tenant-less platform admin are invisible to the tenant's members. Stamps the agents and their ACL entries with the tenant. Platform admins keep access.                                     |
| `--set-agent-create=<true\|false>` | Turns agent creation on or off for the tenant's member roles. The setting survives restarts.                                                                                                                    |
| `--roles=<a,b>`                    | Which roles `--set-agent-create` applies to. Default: `USER,INSTITUTION_ADMIN`.                                                                                                                                 |

```bash
# See what's broken for the bdren tenant
node config/repair-institution-tenancy.js --tenant=bdren --grants --adopt-agents

# Fix admin-panel access for two tenants
node config/repair-institution-tenancy.js --tenant=bdren --tenant=learn --grants --apply

# Stop ordinary users in a tenant from creating agents
node config/repair-institution-tenancy.js --tenant=bdren --set-agent-create=false --roles=USER --apply
```

### `migrate-institution-admins`

Finds users who hold the legacy global `ADMIN` role but belong to a tenant, and
converts them to `INSTITUTION_ADMIN`. The dry run lists candidates and skipped
users.

```bash
node config/migrate-institution-admins.js                       # dry run, all registered tenants
node config/migrate-institution-admins.js --tenant=bdren        # dry run, one tenant
node config/migrate-institution-admins.js --tenant=bdren --apply
node config/migrate-institution-admins.js --include-unregistered-tenants   # also tenants with no institution record
```

---

## Agents

### `sync-office-agents`

Creates or updates the Office Assistant (the visible master agent) and its hidden
specialist agents from a YAML manifest. It's idempotent: agents are matched by
stable ID, so re-running updates them in place. The default manifest is
`config/phase-one-office-agents.yaml`.

| Flag                | Meaning                                                     |
| ------------------- | ----------------------------------------------------------- |
| `--manifest=<path>` | Use a different manifest                                    |
| `--tenant=<id>`     | Create the agents in this tenant                            |
| `--author=<email>`  | Owner of the agents                                         |
| `--group=<id>`      | Grant access to this group                                  |
| `--public`          | Grant access to all users                                   |
| `--reset`           | Remove existing ACL entries on these agents before granting |
| `--apply`           | Write (dry run otherwise)                                   |

```bash
# Preview with the default manifest
node config/sync-office-agents.js

# Push prompt/model changes after editing phase-one-office-agents.yaml
node config/sync-office-agents.js --tenant=bdren --author=admin@bdren.net.bd --apply

# Give access to one group only
node config/sync-office-agents.js --group=group_internal_staff --apply

# Make it available to everyone, replacing previous grants
node config/sync-office-agents.js --public --reset --apply
```

### `grant-office-agent-multi-tenant`

Shares one Office Assistant topology with several tenants by granting it to a
group in each. It never duplicates agents, because stable agent IDs must stay
unique. If the agent is currently tenant-scoped, pass `--promote-platform` so every
target tenant can resolve it.

```bash
# Preview
node config/grant-office-agent-multi-tenant.js \
  --agent=agent_office_assistant \
  --tenants=bdren,learn \
  --group-names=bdren-all-users,learn-all-users

# Apply, creating the groups (every current tenant user is added)
node config/grant-office-agent-multi-tenant.js \
  --agent=agent_office_assistant \
  --tenants=bdren,learn \
  --group-names=bdren-all-users,learn-all-users \
  --promote-platform --create-groups --apply
```

`--agent` defaults to `agent_office_assistant`. `--group-names` is optional: it
needs one name per tenant, in the same order, and defaults to `<tenant>-all-users`.
Without `--create-groups` the groups must already exist. Don't use `--public`
here; this script grants access through tenant groups only.

### `seed-document-agent`

Recreates the Document Assistant. Agents are database records, not config, so a
fresh environment (a new server, or local development) has none until you run
this. It sets `useResponsesApi`, which the agent needs in order to call
`execute_code`, and applies the tenant stamp correctly. Recreating the agent by
hand in the UI tends to get both of these wrong.

| Flag               | Meaning                                              |
| ------------------ | ---------------------------------------------------- |
| `--tenant=<id>`    | Tenant the agent belongs to (omit for platform-wide) |
| `--author=<email>` | Owner (defaults to the first platform ADMIN)         |
| `--model=<name>`   | Model to run (default `gpt-5.6-luna`)                |
| `--no-public`      | Skip the public viewer grant                         |
| `--apply`          | Write (dry run otherwise)                            |

```bash
node config/seed-document-agent.js                                # preview
node config/seed-document-agent.js --apply                        # local dev, platform-wide
node config/seed-document-agent.js --tenant=bdren --author=admin@bdren.net.bd --apply
```

---

## Usage policies and billing

Run these two in order when rolling out usage quotas on a deployment that already
has transaction history.

### `report-duplicate-usage-keys`

Read-only. Lists transaction rows that share an idempotency key (tenant + request
key + token type + value key). **An empty result is required** before the unique
ledger index can be built; duplicates would make the index build fail.

```bash
node config/report-duplicate-usage-keys.js
node config/report-duplicate-usage-keys.js --tenant=bdren
```

If it finds duplicates, reconcile them first. The usual fix is to keep the
earliest row in each group and delete the rest.

### `migrate-usage-policies`

Creates a version-1 usage policy for every institution that lacks one (timezone
defaults to `Asia/Dhaka`) and builds the usage/ledger indexes. It stops with exit
code 2 if duplicate usage keys exist.

```bash
npm run migrate:usage-policies:dry-run       # report only
npm run migrate:usage-policies               # apply (the npm script passes --apply)
```

Note the naming: here, plain `migrate:usage-policies` is the **apply** form.

---

## Langfuse cost tracking

### `sync-langfuse-models`

Keeps Langfuse's model price list in step with real provider pricing, so the
Langfuse cost of every generation matches what the provider actually charges. It
prices input, output, **reasoning** and **cache read/write** tokens. Without a
definition, Langfuse records a model's cost as `null`; without the reasoning and
cache prices, those tokens count as free.

| Flag                  | Meaning                                                                                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--source=openrouter` | Live prices from `https://openrouter.ai/api/v1/models`, for every OpenRouter model in `librechat.yaml` plus every custom definition already in Langfuse. Recommended. |
| `--source=config`     | Prices from `tokenConfig` in `librechat.yaml` (the default).                                                                                                          |
| `--dry-run`           | Show the plan without writing                                                                                                                                         |
| `--config=<path>`     | Use a different config file                                                                                                                                           |

```bash
# Routine: preview, then apply, using live OpenRouter prices
npm run sync-langfuse-models -- --source=openrouter --dry-run
npm run sync-langfuse-models -- --source=openrouter

# Use the rates written in librechat.yaml instead
npm run sync-langfuse-models -- --dry-run
```

**When to run it:** after adding a model, after changing a `tokenConfig` rate, or
periodically, because OpenRouter changes prices without notice.

**Adding a new OpenRouter model, end to end:**

1. Add the model to the endpoint's `models.default` in `librechat.yaml`.
2. Add its `tokenConfig` rates (USD per **1M** tokens) from the OpenRouter API.
   The cache keys are `cacheRead` / `cacheWrite`; anything else is silently
   ignored. Without an entry, billing falls back to the nearest model-family key
   and is usually wrong.
   ```yaml
   tokenConfig:
     'google/gemini-3.8-flash':
       prompt: 0.75
       completion: 3.75
       cacheRead: 0.075
       cacheWrite: 0.041667
       context: 1048576
   ```
3. Run `npm run sync-langfuse-models -- --source=openrouter`.

**Reading the output:**

| Line                                         | Meaning                                                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `CREATE` / `REPLACE` / `UNCHANGED`           | What happened to that model's definition                                                                           |
| `supersedes "<name>"`                        | An older overlapping definition for the same model was removed, so a generation never matches two prices           |
| `DRIFT … Update tokenConfig to match.`       | A rate in `librechat.yaml` no longer matches OpenRouter. LibreChat's billing is out of date; update `tokenConfig`. |
| `SKIP … not in OpenRouter's chat catalog`    | Per-image models on OpenRouter's Images API; these are left as they are                                            |
| `Backup: /tmp/langfuse-models-backup-….json` | Every custom definition as it was before this run                                                                  |

Other behavior to know about:

- It never deletes a definition for a model outside the chosen source.
- Langfuse has no update call, so a changed price is applied as delete + create.
  If the create fails, the old definition is restored.
- New prices only apply to generations logged **after** the run. Existing
  observations keep the cost they were given at ingestion.

Credentials come from `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and
`LANGFUSE_BASE_URL` in `.env`.

---

## Data migrations

One-time upgrades for data written by older versions. Each is safe to re-run: once
the data is migrated, nothing is written. **All of these write by default.** Use the
`:dry-run` npm script first. The `:batch` variants process 50 documents at a time
instead of 100, which is gentler on a busy database.

| Script                            | What it fixes                                                                                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `migrate:agent-permissions`       | Moves agent sharing from the legacy author/global-project model to ACL entries. Agents that already have ACL entries are skipped.                                  |
| `migrate:prompt-permissions`      | The same migration for prompt groups.                                                                                                                              |
| `migrate:shared-link-permissions` | Moves shared links from the removed `isPublic` flag to ACL entries. **Aborts** if links with `isPublic: false` exist, because they would otherwise become public.  |
| `migrate:orphaned-agent-files`    | Removes file IDs that agents still reference after the file itself was deleted. These cause **"Duplicate file detected"** on upload.                               |
| `migrate:code-file-duplicates`    | Renames duplicate code-generated files (older ones get a ` (n)` suffix) so the unique file index can be built. Nothing is deleted, and chat history is unaffected. |
| `migrate:terms-timestamp`         | Sets `termsAcceptedAt` to the account creation date for users who accepted the terms before timestamps were recorded. No dry-run mode.                             |

```bash
npm run migrate:orphaned-agent-files:dry-run
npm run migrate:orphaned-agent-files

npm run migrate:shared-link-permissions:dry-run
node config/migrate-shared-link-permissions.js --force     # only after reviewing the isPublic:false IDs it reports

npm run migrate:agent-permissions:batch
```

---

## Install, update, and process control

> **Production is PM2 on bare metal, not Docker.** `update`, `update:*` and
> `update:deployed` / `rebase:deployed` come from upstream LibreChat and assume a
> Docker or local install tracking `main`. They check out and pull **`main`**, which
> switches a production server off its deployment branch. Don't run them in
> production.

### `smart-reinstall`

The normal way to install dependencies and rebuild after pulling changes. It skips
`npm ci` when `package-lock.json` hasn't changed, and Turborepo reuses cached
package builds.

```bash
npm run smart-reinstall                     # usual
npm run smart-reinstall -- --skip-client    # backend-only change; skip the Vite build
npm run smart-reinstall -- --force          # something's wrong: full clean reinstall
npm run smart-reinstall -- --clean-cache    # wipe the Turborepo cache
npm run smart-reinstall -- --verbose
```

### `reinstall`

Clean install: deletes every `node_modules`, clears the npm cache, runs `npm ci`,
and rebuilds the frontend. Doesn't touch git (`-g`). Slower than
`smart-reinstall`; use it when dependencies are corrupted.

```bash
npm run reinstall
```

### `update` and variants (upstream, not for production)

`config/update.js` fetches origin, checks out `main`, pulls, then rebuilds.

| npm script         | Does                                               |
| ------------------ | -------------------------------------------------- |
| `update`           | Interactive wizard                                 |
| `update:local`     | git pull `main` + clean reinstall + frontend build |
| `update:docker`    | git pull `main` + rebuild the Docker image         |
| `update:single`    | Docker, using `docs/dev/single-compose.yml`        |
| `update:sudo`      | Prefix Docker commands with `sudo`                 |
| `reinstall:docker` | Docker rebuild without touching git                |

### `update:deployed` / `rebase:deployed` (upstream, not for production)

For the upstream Docker "deployed" setup: pulls `main` (or rebases the current
branch onto `origin/main` with `rebase:deployed`), removes the old containers and
images, and pulls fresh images.

### `rebuild:package-lock`

Deletes `package-lock.json` and every workspace's `node_modules`, clears the npm
cache, then runs `npm install` to regenerate the lockfile. This changes dependency versions across the whole
monorepo, so only run it on purpose, commit the result as a separate change, and
test it.

```bash
npm run rebuild:package-lock
```

### `backend:stop`

Kills the backend process (`pkill -f api/server/index.js`).

```bash
npm run backend:stop
```

- In production, PM2 restarts killed processes. Use `pm2 stop` / `pm2 restart`
  there instead.
- On Windows it runs `taskkill /F /IM node.exe`, which kills **every** Node
  process on the machine, not just the backend.

---

## Developer utilities

| File                           | Use                                                                                                                                                                                                                                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `circular-deps.mjs`            | Checks the module graphs of `packages/api`, `packages/data-provider`, `packages/data-schemas`, `packages/client` and the legacy `api/` server for import cycles. Fails if a graph shrinks suspiciously, which means it has stopped seeing the real codebase. `node config/circular-deps.mjs` |
| `test-subdirectory-setup.sh`   | Tests serving Synapse under a sub-path such as `/chat/` behind nginx. Needs nginx and a built app. `bash config/test-subdirectory-setup.sh start`                                                                                                                                            |
| `prepare.js`                   | Installs the husky git hooks. Runs automatically on `npm install` (skipped when `NODE_ENV=CI`).                                                                                                                                                                                              |
| `jest.config.js`               | Test config for this folder: `npm run test:config`                                                                                                                                                                                                                                           |
| `translations/`                | Locale comparison tooling. Translations are managed externally; only `client/src/locales/en/translation.json` is edited by hand.                                                                                                                                                             |
| `phase-one-office-agents.yaml` | Manifest read by `sync-office-agents` (Office Assistant and specialist prompts, models, tools).                                                                                                                                                                                              |
| `graphify-out/`                | Generated cache output. Not a script.                                                                                                                                                                                                                                                        |

---

## Internal modules

Imported by the scripts above; don't run them directly.

| File         | Provides                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------- |
| `connect.js` | Connects to MongoDB using `MONGO_URI` and sets up the `~` alias to `api/`                               |
| `helpers.js` | Coloured console output, `askQuestion` / `askSilentQuestion` prompts, `silentExit`, `deleteNodeModules` |

---

## Known issues

- **`npm run upgrade` is broken.** It points to `config/upgrade.js`, which doesn't
  exist.
- **`invite-user` needs email configured.** It exits if email isn't set up. It
  has code to print the invite link for you to send by hand, but because of the
  earlier exit that code never runs.
- **The `update*` and `*:deployed` scripts check out `main`.** See the warning
  under [Install, update, and process control](#install-update-and-process-control).
