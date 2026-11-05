# Dev server pipeline (Imtiaz-VM)

Push to `bdren-dev` and the dev server at `https://dev-chat.bdren.ai` updates by
itself once CI is green. Background and the safety rules are in
[`../../docs/dev-server-plan.md`](../../docs/dev-server-plan.md).

```
git push origin bdren-dev
        │
        ▼
GitHub Actions  .github/workflows/bdren-dev.yml
  Build and type check   ─┐
  Unit tests (4 suites)   ├─ check runs on the commit
        │                 ┘
        ▼
Imtiaz-VM cron, every 2 min   deploy/dev/watch.sh
  new commit? CI passed? ── no ─► wait
        │ yes
        ▼
deploy/dev/deploy.sh <sha>
  build in releases/<sha> → switch current → restart synapse-dev
  → /health ok? ── no ─► switch back to the previous release
```

The VM pulls; GitHub never connects to it. No self-hosted runner, no SSH key
and no secrets stored in GitHub. The repository is public, so the VM clones it
without credentials.

Pull requests into `bdren-dev` or `bdren-prod` run the same CI, so a feature can
be checked before it is merged.

## Layout on the VM

```
/opt/synapse-dev/
  repo.git/            bare clone of bdren-dev
  releases/<sha>/      one checkout + build per deployed commit (last 3 kept)
  current -> releases/<sha>
  shared/              kept across releases, linked into each one
    .env               dev secrets (chmod 600)
    deploy.env         pipeline settings, see deploy.env.example
    uploads/  logs/  api/logs/  api/data/  client/public/images/
    post-build.sh      optional: runs after each build, e.g. migrations
  state/               deployed sha, previous release, failed-<sha> markers
  logs/deploy.log
  compose.yml          MongoDB + Redis
```

## One-time setup

### 1. As root (needs your sudo password)

```bash
sudo usermod -aG docker bdren
sudo loginctl enable-linger bdren
sudo mkdir -p /opt/synapse-dev && sudo chown bdren:bdren /opt/synapse-dev
```

Caddy on this VM runs in Docker, in the n8n stack: config
`/home/imtiaz/Documents/n8n/Caddyfile`, container `caddy`, network
`n8n_n8n_network` (gateway `172.19.0.1`). Inside the container `127.0.0.1` is
the container itself, so the app listens on `HOST=172.19.0.1` and the block in
[`Caddyfile`](Caddyfile) proxies there. Append it to that Caddyfile, then
`docker exec caddy caddy reload --config /etc/caddy/Caddyfile`.
Set `HEALTH_URL=http://172.19.0.1:3080/health` in `shared/deploy.env`.
DNS: `A dev-chat.bdren.ai → 203.96.189.220`.

Log out and back in so the docker group applies.

### 2. Node and PM2 (as bdren)

```bash
curl -fsSL https://fnm.vercel.app/install | bash
exec $SHELL -l
fnm install 24.16.0 && fnm default 24.16.0
npm install -g pm2
pm2 startup        # prints one sudo command: run it
```

### 3. MongoDB and Redis

```bash
cd /opt/synapse-dev
curl -fsSLO https://raw.githubusercontent.com/nafew0/synapse/bdren-dev/deploy/dev/compose.yml
docker compose up -d
docker compose exec mongo mongosh --quiet --eval \
  'rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27017"}]})'
```

### 4. Shared files

```bash
mkdir -p /opt/synapse-dev/{shared,state,logs}
cd /opt/synapse-dev/shared
mkdir -p uploads logs api/logs api/data client/public/images
```

From your Mac, copy the dev `.env` (written per the plan, §4 and §5.4):

```bash
scp dev.env Imtiaz-VM:/opt/synapse-dev/shared/.env
ssh Imtiaz-VM chmod 600 /opt/synapse-dev/shared/.env
```

Optionally copy [`deploy.env.example`](deploy.env.example) to
`shared/deploy.env` and change what you need.

### 5. First deploy, by hand

```bash
git clone --bare --single-branch --branch bdren-dev \
  https://github.com/nafew0/synapse.git /opt/synapse-dev/repo.git
git --git-dir=/opt/synapse-dev/repo.git show bdren-dev:deploy/dev/deploy.sh > /tmp/deploy.sh
bash /tmp/deploy.sh
```

This builds the branch tip (10–15 minutes the first time), starts `synapse-dev`
under PM2 and checks `/health`. After it, the scripts run from
`/opt/synapse-dev/current/deploy/dev/`.

### 6. Turn on auto-deploy

`crontab -e` and add (the `PATH` line lets cron find node, npm and pm2):

```
PATH=/home/bdren/.local/share/fnm/aliases/default/bin:/usr/local/bin:/usr/bin:/bin
*/2 * * * * /opt/synapse-dev/current/deploy/dev/watch.sh >> /opt/synapse-dev/logs/deploy.log 2>&1
```

Check the fnm path with `dirname "$(which node)"` first: fnm installs under
`~/.local/share/fnm` on Linux, but the folder can differ by version.

## Day to day

| Task | Command |
|---|---|
| Ship a feature to dev | merge it into `bdren-dev` and push |
| See what is live | `cat /opt/synapse-dev/state/deployed` |
| Follow deploys | `tail -f /opt/synapse-dev/logs/deploy.log` |
| App logs | `pm2 logs synapse-dev` |
| Redeploy now, skip the 2-minute wait | `/opt/synapse-dev/current/deploy/dev/deploy.sh` |
| Roll back | `deploy.sh <older-sha>` (instant if that release is still kept, else it rebuilds) |
| Retry a commit that failed | `rm /opt/synapse-dev/state/failed-<sha>` |
| Pause auto-deploy | comment out the cron line |

A commit whose build fails or whose app never becomes healthy is marked
`state/failed-<sha>` and skipped; the previous release keeps serving. A commit
whose CI fails is never deployed. Push a fix to move on.

## Notes

- Every build is a fresh checkout with `turbo run build --force`, so a stale
  `packages/api/dist` cannot carry over (KB: stale-api-dist-after-branch-switch).
- Restart is `pm2 delete` + `pm2 start`, so there are a few seconds of downtime
  per deploy. Fine for dev; prod keeps its cluster reload.
- Each release holds its own `node_modules` (a few GB). `KEEP_RELEASES=3` keeps
  disk use bounded; the npm cache in `~/.npm` makes reinstalls quicker.
- Database changes: put scripts such as
  `node config/migrate-usage-policies.js` in `shared/post-build.sh`. It runs
  before the switch, against the dev database, with the new release's code.
- The app uses prod RAG and the prod sandbox. See the plan's §4 before testing
  heavy Office runs.

## Admin panel

`https://dev-chat.bdren.ai/adminpanel/` runs from the `bdren-dev` branch of
`nafew0/synapse-admin` in `/opt/synapse-dev/admin`, deployed by these same
scripts with `DEV_ROOT=/opt/synapse-dev/admin` (settings in its
`shared/deploy.env`, see `deploy.env.example`). Its PM2 config and notes are in
that repo's `deploy/dev/`. Cron runs a second watcher line for it.
