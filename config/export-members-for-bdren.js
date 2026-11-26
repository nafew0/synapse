/**
 * Lists the migrated institution admins and members of every institution linked to bdren.ai, for
 * bdren.ai's `manage.py import_synapse_members`. Read-only. The file holds emails: it is written
 * with mode 600 and its contents are never printed. Runbook: docs/migrate-users-to-zitadel.md.
 */
const fs = require('fs');
const path = require('path');
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const {
  withDatabase,
  isProductionDbName,
  createZitadelClient,
  exportMembersForBdren,
} = require('@librechat/api');

const TOKEN_ENV = 'ZITADEL_MIGRATION_TOKEN';
const PRODUCTION_FLAG = '--i-know-this-is-production';

const USAGE = `Usage: node config/export-members-for-bdren.js --out <file> [options]

  --out <file>               Where to write the export (mode 600). Required.
  --db <name>                Database to read (replaces the database in MONGO_URI).
  ${PRODUCTION_FLAG}  Required for a database whose name contains "prod".
  --issuer <url>             BDREN OpenID issuer (default OPENID_ISSUER).
  --org-map <file>           JSON {"<tenantId>": "<bdren.ai organization id>"} for institutions
                             without a stored bdrenOrganizationId (nothing is written to the database).
  --lookup-zitadel           Also export people still on password login whose ZITADEL account
                             already exists (same id, or the same verified email). Needs ${TOKEN_ENV}.
  --zitadel-url <url>        ZITADEL address (default ZITADEL_URL, else the issuer).
  --org-id <id>              ZITADEL organization a linkable account must be in (default ZITADEL_DEFAULT_ORG_ID).

  Only counts are printed; the file holds names and emails.`;

function readArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].includes('=') ? argv[i].split(/=(.*)/s) : [argv[i], undefined];
    const take = () => {
      if (inline !== undefined) {
        return inline;
      }
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${flag} needs a value`);
      }
      i += 1;
      return value;
    };
    switch (flag) {
      case PRODUCTION_FLAG:
        args.production = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--out':
        args.out = take();
        break;
      case '--db':
        args.db = take();
        break;
      case '--issuer':
        args.issuer = take();
        break;
      case '--org-map':
        args.orgMap = take();
        break;
      case '--lookup-zitadel':
        args.lookupZitadel = true;
        break;
      case '--zitadel-url':
        args.zitadelUrl = take();
        break;
      case '--org-id':
        args.orgId = take();
        break;
      default:
        throw new Error(`Unknown option ${argv[i]}`);
    }
  }
  return args;
}

const configuredSuperadmins = () =>
  (process.env.PLATFORM_SUPERADMIN_EMAILS || '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);

function readOrgMap(file) {
  if (!file) {
    return undefined;
  }
  const map = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  const valid =
    map &&
    typeof map === 'object' &&
    !Array.isArray(map) &&
    Object.values(map).every((id) => typeof id === 'string' && id.trim());
  if (!valid) {
    throw new Error('--org-map must be {"<tenantId>": "<bdren.ai organization id>"}');
  }
  return map;
}

function zitadelLookup(args, issuer) {
  if (!args.lookupZitadel) {
    return undefined;
  }
  const token = process.env[TOKEN_ENV];
  const organizationId = args.orgId || process.env.ZITADEL_DEFAULT_ORG_ID;
  if (!token) {
    throw new Error(`--lookup-zitadel needs ${TOKEN_ENV}`);
  }
  if (!organizationId) {
    throw new Error('--lookup-zitadel needs --org-id or ZITADEL_DEFAULT_ORG_ID');
  }
  const baseUrl = args.zitadelUrl || process.env.ZITADEL_URL || issuer;
  return { client: createZitadelClient({ baseUrl, token }), organizationId };
}

/** Writes `data` readable by the owner only, also when the file already existed. */
function writePrivate(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, data, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function printSummary(result, file) {
  console.log(`Issuer: ${result.issuer}`);
  console.log('Organizations:');
  for (const org of result.organizations) {
    console.log(`  ${org.tenantId} -> ${org.organizationId}: ${JSON.stringify(org.counts)}`);
  }
  console.log('Skipped institutions:');
  for (const skipped of result.skipped.institutions) {
    console.log(`  ${skipped.tenantId}: ${skipped.reason} (${skipped.users} users)`);
  }
  console.log('Skipped people:', JSON.stringify(result.skipped.people));
  console.log(`Export: ${file} (mode 600; contains emails, do not share)`);
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (!args.out) {
    throw new Error('--out <file> is required');
  }
  if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI is not set');
  }
  const database = withDatabase(process.env.MONGO_URI, args.db);
  if (isProductionDbName(database.name) && !args.production) {
    throw new Error(
      `Refusing database "${database.name}": it looks like production. Add ${PRODUCTION_FLAG} to run against it.`,
    );
  }
  const issuer = args.issuer || process.env.OPENID_ISSUER;
  if (!issuer) {
    throw new Error('Set --issuer or OPENID_ISSUER');
  }

  await mongoose.connect(database.uri);
  console.log(`Database: ${database.name}`);
  const result = await exportMembersForBdren(mongoose.connection.db, {
    issuer,
    staffEmails: configuredSuperadmins(),
    organizationIds: readOrgMap(args.orgMap),
    zitadel: zitadelLookup(args, issuer),
  });
  const file = path.resolve(args.out);
  writePrivate(file, `${JSON.stringify(result, null, 2)}\n`);
  printSummary(result, file);
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
    process.exit(process.exitCode ?? 0);
  });
