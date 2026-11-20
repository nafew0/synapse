/**
 * Moves Synapse's local-password users to ZITADEL (bdren.ai SSO), keeping their password, `_id`,
 * institution and data. Dry run by default. Runbook: docs/migrate-users-to-zitadel.md.
 */
const fs = require('fs');
const path = require('path');
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const {
  isProductionDbName,
  createZitadelClient,
  unlinkMigratedUser,
  migrateUsersToZitadel,
} = require('@librechat/api');

const TOKEN_ENV = 'ZITADEL_MIGRATION_TOKEN';
const PRODUCTION_FLAG = '--i-know-this-is-production';

const USAGE = `Usage: node config/migrate-users-to-zitadel.js [options]

  --dry-run                  Report what would happen (default). Asks ZITADEL read-only when a token is set.
  --apply                    Create ZITADEL users and link the Synapse accounts.
  --db <name>                Database to use (replaces the database in MONGO_URI).
  ${PRODUCTION_FLAG}  Required for a database whose name contains "prod".
  --zitadel-url <url>        ZITADEL address (default ZITADEL_URL, else OPENID_ISSUER).
  --issuer <url>             OpenID issuer stored on accounts (default OPENID_ISSUER).
  --org-id <id>              ZITADEL organization for individuals and unmapped tenants (default ZITADEL_DEFAULT_ORG_ID).
  --org-map <file.json>      {"<tenantId or bdrenOrganizationId>": "<ZITADEL org id>", ...}
  --unmapped default|skip    Users of a tenant without a mapping: default organization (default) or skip.
  --include-admins           Also migrate platform admins (ADMIN role); by default they keep the local login.
  --batch-size <n>           Users handled at once (default 20).
  --user <id>                Only this Synapse user _id (repeatable).
  --report <file>            Report path (default logs/zitadel-migration/<db>-<mode>-<time>.json).
  --offline                  Dry run without asking ZITADEL.
  --unlink <id>              Roll one migrated account back to its local password, then exit.

  The service user's token is read from ${TOKEN_ENV} and never printed.`;

function readArgs(argv) {
  const args = { apply: false, users: [], unmapped: 'default', batchSize: 20 };
  const valueOf = (index) => {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${argv[index]} needs a value`);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inline] = arg.includes('=') ? arg.split(/=(.*)/s) : [arg, undefined];
    const take = () => {
      if (inline !== undefined) {
        return inline;
      }
      i += 1;
      return valueOf(i - 1);
    };
    switch (flag) {
      case '--apply':
        args.apply = true;
        break;
      case '--dry-run':
        args.apply = false;
        break;
      case PRODUCTION_FLAG:
        args.production = true;
        break;
      case '--include-admins':
        args.includeAdmins = true;
        break;
      case '--offline':
        args.offline = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--db':
        args.db = take();
        break;
      case '--zitadel-url':
        args.zitadelUrl = take();
        break;
      case '--issuer':
        args.issuer = take();
        break;
      case '--org-id':
        args.orgId = take();
        break;
      case '--org-map':
        args.orgMap = take();
        break;
      case '--unmapped':
        args.unmapped = take();
        break;
      case '--batch-size':
        args.batchSize = Number(take());
        break;
      case '--user':
        args.users.push(take());
        break;
      case '--report':
        args.report = take();
        break;
      case '--unlink':
        args.unlink = take();
        break;
      default:
        throw new Error(`Unknown option ${arg}`);
    }
  }
  return args;
}

/** MONGO_URI with its database replaced by `db`, and the database name in effect. */
function resolveDatabase(uri, db) {
  if (!uri) {
    throw new Error('MONGO_URI is not set');
  }
  const url = new URL(uri);
  if (db) {
    url.pathname = `/${db}`;
  }
  const name = decodeURIComponent(url.pathname.replace(/^\//, '')) || 'test';
  return { uri: url.toString(), name };
}

function readOrganizationMap(file) {
  if (!file) {
    return {};
  }
  const map = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  const valid =
    map &&
    typeof map === 'object' &&
    !Array.isArray(map) &&
    Object.values(map).every((value) => typeof value === 'string' && value);
  if (!valid) {
    throw new Error('--org-map must be a JSON object of non-empty strings');
  }
  return map;
}

function reportPath(args, dbName) {
  if (args.report) {
    return path.resolve(args.report);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const mode = args.apply ? 'apply' : 'dry-run';
  return path.resolve(
    __dirname,
    '..',
    'logs',
    'zitadel-migration',
    `${dbName}-${mode}-${stamp}.json`,
  );
}

function writeReport(file, report) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

/** Decrypts a stored TOTP secret the way Synapse's own 2FA check does; needs the app's CREDS_KEY. */
function totpReader() {
  try {
    const { getTOTPSecret } = require('~/server/services/twoFactorService');
    return (stored) => getTOTPSecret(stored);
  } catch (error) {
    console.warn(`2FA secrets cannot be read here (${error.message}); none will be imported.`);
    return undefined;
  }
}

function printSummary(report, file) {
  console.log(`\nMode: ${report.mode}  ZITADEL checked: ${report.zitadelChecked}`);
  console.log(`Users scanned: ${report.scanned}`);
  console.log('By status:', JSON.stringify(report.counts));
  console.log('Conflicts:', JSON.stringify(report.conflicts));
  console.log('Flags:', JSON.stringify(report.flags));
  console.log('Tenants:');
  for (const [tenant, summary] of Object.entries(report.tenants)) {
    console.log(`  ${tenant}: ${JSON.stringify(summary)}`);
  }
  console.log(`Report: ${file}`);
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const database = resolveDatabase(process.env.MONGO_URI, args.db);
  if (isProductionDbName(database.name) && !args.production) {
    throw new Error(
      `Refusing database "${database.name}": it looks like production. Add ${PRODUCTION_FLAG} to run against it.`,
    );
  }
  if (!['default', 'skip'].includes(args.unmapped)) {
    throw new Error('--unmapped must be "default" or "skip"');
  }
  if (!Number.isInteger(args.batchSize) || args.batchSize < 1) {
    throw new Error('--batch-size must be a positive integer');
  }

  await mongoose.connect(database.uri);
  const db = mongoose.connection.db;
  console.log(`Database: ${database.name}`);

  if (args.unlink) {
    const result = await unlinkMigratedUser(db, args.unlink);
    console.log(`Unlink ${args.unlink}: ${result}`);
    return;
  }

  const issuer = args.issuer || process.env.OPENID_ISSUER;
  const organizationId = args.orgId || process.env.ZITADEL_DEFAULT_ORG_ID;
  const zitadelUrl = args.zitadelUrl || process.env.ZITADEL_URL || issuer;
  const token = process.env[TOKEN_ENV];
  if (!issuer) {
    throw new Error('Set --issuer or OPENID_ISSUER');
  }
  if (!organizationId) {
    throw new Error('Set --org-id or ZITADEL_DEFAULT_ORG_ID');
  }
  const useZitadel = !args.offline && Boolean(token);
  if (args.apply && !useZitadel) {
    throw new Error(`--apply needs ${TOKEN_ENV} and cannot be --offline`);
  }
  if (!args.apply && !args.offline && !token) {
    console.warn(`${TOKEN_ENV} is not set: planning without asking ZITADEL.`);
  }

  const file = reportPath(args, database.name);
  const report = await migrateUsersToZitadel(
    {
      db,
      zitadel: useZitadel ? createZitadelClient({ baseUrl: zitadelUrl, token }) : undefined,
      readTotpSecret: totpReader(),
    },
    {
      apply: args.apply,
      issuer,
      defaultOrganizationId: organizationId,
      organizationMap: readOrganizationMap(args.orgMap),
      unmapped: args.unmapped,
      includeAdmins: args.includeAdmins === true,
      batchSize: args.batchSize,
      userIds: args.users,
      onBatch: (progress) => {
        writeReport(file, progress);
        process.stdout.write(`\r${progress.scanned} users handled`);
      },
    },
  );
  writeReport(file, report);
  printSummary(report, file);
}

main()
  .catch((error) => {
    console.error(`\n${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
    /** Loaded app modules (2FA service, caches) keep handles open; this is a one-shot command. */
    process.exit(process.exitCode ?? 0);
  });
