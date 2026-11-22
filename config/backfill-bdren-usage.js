/**
 * Sends past days of per-member usage to bdren.ai (the hourly job only catches up 60 days).
 *   node config/backfill-bdren-usage.js --from 2026-11-01 --to 2026-11-14 --dry-run   counts, sends nothing
 *   node config/backfill-bdren-usage.js --from 2026-11-01 --to 2026-11-14             sends each day (replaces it there)
 * Needs BDREN_API_URL, BDREN_PRODUCT_KEY, BDREN_ISSUER and BDREN_USAGE_EXPORT_ENABLED=true.
 */
const path = require('path');
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
require('~/db/models');
const mongoose = require('mongoose');
const { backfillBdrenUsage, readBdrenConfig } = require('@librechat/api');
const { silentExit } = require('./helpers');
const connect = require('./connect');

const arg = (name) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};
const dryRun = process.argv.includes('--dry-run');
const from = arg('--from');
const to = arg('--to');

(async () => {
  const config = readBdrenConfig();
  if (!config.usageExport) {
    throw new Error(
      'Set BDREN_API_URL, BDREN_PRODUCT_KEY, BDREN_ISSUER and BDREN_USAGE_EXPORT_ENABLED=true',
    );
  }
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(from ?? '') ||
    !/^\d{4}-\d{2}-\d{2}$/.test(to ?? '') ||
    from > to
  ) {
    throw new Error('Pass --from YYYY-MM-DD and --to YYYY-MM-DD (from not after to)');
  }
  await connect();
  const result = await backfillBdrenUsage({ config, from, to, dryRun });
  console.log(`${dryRun ? 'Dry run' : 'Sent'}: ${result.days.length} day(s) ${from}..${to}`);
  console.table(result.days);
  await mongoose.disconnect();
  silentExit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
