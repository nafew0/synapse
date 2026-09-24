#!/usr/bin/env node

/**
 * Manage tenant-wide agent access: adopt legacy all-users groups as the
 * tenant's system-managed audience, reconcile membership, and enable or
 * disable an agent for every active member. Dry run by default.
 *
 * Usage:
 *   node config/manage-tenant-agent-access.js \
 *     --tenant=learn \
 *     --agent=agent_office_assistant \
 *     --enable \
 *     --adopt-group=learn-all-users \
 *     --apply
 *
 * `--adopt-group` names the legacy group explicitly; `{tenant}` expands to
 * each tenant ID (e.g. `--adopt-group={tenant}-all-users --all-tenants`).
 * Groups are never adopted by fuzzy name matching.
 */

const path = require('path');
require('module-alias/register');
const moduleAlias = require('module-alias');

moduleAlias.addAlias('~', path.resolve(__dirname, '..', 'api'));
require('./helpers');

const mongoose = require('mongoose');
const { runAsSystem, InstitutionStatuses } = require('@librechat/data-schemas');
const { SystemRoles } = require('librechat-data-provider');

let shuttingDown = false;
function terminateFromSignal(signal) {
  const code = signal === 'SIGINT' ? 130 : 143;
  if (shuttingDown) {
    process.exit(code);
  }
  shuttingDown = true;
  console.error(`\nReceived ${signal}; closing the database connection...`);
  const forceExit = setTimeout(() => process.exit(code), 1500);
  forceExit.unref();
  mongoose
    .disconnect()
    .catch(() => undefined)
    .finally(() => process.exit(code));
}
process.once('SIGINT', () => terminateFromSignal('SIGINT'));
process.once('SIGTERM', () => terminateFromSignal('SIGTERM'));

const connect = require('./connect');
const models = require('~/db/models');
const db = require('~/models');
const access = require('~/server/services/tenantAgentAccess');

function splitList(value) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const args = {
    tenants: [],
    allTenants: false,
    agentId: null,
    enabled: null,
    adoptGroup: null,
    promotePlatform: false,
    apply: false,
    json: false,
  };

  for (const arg of argv) {
    if (arg === '--apply') args.apply = true;
    else if (arg === '--dry-run') args.apply = false;
    else if (arg === '--all-tenants') args.allTenants = true;
    else if (arg === '--enable') args.enabled = true;
    else if (arg === '--disable') args.enabled = false;
    else if (arg === '--promote-platform') args.promotePlatform = true;
    else if (arg === '--json') args.json = true;
    else if (arg.startsWith('--tenant=')) args.tenants.push(...splitList(arg.slice(9)));
    else if (arg.startsWith('--tenants=')) args.tenants.push(...splitList(arg.slice(10)));
    else if (arg.startsWith('--agent=')) args.agentId = arg.slice(8).trim() || null;
    else if (arg.startsWith('--adopt-group=')) args.adoptGroup = arg.slice(14).trim() || null;
    else if (arg === '--help') {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!args.allTenants && !args.tenants.length) {
    throw new Error('Pass --tenant=<id>[,<id>] or --all-tenants');
  }
  if (args.allTenants && args.tenants.length) {
    throw new Error('--tenant and --all-tenants are mutually exclusive');
  }
  if (args.enabled !== null && !args.agentId) {
    throw new Error('--enable/--disable requires --agent=<id>');
  }
  if (args.promotePlatform && !args.agentId) {
    throw new Error('--promote-platform requires --agent=<id>');
  }
  return args;
}

function printUsage() {
  console.log(`
Manage tenant-wide agent access.

Usage:
  node config/manage-tenant-agent-access.js [options]

Options:
  --tenant=a[,b]          Target tenant IDs (or --all-tenants)
  --all-tenants           Every active institution
  --agent=<id>            Master agent ID for --enable/--disable
  --enable | --disable    Grant or revoke the agent for every active member
  --adopt-group=<name>    Adopt this legacy local group as the managed audience;
                          {tenant} expands to the tenant ID
  --promote-platform      Remove tenant scope from the agent and its specialists
                          so several tenants can share one topology
  --apply                 Perform writes (default is a dry run)
  --json                  Print the summary as JSON
  --help                  Show this message

Without --enable/--disable the tool adopts (if asked) and reconciles membership.
  `);
}

async function resolveTenants(args) {
  if (!args.allTenants) {
    return args.tenants;
  }
  const institutions = await runAsSystem(() =>
    models.Institution.find({ status: InstitutionStatuses.ACTIVE })
      .select('tenantId')
      .lean()
      .exec(),
  );
  return institutions.map((institution) => institution.tenantId);
}

async function resolveActorId() {
  const [author] = await runAsSystem(() =>
    db.findUsers({ role: SystemRoles.ADMIN }, '_id', { limit: 1 }),
  );
  if (!author) {
    throw new Error('No administrator user found to record the grants');
  }
  return author._id;
}

async function promoteTopology(agentId, apply) {
  const master = await runAsSystem(() => models.Agent.findOne({ id: agentId }).lean().exec());
  if (!master) {
    throw new Error(`Master agent not found: ${agentId}`);
  }
  const ids = [master.id, ...(master.edges ?? []).map((edge) => edge?.to).filter(Boolean)];
  const scoped = await runAsSystem(() =>
    models.Agent.find({ id: { $in: ids }, tenantId: { $exists: true, $ne: null } })
      .select('id tenantId')
      .lean()
      .exec(),
  );
  if (apply && scoped.length) {
    await runAsSystem(() =>
      models.Agent.updateMany(
        { id: { $in: scoped.map((agent) => agent.id) } },
        { $unset: { tenantId: 1 } },
      ).exec(),
    );
  }
  return scoped.map((agent) => `${agent.id} (${agent.tenantId})`);
}

/** Enabling next to an unadopted legacy group would leave two parallel grants. */
async function refuseLegacyDuplicate(tenantId) {
  const legacyName = `${tenantId}-all-users`;
  const legacy = await runAsSystem(() =>
    models.Group.exists({ tenantId, name: legacyName, managedKind: { $exists: false } }),
  );
  if (legacy) {
    throw new Error(`Legacy group "${legacyName}" exists; pass --adopt-group=${legacyName}`);
  }
}

async function processTenant(tenantId, args, actorId) {
  const summary = { tenantId };

  if (args.adoptGroup) {
    summary.adoption = await access.adoptTenantAudience({
      tenantId,
      groupName: args.adoptGroup.replaceAll('{tenant}', tenantId),
      dryRun: !args.apply,
    });
  }

  if (args.enabled === null) {
    if (!summary.adoption) {
      summary.reconcile = await access.reconcileTenantAudience({
        tenantId,
        actorId,
        dryRun: !args.apply,
      });
    }
    return summary;
  }

  const state = await access.getTenantAgentAccess({ tenantId });
  if (!state.audience && !summary.adoption && args.enabled) {
    await refuseLegacyDuplicate(tenantId);
  }
  const agent = state.agents.find((item) => item.id === args.agentId);
  const pendingPromotion = args.promotePlatform && !args.apply;
  if (!agent && !pendingPromotion) {
    throw new Error(`Agent ${args.agentId} is not available to tenant ${tenantId}`);
  }
  if (!args.apply) {
    summary.access = {
      agentId: args.agentId,
      currentlyEnabled: agent?.enabled ?? false,
      wouldEnable: args.enabled,
      audience: state.audience,
    };
    return summary;
  }
  summary.access = await access.setTenantAgentAccess({
    tenantId,
    agentId: args.agentId,
    enabled: args.enabled,
    actorId,
  });
  return summary;
}

function printSummary(result, args) {
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Mode: ${args.apply ? 'APPLY' : 'DRY RUN'}`);
  if (result.promoted) {
    console.log(`[scope] Platform-wide promotion: ${result.promoted.join(', ') || 'none needed'}`);
  }
  for (const tenant of result.tenants) {
    console.log(`\n[${tenant.tenantId}]`);
    if (tenant.error) {
      console.log(`  error: ${tenant.error}`);
      continue;
    }
    if (tenant.adoption) {
      const { adopted, audienceGroupId, mismatchedAclEntries, membership } = tenant.adoption;
      console.log(`  audience: ${audienceGroupId} (${adopted ? 'adopting' : 'already managed'})`);
      console.log(`  mismatched-tenant ACL entries to repair: ${mismatchedAclEntries}`);
      console.log(
        `  members: +${membership.added} -${membership.removed} of ${membership.activeMemberCount} active`,
      );
    }
    if (tenant.reconcile === null) {
      console.log('  no managed audience; nothing to reconcile');
    } else if (tenant.reconcile) {
      const { added, removed, activeMemberCount } = tenant.reconcile;
      console.log(`  members: +${added} -${removed} of ${activeMemberCount} active`);
    }
    if (tenant.access) {
      console.log(`  access: ${JSON.stringify(tenant.access)}`);
    }
  }
  if (!args.apply) {
    console.log('\nDry run complete; re-run with --apply to write changes.');
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await connect();

  const tenants = await resolveTenants(args);
  const actorId = args.apply ? await resolveActorId() : undefined;
  const result = { apply: args.apply, tenants: [] };
  if (args.promotePlatform) {
    result.promoted = await promoteTopology(args.agentId, args.apply);
  }

  for (const tenantId of tenants) {
    try {
      result.tenants.push(await processTenant(tenantId, args, actorId));
    } catch (error) {
      result.tenants.push({ tenantId, error: error.message ?? String(error) });
    }
  }

  printSummary(result, args);
  if (result.tenants.some((tenant) => tenant.error)) {
    throw new Error('One or more tenants failed');
  }
}

let exitCode = 0;
main()
  .catch((error) => {
    console.error(`\nFailed: ${error.message ?? error}`);
    exitCode = 1;
  })
  .finally(async () => {
    try {
      await mongoose.disconnect();
    } catch {
      // Ignore disconnect errors while preserving the primary result.
    }
    // Application bootstrap can start background integrations with open
    // handles; this is a one-shot CLI, so exit explicitly.
    process.exit(exitCode);
  });
