/**
 * Reprices Claude Haiku 5.5 ledger rows that were recorded at the flat rate, missing OpenRouter's
 * long-prompt tier (a call whose prompt reaches 100,000 tokens is billed 5x). It uses Synapse's own
 * pricing functions, so the numbers are whatever `packages/data-schemas/src/methods/tx.ts` holds.
 *
 * What it changes (only rows whose model is claude-haiku-5.5 or claude-haiku-5-5, any vendor prefix):
 *   - Transaction.tokenValue and .rate, for the prompt and completion row of each call, using the
 *     call's prompt size (input + cache write + cache read) to pick the tier. The old values are kept
 *     on the row as `costCorrection` and a row already corrected is never touched again.
 *   - UsageBucket.usedTokens of the institution_credits / member_credits buckets that counted the row,
 *     by the credits added (tokenValue is credits, USD x 1e6).
 *   - The UsageDaily rollup of every day that had a changed row (rebuilt from the ledger).
 * Rows whose call has no prompt row to pair with are left alone and counted as "unpaired".
 *
 * Run it on the server with the production MONGO_URI in .env, from the repo root.
 *
 * 1. Dry run (default, writes nothing; prints totals per month and tenant, before and after):
 *      npm run correct:haiku-tier
 *      node config/correct-haiku-tier-costs.js --since=2026-10-20 --tenant=<tenantId>
 * 2. Apply (idempotent; writes an audit note to logs/cost-corrections/ with every row's before/after):
 *      npm run correct:haiku-tier -- --apply
 *    Take a database backup first. Re-running after --apply reports 0 rows changed.
 * 3. Check: the dry run afterwards shows "rows changed: 0", and the admin cost report matches Langfuse.
 *
 * Flags: --apply  --since=<ISO date>  --tenant=<tenantId>  --audit-dir=<dir>
 * To undo, use the previous values in the audit note (or `costCorrection` on each row).
 */
const path = require('path');
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
require('~/db/models');
const mongoose = require('mongoose');
const { correctHaikuTierCosts } = require('@librechat/api');
const db = require('~/models');
const { silentExit } = require('./helpers');
const connect = require('./connect');

const flag = (name) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const apply = process.argv.includes('--apply');

const money = (value) => Number(value.toFixed(6));

(async () => {
  const since = flag('since');
  await connect();
  const result = await correctHaikuTierCosts({
    pricing: { getMultiplier: db.getMultiplier, getCacheMultiplier: db.getCacheMultiplier },
    dryRun: !apply,
    since: since ? new Date(since) : undefined,
    tenantId: flag('tenant'),
    auditDir: apply
      ? (flag('audit-dir') ?? path.resolve(__dirname, '..', 'logs', 'cost-corrections'))
      : undefined,
  });

  console.log(`${apply ? 'APPLIED' : 'Dry run (nothing written)'} - run ${result.runId}`);
  console.log(
    `rows scanned: ${result.rowsScanned}, rows changed: ${result.rowsChanged}, ` +
      `already correct: ${result.rowsAlreadyCorrect}, unpaired (skipped): ${result.rowsUnpaired}`,
  );
  console.table(
    result.slices.map((s) => ({
      month: s.month,
      tenant: s.tenantId || '(none)',
      rows: s.rows,
      beforeUsd: money(s.beforeUsd),
      afterUsd: money(s.afterUsd),
      addedUsd: money(s.afterUsd - s.beforeUsd),
    })),
  );
  const total = result.slices.reduce(
    (sum, s) => ({ before: sum.before + s.beforeUsd, after: sum.after + s.afterUsd }),
    { before: 0, after: 0 },
  );
  console.log(
    `total before $${money(total.before)}, after $${money(total.after)}, ` +
      `added $${money(total.after - total.before)}`,
  );
  console.log(
    `credit buckets to adjust: ${result.buckets.length} ` +
      `(${result.bucketsMissing} row/scope pairs had no bucket), days to rebuild: ${result.days.length}`,
  );
  if (result.auditFile) {
    console.log(`audit note: ${result.auditFile}`);
  }
  if (!apply) {
    console.log('Re-run with --apply to write the correction.');
  }
  await mongoose.disconnect();
  silentExit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
