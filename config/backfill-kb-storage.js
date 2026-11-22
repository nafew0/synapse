/**
 * Checks every knowledge base version's recorded size against its file on disk, corrects the
 * ones that differ, and writes today's storage row for every institution.
 *   node config/backfill-kb-storage.js --dry-run   reports what it would correct, writes nothing
 *   node config/backfill-kb-storage.js             corrects sizes and writes today's rows
 * Parsed text sizes are recorded only when a version is indexed; older versions are counted
 * as unmeasured until they are indexed again.
 */
const path = require('path');
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
require('~/db/models');
const mongoose = require('mongoose');
const { backfillKbStorage } = require('@librechat/api');
const { store } = require('~/server/services/kb');
const { silentExit } = require('./helpers');
const connect = require('./connect');
const db = require('~/models');

const dryRun = process.argv.includes('--dry-run');

(async () => {
  await connect();
  const result = await backfillKbStorage({ methods: db, store, dryRun });
  console.log(
    `${dryRun ? 'Dry run' : 'Backfill'}: ${result.versions} version(s), ${result.corrected} size(s) ${dryRun ? 'to correct' : 'corrected'}, ${result.unmeasuredVersions} without a parsed size, ${result.tenants} tenant row(s) written`,
  );
  if (result.missing.length > 0) {
    console.warn(`${result.missing.length} original(s) missing from disk:`);
    console.table(result.missing);
  }
  await mongoose.disconnect();
  silentExit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
