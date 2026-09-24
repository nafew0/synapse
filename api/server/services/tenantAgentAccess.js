const {
  logger,
  runAsSystem,
  InstitutionStatuses,
  InstitutionMembershipStatuses,
} = require('@librechat/data-schemas');
const {
  AccessRoleIds,
  PermissionBits,
  PrincipalType,
  ResourceType,
} = require('librechat-data-provider');
const { grantPermission } = require('./PermissionService');
const db = require('~/models');
const models = require('~/db/models');

/**
 * Tenant-wide agent access.
 *
 * Every tenant that has at least one tenant-wide agent owns exactly one
 * system-managed group whose members are the tenant's active users. Agent ACLs
 * are granted to that group, so the existing group-principal resolver provides
 * access, and member lifecycle events keep the group exact.
 */

const TENANT_AUDIENCE_KIND = 'tenant_all_active_members';
const DUPLICATE_KEY_CODE = 11000;

class TenantAgentAccessError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'TenantAgentAccessError';
    this.statusCode = statusCode;
  }
}

function activeMemberFilter(tenantId) {
  return {
    tenantId,
    $or: [
      { membershipStatus: InstitutionMembershipStatuses.ACTIVE },
      { membershipStatus: { $exists: false } },
      { membershipStatus: null },
    ],
  };
}

function isActiveMember(user, tenantId) {
  if (!user || user.tenantId !== tenantId) {
    return false;
  }
  const status = user.membershipStatus;
  return status == null || status === InstitutionMembershipStatuses.ACTIVE;
}

/** Group membership resolves by `idOnTheSource` first, then the ObjectId string. */
function canonicalMemberKey(user) {
  return user.idOnTheSource || user._id.toString();
}

function allMemberKeys(user) {
  return [...new Set([user.idOnTheSource, user._id?.toString()].filter(Boolean))];
}

function platformOrTenantScope(tenantId) {
  return { $or: [{ tenantId }, { tenantId: { $exists: false } }, { tenantId: null }] };
}

function audienceName(institution) {
  return `${institution?.name || institution?.tenantId} — All active members`;
}

async function findAudience(tenantId) {
  return await runAsSystem(() => db.findGroupByManagedKind(tenantId, TENANT_AUDIENCE_KIND));
}

/** Creates the audience once; a concurrent creator loses the unique-index race and re-reads. */
async function ensureTenantAudience(institution) {
  const { tenantId } = institution;
  const existing = await findAudience(tenantId);
  if (existing) {
    return { audience: existing, created: false };
  }
  try {
    const audience = await runAsSystem(async () =>
      (
        await models.Group.create({
          name: audienceName(institution),
          description:
            'System-managed group for tenant-wide access. Membership is synchronized automatically.',
          source: 'local',
          tenantId,
          managedKind: TENANT_AUDIENCE_KIND,
          memberIds: [],
        })
      ).toObject(),
    );
    logger.info('[tenantAgentAccess] tenant_agent_access.audience_created', {
      tenantId,
      audienceGroupId: audience._id.toString(),
    });
    return { audience, created: true };
  } catch (error) {
    if (error?.code !== DUPLICATE_KEY_CODE) {
      throw error;
    }
    const audience = await findAudience(tenantId);
    if (!audience) {
      throw error;
    }
    return { audience, created: false };
  }
}

async function loadActiveMemberKeys(tenantId) {
  const users = await runAsSystem(() =>
    models.User.find(activeMemberFilter(tenantId)).select('_id idOnTheSource').lean().exec(),
  );
  return new Set(users.map(canonicalMemberKey));
}

/**
 * Compares the audience with the tenant's active users. The group is read
 * before the users so a member enrolled concurrently is never pruned.
 */
async function measureDrift(audience, tenantId) {
  const current = new Set((audience.memberIds ?? []).map(String));
  const desired = await loadActiveMemberKeys(tenantId);
  const missing = [...desired].filter((key) => !current.has(key));
  const stale = [...current].filter((key) => !desired.has(key));
  return {
    missing,
    stale,
    activeMemberCount: desired.size,
    enrolledMemberCount: current.size,
  };
}

async function applyMemberChanges(audienceId, changes) {
  return await runAsSystem(() => db.updateManagedGroupMembers(audienceId, changes));
}

async function reconcileAudience(audience, tenantId, { dryRun = false } = {}) {
  const drift = await measureDrift(audience, tenantId);
  if (!dryRun && (drift.missing.length || drift.stale.length)) {
    await applyMemberChanges(audience._id, { add: drift.missing, remove: drift.stale });
  }
  return {
    tenantId,
    audienceGroupId: audience._id.toString(),
    dryRun,
    added: drift.missing.length,
    removed: drift.stale.length,
    unchanged: drift.enrolledMemberCount - drift.stale.length,
    activeMemberCount: drift.activeMemberCount,
  };
}

/**
 * Makes the tenant's managed audience exactly equal to its active users.
 * Returns `null` when the tenant has no audience (no tenant-wide agents).
 */
async function reconcileTenantAudience({ tenantId, actorId, dryRun = false }) {
  const audience = await findAudience(tenantId);
  if (!audience) {
    return null;
  }
  try {
    const result = await reconcileAudience(audience, tenantId, { dryRun });
    if (result.added || result.removed) {
      logger.info('[tenantAgentAccess] tenant_agent_access.reconciled', { ...result, actorId });
    }
    return result;
  } catch (error) {
    logger.error('[tenantAgentAccess] tenant_agent_access.reconcile_failed', {
      tenantId,
      actorId,
      error: error?.message,
    });
    throw error;
  }
}

async function loadMemberSnapshot(userId) {
  return await runAsSystem(() =>
    models.User.findById(userId)
      .select('_id idOnTheSource tenantId membershipStatus')
      .lean()
      .exec(),
  );
}

/**
 * Brings one user's audience membership in line with their authoritative
 * account state. `previous` supplies the member keys of an account that has
 * already been deleted, so removal can still prune it.
 */
async function syncTenantMember({ tenantId, userId, previous }) {
  const userKey = userId?.toString();
  if (!tenantId || !userKey) {
    return { tenantId, userId: userKey, action: 'unchanged' };
  }
  const audience = await findAudience(tenantId);
  if (!audience) {
    return { tenantId, userId: userKey, action: 'no_audience' };
  }

  const user = (await loadMemberSnapshot(userId)) ?? previous;
  const current = new Set((audience.memberIds ?? []).map(String));
  const keys = user ? allMemberKeys(user) : [userKey];
  let changes;
  let action;

  if (isActiveMember(user, tenantId)) {
    const canonical = canonicalMemberKey(user);
    const alternates = keys.filter((key) => key !== canonical && current.has(key));
    changes = { add: [canonical], remove: alternates };
    action = current.has(canonical) && alternates.length === 0 ? 'unchanged' : 'added';
  } else {
    changes = { remove: keys };
    action = keys.some((key) => current.has(key)) ? 'removed' : 'unchanged';
  }

  if (action !== 'unchanged') {
    await applyMemberChanges(audience._id, changes);
    logger.info('[tenantAgentAccess] tenant_agent_access.member_synced', {
      tenantId,
      userId: userKey,
      audienceGroupId: audience._id.toString(),
      action,
    });
  }
  return { tenantId, userId: userKey, action };
}

/**
 * Lifecycle-safe variant: a membership transition that already committed must
 * not fail because enrollment did. The failure is logged for the
 * reconciliation path to repair.
 */
async function syncTenantMemberSafely(params) {
  try {
    return await syncTenantMember(params);
  } catch (error) {
    logger.error('[tenantAgentAccess] tenant_agent_access.reconcile_failed', {
      tenantId: params?.tenantId,
      userId: params?.userId?.toString(),
      error: error?.message,
    });
    return null;
  }
}

async function getInstitutionOrThrow(tenantId) {
  const institution = await runAsSystem(() =>
    models.Institution.findOne({ tenantId }).select('_id tenantId name status').lean().exec(),
  );
  if (!institution) {
    throw new TenantAgentAccessError(404, 'Institution not found');
  }
  return institution;
}

function specialistIdsOf(agent) {
  return [
    ...new Set(
      (agent.edges ?? [])
        .map((edge) => edge?.to)
        .filter((id) => typeof id === 'string' && id.length > 0 && id !== agent.id),
    ),
  ];
}

/** Resolves a master agent and its delegated specialists within the tenant's reach. */
async function loadTopology(tenantId, agentId, { requireSpecialists = true } = {}) {
  const master = await runAsSystem(() =>
    models.Agent.findOne({
      id: agentId,
      orchestrationOnly: { $ne: true },
      ...platformOrTenantScope(tenantId),
    })
      .select('_id id name tenantId edges')
      .lean()
      .exec(),
  );
  if (!master) {
    throw new TenantAgentAccessError(404, 'Agent not found or not available to this institution');
  }

  const specialistIds = specialistIdsOf(master);
  const specialists = specialistIds.length
    ? await runAsSystem(() =>
        models.Agent.find({ id: { $in: specialistIds }, ...platformOrTenantScope(tenantId) })
          .select('_id id tenantId')
          .lean()
          .exec(),
      )
    : [];
  const found = new Set(specialists.map((agent) => agent.id));
  const missing = specialistIds.filter((id) => !found.has(id));
  if (missing.length && requireSpecialists) {
    throw new TenantAgentAccessError(
      409,
      `Delegated agents are not available to this institution: ${missing.join(', ')}`,
    );
  }
  return { master, specialists };
}

async function findAudienceAgentEntries(audienceId, tenantId) {
  return await runAsSystem(() =>
    models.AclEntry.find({
      principalType: PrincipalType.GROUP,
      principalId: audienceId,
      resourceType: ResourceType.AGENT,
      tenantId,
    })
      .select('resourceId permBits')
      .lean()
      .exec(),
  );
}

/** Specialist ObjectIds still required by the audience's other enabled masters. */
async function findRetainedSpecialists(audienceId, tenantId, masterObjectId) {
  const entries = await findAudienceAgentEntries(audienceId, tenantId);
  const otherMasterIds = entries
    .filter((entry) => !entry.resourceId.equals(masterObjectId))
    .map((entry) => entry.resourceId);
  if (!otherMasterIds.length) {
    return new Set();
  }
  const otherMasters = await runAsSystem(() =>
    models.Agent.find({ _id: { $in: otherMasterIds }, orchestrationOnly: { $ne: true } })
      .select('id edges')
      .lean()
      .exec(),
  );
  const specialistIds = [...new Set(otherMasters.flatMap(specialistIdsOf))];
  if (!specialistIds.length) {
    return new Set();
  }
  const specialists = await runAsSystem(() =>
    models.Agent.find({ id: { $in: specialistIds } })
      .select('_id')
      .lean()
      .exec(),
  );
  return new Set(specialists.map((agent) => agent._id.toString()));
}

async function grantTopology({ audience, tenantId, topology, actorId }) {
  const principal = { principalType: PrincipalType.GROUP, principalId: audience._id, tenantId };
  await grantPermission({
    ...principal,
    resourceType: ResourceType.AGENT,
    resourceId: topology.master._id,
    accessRoleId: AccessRoleIds.AGENT_VIEWER,
    grantedBy: actorId,
  });
  /**
   * Handoff discovery loads specialists with an AGENT view check, and subagent
   * execution with REMOTE_AGENT, so specialists need both. They stay out of the
   * user's agent picker because the listing excludes `orchestrationOnly` agents.
   */
  await Promise.all(
    topology.specialists.flatMap((specialist) => [
      grantPermission({
        ...principal,
        resourceType: ResourceType.AGENT,
        resourceId: specialist._id,
        accessRoleId: AccessRoleIds.AGENT_VIEWER,
        grantedBy: actorId,
      }),
      grantPermission({
        ...principal,
        resourceType: ResourceType.REMOTE_AGENT,
        resourceId: specialist._id,
        accessRoleId: AccessRoleIds.REMOTE_AGENT_VIEWER,
        grantedBy: actorId,
      }),
    ]),
  );
}

async function revokeTopology({ audience, tenantId, topology }) {
  const [agentViewer, remoteViewer, retained] = await Promise.all([
    db.findRoleByIdentifier(AccessRoleIds.AGENT_VIEWER),
    db.findRoleByIdentifier(AccessRoleIds.REMOTE_AGENT_VIEWER),
    findRetainedSpecialists(audience._id, tenantId, topology.master._id),
  ]);
  const specialistIds = topology.specialists
    .map((specialist) => specialist._id)
    .filter((id) => !retained.has(id.toString()));
  const principal = { principalType: PrincipalType.GROUP, principalId: audience._id, tenantId };

  await runAsSystem(() =>
    models.AclEntry.deleteMany({
      ...principal,
      $or: [
        {
          resourceType: ResourceType.AGENT,
          resourceId: { $in: [topology.master._id, ...specialistIds] },
          roleId: agentViewer?._id,
        },
        ...(specialistIds.length
          ? [
              {
                resourceType: ResourceType.REMOTE_AGENT,
                resourceId: { $in: specialistIds },
                roleId: remoteViewer?._id,
              },
            ]
          : []),
      ],
    }).exec(),
  );
}

/**
 * Enables or disables one agent (and its delegated specialists) for every
 * active member of a tenant. Idempotent; the audience group and its
 * membership are kept on disable so other agents and re-enables are unaffected.
 */
async function setTenantAgentAccess({ tenantId, agentId, enabled, actorId }) {
  const institution = await getInstitutionOrThrow(tenantId);
  if (enabled && institution.status && institution.status !== InstitutionStatuses.ACTIVE) {
    throw new TenantAgentAccessError(409, 'Institution is not active');
  }
  const topology = await loadTopology(tenantId, agentId, { requireSpecialists: enabled });

  if (!enabled) {
    const audience = await findAudience(tenantId);
    if (audience) {
      await revokeTopology({ audience, tenantId, topology });
    }
    const drift = audience ? await measureDrift(audience, tenantId) : null;
    const result = {
      tenantId,
      agentId: topology.master.id,
      enabled: false,
      audienceGroupId: audience?._id.toString() ?? null,
      activeMemberCount: drift?.activeMemberCount ?? 0,
      delegatedAgentCount: topology.specialists.length,
    };
    logger.info('[tenantAgentAccess] tenant_agent_access.disabled', { ...result, actorId });
    return result;
  }

  const { audience, created } = await ensureTenantAudience(institution);
  const reconciled = await reconcileAudience(audience, tenantId);
  await grantTopology({ audience, tenantId, topology, actorId });
  const result = {
    tenantId,
    agentId: topology.master.id,
    enabled: true,
    audienceGroupId: audience._id.toString(),
    audienceCreated: created,
    activeMemberCount: reconciled.activeMemberCount,
    delegatedAgentCount: topology.specialists.length,
  };
  logger.info('[tenantAgentAccess] tenant_agent_access.enabled', { ...result, actorId });
  return result;
}

/** Lists grantable agents with their tenant-wide state and the audience's health. */
async function getTenantAgentAccess({ tenantId }) {
  await getInstitutionOrThrow(tenantId);
  const [agents, audience] = await Promise.all([
    runAsSystem(() =>
      models.Agent.find({ orchestrationOnly: { $ne: true }, ...platformOrTenantScope(tenantId) })
        .select('_id id name description tenantId')
        .sort({ name: 1 })
        .lean()
        .exec(),
    ),
    findAudience(tenantId),
  ]);

  const [entries, drift] = audience
    ? await Promise.all([
        findAudienceAgentEntries(audience._id, tenantId),
        measureDrift(audience, tenantId),
      ])
    : [[], null];
  const enabledIds = new Set(
    entries
      .filter((entry) => (entry.permBits & PermissionBits.VIEW) !== 0)
      .map((entry) => entry.resourceId.toString()),
  );

  return {
    agents: agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      tenantId: agent.tenantId ?? null,
      enabled: enabledIds.has(agent._id.toString()),
    })),
    audience: audience
      ? {
          groupId: audience._id.toString(),
          name: audience.name,
          activeMemberCount: drift.activeMemberCount,
          enrolledMemberCount: drift.enrolledMemberCount,
          missingMemberCount: drift.missing.length,
          staleMemberCount: drift.stale.length,
          inSync: drift.missing.length === 0 && drift.stale.length === 0,
        }
      : null,
  };
}

function mismatchedAclFilter(groupId, tenantId) {
  return { principalType: PrincipalType.GROUP, principalId: groupId, tenantId: { $ne: tenantId } };
}

/**
 * Marks an existing local tenant group as the managed audience and repairs
 * its ACL entries stamped with another tenant. Used by the migration CLI for
 * legacy `<tenant>-all-users` groups; the group is named explicitly, never
 * matched by pattern. A dry run reports the changes without writing.
 */
async function adoptTenantAudience({ tenantId, groupName, dryRun = true }) {
  const existing = await findAudience(tenantId);
  const group =
    existing ??
    (await runAsSystem(() => models.Group.findOne({ tenantId, name: groupName }).lean().exec()));
  if (!group) {
    throw new TenantAgentAccessError(
      404,
      `Group "${groupName}" not found for tenant "${tenantId}"`,
    );
  }
  if (group.source !== 'local') {
    throw new TenantAgentAccessError(409, `Group "${groupName}" is not a local group`);
  }

  const mismatchedAclEntries = await runAsSystem(() =>
    models.AclEntry.countDocuments(mismatchedAclFilter(group._id, tenantId)).exec(),
  );
  const result = {
    tenantId,
    audienceGroupId: group._id.toString(),
    adopted: !existing,
    mismatchedAclEntries,
  };
  if (dryRun) {
    return { ...result, membership: await reconcileAudience(group, tenantId, { dryRun: true }) };
  }

  await runAsSystem(async () => {
    if (!existing) {
      await models.Group.updateOne(
        { _id: group._id, tenantId, managedKind: { $exists: false } },
        { $set: { managedKind: TENANT_AUDIENCE_KIND } },
      ).exec();
    }
    if (mismatchedAclEntries) {
      await models.AclEntry.updateMany(mismatchedAclFilter(group._id, tenantId), {
        $set: { tenantId },
      }).exec();
    }
  });
  const audience = await findAudience(tenantId);
  if (!existing) {
    logger.info('[tenantAgentAccess] tenant_agent_access.audience_adopted', result);
  }
  return { ...result, membership: await reconcileAudience(audience, tenantId) };
}

module.exports = {
  TENANT_AUDIENCE_KIND,
  TenantAgentAccessError,
  setTenantAgentAccess,
  getTenantAgentAccess,
  syncTenantMember,
  syncTenantMemberSafely,
  reconcileTenantAudience,
  adoptTenantAudience,
};
