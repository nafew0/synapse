#!/usr/bin/env node

/**
 * Grant one Office Assistant topology to multiple tenant groups.
 *
 * This script is intentionally dry-run by default. It does not create duplicate
 * Agent documents: stable agent IDs must remain unique. When an existing agent
 * is tenant-scoped, pass --promote-platform before applying a multi-tenant grant
 * so the shared topology can be resolved by every target tenant.
 *
 * Usage:
 *   node config/grant-office-agent-multi-tenant.js \
 *     --agent=agent_office_assistant \
 *     --tenants=bdren,learn \
 *     --group-names=bdren-all-users,learn-all-users \
 *     --promote-platform --create-groups --apply
 *
 * Existing groups may be used without --create-groups. When creating groups,
 * every current user in each tenant is added using the same member-key shape
 * used by the normal group membership implementation.
 */

const path = require('path');
require('module-alias/register');
const moduleAlias = require('module-alias');

moduleAlias.addAlias('~', path.resolve(__dirname, '..', 'api'));
require('./helpers');

const mongoose = require('mongoose');
const { createModels, runAsSystem } = require('@librechat/data-schemas');
const {
  AccessRoleIds,
  PrincipalType,
  ResourceType,
  SystemRoles,
} = require('librechat-data-provider');

// This is a one-shot migration CLI, but importing the application models can
// start background timers/listeners. Install signal handlers before connecting
// so Ctrl+C/SIGTERM cannot leave the process stuck in the event loop.
let shuttingDown = false;
function terminateFromSignal(signal) {
  if (shuttingDown) {
    process.exit(signal === 'SIGINT' ? 130 : 143);
  }
  shuttingDown = true;
  const code = signal === 'SIGINT' ? 130 : 143;
  console.error(`\\nReceived ${signal}; closing the database connection...`);
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
const { grantPermission } = require('~/server/services/PermissionService');

const { Agent, Group, User } = createModels(mongoose);

function parseArgs(argv) {
  const args = {
    agentId: 'agent_office_assistant',
    tenants: [],
    groupNames: [],
    createGroups: false,
    promotePlatform: false,
    apply: false,
  };

  for (const arg of argv) {
    if (arg === '--apply') args.apply = true;
    else if (arg === '--create-groups') args.createGroups = true;
    else if (arg === '--promote-platform') args.promotePlatform = true;
    else if (arg.startsWith('--agent=')) args.agentId = arg.slice('--agent='.length).trim();
    else if (arg.startsWith('--tenants=')) {
      args.tenants = arg
        .slice('--tenants='.length)
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
    } else if (arg.startsWith('--group-names=')) {
      args.groupNames = arg
        .slice('--group-names='.length)
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
    } else if (arg === '--help') {
      printUsage();
      process.exit(0);
    }
  }

  if (!args.tenants.length) {
    throw new Error('--tenants=tenant-a,tenant-b is required');
  }
  if (args.groupNames.length && args.groupNames.length !== args.tenants.length) {
    throw new Error('--group-names must contain one name per tenant, in the same order');
  }

  return args;
}

function printUsage() {
  console.log(`
Grant an Office Assistant topology to multiple tenants.

Usage:
  node config/grant-office-agent-multi-tenant.js [options]

Options:
  --agent=<id>                  Master agent ID (default: agent_office_assistant)
  --tenants=a,b                 Required comma-separated tenant IDs
  --group-names=a,b             Optional group name per tenant
  --create-groups               Create missing local groups and add all tenant users
  --promote-platform             Remove tenant scope from master and specialists
  --apply                       Perform writes (default is a dry run)
  --help                        Show this message

Always run the dry run first. Do not use --public: this script grants the master
to tenant groups and specialists only through REMOTE_AGENT_VIEWER delegation.
  `);
}

async function loadTopology(agentId) {
  const master = await runAsSystem(() => Agent.findOne({ id: agentId }).lean().exec());
  if (!master) throw new Error(`Master agent not found: ${agentId}`);

  const specialistIds = (master.edges || [])
    .map((edge) => edge.to)
    .filter((id) => typeof id === 'string' && id.length > 0);
  const specialists = specialistIds.length
    ? await runAsSystem(() => Agent.find({ id: { $in: specialistIds } }).lean().exec())
    : [];
  const missing = specialistIds.filter((id) => !specialists.some((agent) => agent.id === id));
  if (missing.length) throw new Error(`Missing specialist agent records: ${missing.join(', ')}`);

  return { master, specialists };
}

async function ensurePlatformScope(topology, args) {
  const scoped = [topology.master, ...topology.specialists].filter((agent) => agent.tenantId);
  const hasForeignScope = scoped.some((agent) => !args.tenants.includes(agent.tenantId));
  if (scoped.length && args.tenants.length > 1 && !args.promotePlatform) {
    throw new Error(
      'Agents are tenant-scoped. Re-run with --promote-platform to share the existing topology.',
    );
  }
  if (!args.apply || !args.promotePlatform || !scoped.length) return;

  await runAsSystem(async () => {
    for (const agent of [topology.master, ...topology.specialists]) {
      await Agent.updateOne({ _id: agent._id }, { $unset: { tenantId: 1 } }).exec();
    }
  });
  console.log(`[scope] Promoted ${scoped.length} tenant-scoped agent(s) to platform-wide scope`);
  if (hasForeignScope) console.log('[scope] Existing tenant scope was replaced intentionally');
}

async function resolveGroup(tenantId, groupName, args) {
  let group = await runAsSystem(() =>
    Group.findOne({ tenantId, name: groupName }).lean().exec(),
  );
  const users = await runAsSystem(() => User.find({ tenantId }).select('_id idOnTheSource').lean().exec());
  const memberIds = users.map((user) => user.idOnTheSource || user._id.toString());

  if (!group) {
    if (!args.createGroups) {
      throw new Error(
        `Group "${groupName}" not found for tenant "${tenantId}"; use --create-groups or create it first`,
      );
    }
    if (!args.apply) {
      console.log(`[dry-run] Would create ${groupName} for ${tenantId} with ${memberIds.length} member(s)`);
      return { _id: `dry-run-${tenantId}`, tenantId, name: groupName, memberIds };
    }
    group = await runAsSystem(() =>
      Group.create({
        name: groupName,
        description: `All users in the ${tenantId} tenant`,
        source: 'local',
        tenantId,
        memberIds,
      }),
    );
    console.log(`[group] Created ${groupName} for ${tenantId} (${memberIds.length} member(s))`);
    return group;
  }

  if (args.apply && memberIds.length) {
    await runAsSystem(() =>
      Group.updateOne({ _id: group._id }, { $addToSet: { memberIds: { $each: memberIds } } }).exec(),
    );
    console.log(`[group] Synchronized ${group.name} for ${tenantId} (${memberIds.length} tenant user(s))`);
  } else {
    console.log(`[group] Using ${group.name} for ${tenantId}`);
  }
  return group;
}

async function grantTopology(topology, groups, authorId, args) {
  for (const { tenantId, group } of groups) {
    if (!args.apply) {
      console.log(`[dry-run] Would grant AGENT_VIEWER on ${topology.master.id} to ${group.name} (${tenantId})`);
      console.log(`[dry-run] Would grant REMOTE_AGENT_VIEWER for ${topology.specialists.length} specialist(s)`);
      continue;
    }

    await grantPermission({
      principalType: PrincipalType.GROUP,
      principalId: group._id,
      resourceType: ResourceType.AGENT,
      resourceId: topology.master._id,
      accessRoleId: AccessRoleIds.AGENT_VIEWER,
      grantedBy: authorId,
      tenantId,
    });
    for (const specialist of topology.specialists) {
      await grantPermission({
        principalType: PrincipalType.GROUP,
        principalId: group._id,
        resourceType: ResourceType.REMOTE_AGENT,
        resourceId: specialist._id,
        accessRoleId: AccessRoleIds.REMOTE_AGENT_VIEWER,
        grantedBy: authorId,
        tenantId,
      });
    }
    console.log(`[grant] ${topology.master.id} enabled for ${group.name} (${tenantId})`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await connect();

  const db = require('~/models');
  const [author] = await runAsSystem(() =>
    db.findUsers({ role: SystemRoles.ADMIN }, '_id email role', { limit: 1 }),
  );
  if (!author) throw new Error('No administrator user found to record the grants');

  const topology = await loadTopology(args.agentId);
  console.log(`Mode: ${args.apply ? 'APPLY' : 'DRY RUN'}`);
  console.log(`Master: ${topology.master.id}`);
  console.log(`Tenants: ${args.tenants.join(', ')}`);

  await ensurePlatformScope(topology, args);
  const groups = [];
  for (let index = 0; index < args.tenants.length; index += 1) {
    const tenantId = args.tenants[index];
    const groupName = args.groupNames[index] || `${tenantId}-all-users`;
    groups.push({ tenantId, group: await resolveGroup(tenantId, groupName, args) });
  }
  await grantTopology(topology, groups, author._id, args);
  console.log(args.apply ? 'Synchronization complete.' : 'Dry run complete; re-run with --apply to write changes.');
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
    // The application bootstrap can initialize background integrations with
    // open handles. This is a one-shot migration CLI, so terminate explicitly
    // after the database connection is closed.
    process.exit(exitCode);
  });
