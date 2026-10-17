const path = require('path');
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const connect = require('./connect');
const { silentExit } = require('./helpers');
const models = require('~/db/models');
const {
  getMemberQuota,
  getCalendarWeekRange,
  getCalendarMonthRange,
} = require('~/server/services/usageQuota');

/**
 * Local harness for the usage quota: seed an enforcing policy with small limits,
 * read a member's remaining allowance, and clear buckets between runs.
 *
 * Enforce mode needs MongoDB transactions, i.e. a replica set or mongos. A
 * standalone mongod raises QUOTA_ENFORCEMENT_REQUIRES_TRANSACTIONS on the first
 * request instead of enforcing.
 */
const USAGE = `
Usage: node config/usage-quota.js <command> [options]

  status  --tenant=<id> [--email=<user>]   Show the policy and a member's remaining allowance
  seed    --tenant=<id> [limits]           Create the NEXT policy version in enforce mode
  shadow  --tenant=<id>                    Create the next version back in shadow mode
  reset   --tenant=<id> [--email=<user>]   Delete usage buckets so limits start fresh

Limit options for 'seed' (omit for values small enough to trip in a few messages):
  --tokens=N --tokens-weekly=N --images=N --images-weekly=N
  Pass 'null' for any of them to make that meter unlimited.

Examples:
  node config/usage-quota.js status --tenant=bdren --email=someone@bdren.net.bd
  node config/usage-quota.js seed   --tenant=bdren --tokens-weekly=5000
  node config/usage-quota.js reset  --tenant=bdren
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (const raw of argv) {
    if (!raw.startsWith('--')) {
      args._.push(raw);
      continue;
    }
    const [key, value = 'true'] = raw.slice(2).split('=');
    args[key] = value;
  }
  return args;
}

/** `null` is meaningful here — it is how a meter is made unlimited. */
function fail(message) {
  console.red(message);
  silentExit(1);
}

function limitOf(value, fallback) {
  if (value === undefined) {
    return fallback;
  }
  if (value === 'null') {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    fail(`Invalid limit: ${value}`);
  }
  return parsed;
}

function describeMeter(meter) {
  const scope = `${meter.meter}/${meter.window}`.padEnd(15);
  const used = String(meter.used).padStart(10);
  const limit = meter.unlimited ? 'unlimited' : String(meter.limit).padStart(10);
  const remaining = meter.unlimited ? '-' : String(meter.remaining).padStart(10);
  const flag = meter.blocked ? '  <== BLOCKED' : '';
  return `  ${scope} used ${used}   limit ${limit}   remaining ${remaining}   resets ${meter.resetsAt}${flag}`;
}

async function requireInstitution(tenantId) {
  const institution = await models.Institution.findOne({ tenantId }).lean();
  if (!institution) {
    fail(`No institution with tenantId "${tenantId}".`);
  }
  return institution;
}

async function activePolicy(tenantId, institution) {
  return models.UsagePolicy.findOne({
    tenantId,
    version: institution.usagePolicyVersion ?? 0,
  }).lean();
}

async function status(args) {
  const tenantId = args.tenant;
  const institution = await requireInstitution(tenantId);
  const policy = await activePolicy(tenantId, institution);
  console.purple(`\nInstitution ${tenantId} — policy version ${institution.usagePolicyVersion}`);
  if (!policy) {
    console.orange('  No policy document for that version; defaults apply (shadow, no limits).');
  } else {
    console.log(`  mode      ${policy.mode}`);
    console.log(`  period    ${JSON.stringify(policy.period)}`);
    console.log(`  limits    ${JSON.stringify(policy.limits)}`);
  }
  console.purple('\nWindows (UTC — the international standard, not the tenant timezone)');
  console.log(`  week  ${JSON.stringify(getCalendarWeekRange('UTC'))}`);
  console.log(`  month ${JSON.stringify(getCalendarMonthRange('UTC'))}`);

  if (!args.email) {
    return;
  }
  const user = await models.User.findOne({ email: args.email, tenantId }).lean();
  if (!user) {
    fail(`No user "${args.email}" in tenant "${tenantId}".`);
  }
  const quota = await getMemberQuota({ tenantId, userId: user._id });
  console.purple(`\nAllowance for ${args.email} (enforced: ${quota.enforced})`);
  quota.meters.forEach((meter) => console.log(describeMeter(meter)));
}

async function seed(args, mode) {
  const tenantId = args.tenant;
  const institution = await requireInstitution(tenantId);
  const current = institution.usagePolicyVersion ?? 0;
  const version = current + 1;

  const limits = {
    institutionTokens: limitOf(args['institution-tokens'], null),
    memberTokens: limitOf(args.tokens, 20000),
    memberTokensWeekly: limitOf(args['tokens-weekly'], 5000),
    memberImages: limitOf(args.images, 3),
    memberImagesWeekly: limitOf(args['images-weekly'], 2),
    modelTokens: [],
  };

  /** `mode` is immutable on the schema, so switching between shadow and enforce
   *  is always a NEW version rather than an update. */
  await models.UsagePolicy.create({
    tenantId,
    version,
    mode,
    timezone: institution.timezone || 'Asia/Dhaka',
    period: ['calendar_month', 'calendar_week'],
    limits,
    inputSafetyFactor: 1,
    inputSafetyTokens: 0,
    effectiveAt: new Date(),
    reason: `local quota harness (${mode})`,
  });
  await models.Institution.updateOne({ tenantId }, { $set: { usagePolicyVersion: version } });

  console.green(`\nPolicy v${version} created for ${tenantId} in ${mode} mode.`);
  console.log(`  limits ${JSON.stringify(limits)}`);
  console.orange('\nRestart the backend so the new policy is picked up, then send a few messages.');
}

async function reset(args) {
  const tenantId = args.tenant;
  await requireInstitution(tenantId);
  const filter = { tenantId };
  if (args.email) {
    const user = await models.User.findOne({ email: args.email, tenantId }).lean();
    if (!user) {
      fail(`No user "${args.email}" in tenant "${tenantId}".`);
    }
    filter.scopeKey = String(user._id);
  }
  const buckets = await models.UsageBucket.deleteMany(filter);
  const reservations = await models.UsageReservation.deleteMany({ tenantId });
  console.green(
    `\nCleared ${buckets.deletedCount} bucket(s) and ${reservations.deletedCount} reservation(s).`,
  );
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (!command || args.help) {
    console.log(USAGE);
    silentExit(0);
  }
  if (!args.tenant) {
    console.log(USAGE);
    fail('--tenant is required.');
  }

  await connect();

  const supported = await models.UsageBucket.db.db
    .admin()
    .command({ hello: 1 })
    .then((info) => Boolean(info.setName || info.msg === 'isdbgrid'))
    .catch(() => false);
  if (!supported && (command === 'seed' || command === 'status')) {
    console.orange(
      '\nWARNING: this MongoDB is standalone. Enforce mode needs transactions —\n' +
        'requests will fail with QUOTA_ENFORCEMENT_REQUIRES_TRANSACTIONS rather than\n' +
        'be refused by the quota. Run mongod with --replSet to test enforcement.',
    );
  }

  if (command === 'status') {
    await status(args);
  } else if (command === 'seed') {
    await seed(args, 'enforce');
  } else if (command === 'shadow') {
    await seed(args, 'shadow');
  } else if (command === 'reset') {
    await reset(args);
  } else {
    console.log(USAGE);
    fail(`Unknown command: ${command}`);
  }

  silentExit(0);
})();
