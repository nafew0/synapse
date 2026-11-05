# Dev server on Imtiaz-VM — plan

A test copy of the Synapse chat app on `Imtiaz-VM` (`203.96.189.220`), used to
merge and try features before they go to `bdren-prod`. Only the app runs there.
RAG (`rag.bdren.ai`) and the code sandbox (`interpreter.bdren.ai`) are the
production ones.

**Nothing here has been run.** Every command is proposed.

---

## 1. What the VM has today (checked 2026-11-05)

| | |
|---|---|
| OS / size | Ubuntu 26.04.1, 16 cores, 30 GB RAM, 889 GB free |
| Login | `ssh Imtiaz-VM` (user `bdren`), **sudo needs a password** |
| Already installed | Docker, Caddy (root, `/etc/caddy/Caddyfile`, owns :80/:443), PostgreSQL 18 (loopback), Loki :3100 + Grafana :3000 in `/opt/monitoring` |
| Missing | Node, npm, PM2, MongoDB, Redis |
| `bdren` in `docker` group | No — Docker commands need sudo until it is added |
| Reaches prod services | `interpreter.bdren.ai/v1/health` 200, `rag.bdren.ai/health` 200, `langfuse.bdren.ai` 200 |
| DNS for a dev name | None yet (`dev.bdren.ai` etc. do not resolve) |

Two things follow from this:

- **Caddy is already the front door**, so use it instead of installing nginx.
  It also gets the certificate by itself.
- **Ubuntu 26.04 is newer than the MongoDB and NodeSource packages target.**
  Run MongoDB in Docker and install Node with `fnm` rather than fight apt repos.

---

## 2. Target layout

```
           dev-chat.bdren.ai  (new DNS A record → 203.96.189.220)
                    │
             Caddy :443  (existing)
                    │
           Synapse dev  127.0.0.1:3080   PM2, 1 process, branch bdren-dev
             │        │
   MongoDB (Docker)  Redis (Docker)        both 127.0.0.1 only
   DB "SynapseDev"
             │
             ├── https://rag.bdren.ai            (prod RAG)
             └── https://interpreter.bdren.ai/v1 (prod sandbox)
```

---

## 3. Branch workflow

```
feature/x ──┐
feature/y ──┼──► bdren-dev ──(deploy to VM, test)──► merge feature/x into bdren-prod
feature/z ──┘
```

- New long-lived branch **`bdren-dev`**, cut from `bdren-prod`.
- Merge feature branches into `bdren-dev` to try them together on the VM.
- When a feature passes, merge **the feature branch** (not `bdren-dev`) into
  `bdren-prod`. `bdren-dev` collects half-finished work; it must never be merged
  into production wholesale.
- Every week or so, reset `bdren-dev` to `bdren-prod` and re-merge whatever is
  still under test, so it doesn't drift away from what production runs.

---

## 4. Rules that keep dev from touching production

These matter more than the install, because dev shares two prod services.

| Risk | Rule |
|---|---|
| Dev writes to the prod database | Own MongoDB on the VM, database `SynapseDev`. Never put the prod `MONGO_URI` in the dev `.env` |
| Dev tokens accepted by prod / prod tokens by dev | New `JWT_SECRET`, `JWT_REFRESH_SECRET`, `CREDS_KEY`, `CREDS_IV`, `MEILI_MASTER_KEY`, `METRICS_SECRET`. Never copy these from prod |
| Real users get dev emails (invites, password resets) | Leave email unset, or send through a test mailbox. `DOMAIN_CLIENT` = the dev URL so any link points at dev |
| Strangers sign up and spend model credits | `ALLOW_REGISTRATION=false`; testers come in through invites or `PLATFORM_SUPERADMIN_EMAILS` |
| Dev traces mixed into prod Langfuse | Same Langfuse is fine, but set its environment to `dev` so prod dashboards filter it out |
| Dev files sit in prod RAG | Uploads from dev are embedded into the prod RAG database under their own file IDs. Harmless, but clean them up: deleting the file in dev deletes its vectors |
| Dev runs use prod sandbox capacity | Accept for a small test group. Watch sandbox load in Grafana when running heavy Office tests |
| Sandbox signing key | **Decided: dev reuses the prod key** (`CODEAPI_JWT_*` copied from prod). No change on the interpreter host. Cost: dev can't be cut off on its own; if the VM is ever compromised, rotate the prod key. Keep the dev `.env` readable by `bdren` only (`chmod 600`) |
| Model API spend | Separate API keys for dev where the provider allows it, with a low spending cap |

Copy the prod `.env` only as a list of which variables exist, then fill in dev
values. Back it up separately; it is gitignored.

---

## 5. Setup steps

### 5.1 You (needs your sudo password and DNS access)

1. DNS: `A dev-chat.bdren.ai → 203.96.189.220`.
2. On the VM:
   ```bash
   sudo usermod -aG docker bdren          # then log out and back in
   sudo mkdir -p /opt/synapse-dev && sudo chown bdren:bdren /opt/synapse-dev
   ```
3. Add the site to `/etc/caddy/Caddyfile`:
   ```
   dev-chat.bdren.ai {
       reverse_proxy 127.0.0.1:3080 {
           flush_interval -1          # keeps streamed replies flowing
       }
       request_body {
           max_size 100MB
       }
   }
   ```
   then `sudo systemctl reload caddy` (Caddy fetches the certificate).
4. Optional but recommended: limit who can open it — Caddy `remote_ip`
   matcher for the BdREN office range, or basic auth in front.

### 5.2 Node and PM2 (no sudo)

```bash
curl -fsSL https://fnm.vercel.app/install | bash
fnm install 24.16.0 && fnm default 24.16.0
npm install -g pm2
pm2 startup                               # prints one sudo command; run it
```

### 5.3 MongoDB and Redis in Docker, loopback only

`/opt/synapse-dev/compose.yml`:

```yaml
services:
  mongo:
    image: mongo:8.0
    command: ["--replSet", "rs0", "--bind_ip_all"]
    ports: ["127.0.0.1:27017:27017"]
    volumes: ["./mongo-data:/data/db"]
    restart: unless-stopped
  redis:
    image: redis:7
    ports: ["127.0.0.1:6379:6379"]
    restart: unless-stopped
```

```bash
cd /opt/synapse-dev && docker compose up -d
docker compose exec mongo mongosh --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27017"}]})'
```

Replica set from the start, same as prod, so quota enforcement can be tested
too. Binding to `127.0.0.1` matters: Docker-published ports skip `ufw`.

### 5.4 The app

```bash
cd /opt/synapse-dev
git clone <synapse repo> app && cd app
git checkout bdren-dev
cp /path/to/dev.env .env                  # filled in per §4, from your machine via scp
npm ci
npx turbo build --force
pm2 start deploy/dev/ecosystem.config.js
pm2 save
curl -fsS localhost:3080/health
```

Don't use the prod `ecosystem.config.js` here: it hard-codes `cwd: /opt/synapse`
and also starts `synapse-admin` on port 3000, which Grafana already holds on this
VM. The dev file is [`deploy/dev/ecosystem.config.js`](../deploy/dev/ecosystem.config.js):

```js
module.exports = {
  apps: [
    {
      name: 'synapse-dev',
      script: 'api/server/index.js',
      cwd: '/opt/synapse-dev/app',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '2G',
      wait_ready: true,
      listen_timeout: 90000,
      kill_timeout: 65000,
      env: { NODE_ENV: 'production' },
    },
  ],
};
```

One process is enough for testing. Keep `wait_ready` (KB: pm2-reload-drops-service).
Switch to `instances: 2, exec_mode: 'cluster'` when a feature needs testing
under the same cluster setup as prod (Redis, reconciler running in each worker).

Dev `.env` essentials:

```
HOST=127.0.0.1
PORT=3080
DOMAIN_CLIENT=https://dev-chat.bdren.ai
DOMAIN_SERVER=https://dev-chat.bdren.ai
MONGO_URI=mongodb://127.0.0.1:27017/SynapseDev?replicaSet=rs0
USE_REDIS=true
REDIS_URI=redis://127.0.0.1:6379
ALLOW_REGISTRATION=false
RAG_API_URL=https://rag.bdren.ai
RAG_JWT_SECRET=<same as prod: RAG checks it>
LIBRECHAT_CODE_BASEURL=https://interpreter.bdren.ai/v1
CODEAPI_*=<same as prod>
```

`librechat.yaml` comes from the repo, so it matches the branch being tested.

### 5.5 Data

**Decided 2026-11-05: dev starts from an exact copy of the production `Synapse`
database**, restored as `SynapseDev` (`mongodump` on the app host piped into
`mongorestore` on the VM). Consequences to keep in mind:

- Real accounts exist on dev, and they sign in with their production passwords.
  Dev has its own JWT secrets, so production sessions don't carry over.
- Dev reuses prod `CREDS_KEY`/`CREDS_IV` so users' saved credentials in the
  copy still decrypt.
- Email stays unset on dev so no real user gets mail from it.
- Deleting a copied file on dev also deletes its vectors in production RAG
  (same file IDs). Don't delete copied users' files while testing.
- Refresh the copy by re-running the dump/restore; it replaces `SynapseDev`.

---

## 6. Deploying a new build to dev

Automatic. Push to `bdren-dev`; GitHub Actions builds, type-checks and tests it,
and a cron job on the VM deploys the commit once those checks pass, rolling back
if the app doesn't come up healthy. Setup and day-to-day commands:
[`deploy/dev/README.md`](../deploy/dev/README.md). That README replaces the
manual clone-and-start steps in §5.4.

## 7. Logs and monitoring

Loki and Grafana are already on this VM. Point the dev app's logs at the local
Loki with a `env=dev` label so they sit beside prod's but filter apart.
`pm2 logs synapse-dev` for quick looks.

---

## 8. Order of work

1. §5.1 DNS, docker group, Caddy site (you, ~15 min).
2. §5.2–5.3 Node, PM2, Mongo, Redis.
3. Write the dev `.env` on your Mac (sandbox key copied from prod), `scp` it over, `chmod 600`.
4. Create `bdren-dev` from `bdren-prod`, push it.
5. §5.4 clone, build, start; check `https://dev-chat.bdren.ai`.
6. Seed test institutions and users; run one chat, one file-RAG question and
   one Office task to confirm prod RAG and sandbox both answer.
7. Turn on the cron job from `deploy/dev/README.md`; record the setup in `kb/decisions/`.

## 9. Open questions

- Dev domain name: decided, `dev-chat.bdren.ai` (2026-11-05).
- Who besides you tests on it? That decides IP allowlist vs. basic auth vs. open.
- Does the admin panel ever need to run against dev? Not in this plan; it can be
  added later on `127.0.0.1:3001` reached by SSH tunnel.
- Grafana (:3000) and RDP (:3389) are open to the internet on this VM today.
  Unrelated to this plan, but worth closing once dev traffic lands here.
