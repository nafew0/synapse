/**
 * Builds the UsageDaily rollup from the first Transaction to today.
 *   node config/backfill-usage-daily.js --dry-run   prints totals per month and service, writes nothing
 *   node config/backfill-usage-daily.js             builds every day and checks it against the ledger
 */
const path = require('path');
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
require('~/db/models');
const mongoose = require('mongoose');
const { backfillUsageDaily } = require('@librechat/api');
const { silentExit } = require('./helpers');
const connect = require('./connect');

const dryRun = process.argv.includes('--dry-run');

(async () => {
  await connect();
  const result = await backfillUsageDaily({ dryRun });
  console.log(
    `${dryRun ? 'Dry run' : 'Backfill'}: ${result.days} day(s) from ${result.from ?? '-'} to ${result.to ?? '-'}`,
  );
  console.table(result.months.map((m) => ({ ...m, costUsd: Number(m.costUsd.toFixed(6)) })));
  const bad = result.reconciliations.filter((check) => !check.ok);
  if (bad.length > 0) {
    console.error(`${bad.length} day(s) do not match the ledger:`, bad);
    await mongoose.disconnect();
    process.exit(1);
  }
  await mongoose.disconnect();
  silentExit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
