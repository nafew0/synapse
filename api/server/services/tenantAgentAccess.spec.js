const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { runAsSystem, tenantStorage } = require('@librechat/data-schemas');
const {
  PermissionBits,
  PrincipalType,
  ResourceType,
  SystemRoles,
} = require('librechat-data-provider');

jest.mock('~/server/services/GraphApiService', () => ({
  entraIdPrincipalFeatureEnabled: jest.fn().mockReturnValue(false),
  getUserOwnedEntraGroups: jest.fn().mockResolvedValue([]),
  getUserEntraGroups: jest.fn().mockResolvedValue([]),
  getEntraGroupDetailsBatch: jest.fn().mockResolvedValue([]),
  getGroupMembers: jest.fn().mockResolvedValue([]),
  getGroupOwners: jest.fn().mockResolvedValue([]),
}));

const {
  TENANT_AUDIENCE_KIND,
  adoptTenantAudience,
  getTenantAgentAccess,
  reconcileTenantAudience,
  setTenantAgentAccess,
  syncTenantMember,
} = require('./tenantAgentAccess');
const { checkPermission } = require('./PermissionService');
const { seedDefaultRoles } = require('~/models');
const models = require('~/db/models');

let mongoServer;
const actorId = new mongoose.Types.ObjectId();

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  Object.assign(mongoose.models, models);
  await models.Group.syncIndexes();
  await seedDefaultRoles();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await Promise.all([
    models.AclEntry.deleteMany({}),
    models.Agent.deleteMany({}),
    models.Group.deleteMany({}),
    models.Institution.deleteMany({}),
    models.User.deleteMany({}),
  ]);
});

let userSequence = 0;

async function createInstitution(tenantId, overrides = {}) {
  return await models.Institution.create({
    tenantId,
    name: `${tenantId} University`,
    ...overrides,
  });
}

async function createUser(tenantId, overrides = {}) {
  userSequence += 1;
  return await models.User.create({
    email: `user${userSequence}@${tenantId}.test`,
    username: `user${userSequence}`,
    provider: 'local',
    role: SystemRoles.USER,
    tenantId,
    membershipStatus: 'active',
    ...overrides,
  });
}

async function createAgent(id, overrides = {}) {
  return await models.Agent.create({
    id,
    name: id,
    provider: 'openai',
    model: 'gpt-4o-mini',
    author: actorId,
    ...overrides,
  });
}

async function createOfficeTopology(tenantId) {
  const specialist = await createAgent(`${tenantId ?? 'platform'}_docx`, {
    tenantId,
    orchestrationOnly: true,
  });
  const master = await createAgent(`${tenantId ?? 'platform'}_office`, {
    tenantId,
    edges: [{ from: `${tenantId ?? 'platform'}_office`, to: specialist.id, edgeType: 'handoff' }],
  });
  return { master, specialist };
}

async function canUse(user, resourceType, resource) {
  return await tenantStorage.run({ tenantId: user.tenantId }, () =>
    checkPermission({
      userId: user._id,
      resourceType,
      resourceId: resource._id,
      requiredPermission: PermissionBits.VIEW,
    }),
  );
}

async function audienceOf(tenantId) {
  return await models.Group.findOne({ tenantId, managedKind: TENANT_AUDIENCE_KIND }).lean();
}

describe('tenantAgentAccess', () => {
  describe('setTenantAgentAccess', () => {
    it('enrolls every active tenant member and grants the master and its specialists', async () => {
      await createInstitution('learn');
      const { master, specialist } = await createOfficeTopology();
      const active = await createUser('learn');
      const external = await createUser('learn', { idOnTheSource: 'oidc-sub-1' });
      const suspended = await createUser('learn', { membershipStatus: 'suspended' });
      const foreign = await createUser('bdren');

      const result = await setTenantAgentAccess({
        tenantId: 'learn',
        agentId: master.id,
        enabled: true,
        actorId,
      });

      expect(result).toMatchObject({
        tenantId: 'learn',
        agentId: master.id,
        enabled: true,
        activeMemberCount: 2,
        delegatedAgentCount: 1,
      });
      const audience = await audienceOf('learn');
      expect(audience._id.toString()).toBe(result.audienceGroupId);
      expect(new Set(audience.memberIds)).toEqual(new Set([active._id.toString(), 'oidc-sub-1']));
      expect(await canUse(active, ResourceType.AGENT, master)).toBe(true);
      expect(await canUse(external, ResourceType.AGENT, master)).toBe(true);
      expect(await canUse(active, ResourceType.REMOTE_AGENT, specialist)).toBe(true);
      expect(await canUse(active, ResourceType.AGENT, specialist)).toBe(true);
      expect(await canUse(suspended, ResourceType.AGENT, master)).toBe(false);
      expect(await canUse(foreign, ResourceType.AGENT, master)).toBe(false);
    });

    it('is idempotent across repeated and concurrent enables', async () => {
      await createInstitution('learn');
      const { master, specialist } = await createOfficeTopology();
      await createUser('learn');

      await Promise.all([
        setTenantAgentAccess({ tenantId: 'learn', agentId: master.id, enabled: true, actorId }),
        setTenantAgentAccess({ tenantId: 'learn', agentId: master.id, enabled: true, actorId }),
      ]);
      await setTenantAgentAccess({ tenantId: 'learn', agentId: master.id, enabled: true, actorId });

      expect(await models.Group.countDocuments({ tenantId: 'learn' })).toBe(1);
      const audience = await audienceOf('learn');
      const masterEntries = await models.AclEntry.find({
        principalId: audience._id,
        resourceType: ResourceType.AGENT,
      }).lean();
      expect(new Set(masterEntries.map((entry) => entry.resourceId.toString()))).toEqual(
        new Set([master._id.toString(), specialist._id.toString()]),
      );
    });

    it('disables one agent without revoking another agent or shared specialists', async () => {
      await createInstitution('learn');
      const { master, specialist } = await createOfficeTopology();
      const other = await createAgent('research', {
        edges: [{ from: 'research', to: specialist.id, edgeType: 'handoff' }],
      });
      const member = await createUser('learn');
      await setTenantAgentAccess({ tenantId: 'learn', agentId: master.id, enabled: true, actorId });
      await setTenantAgentAccess({ tenantId: 'learn', agentId: other.id, enabled: true, actorId });

      await setTenantAgentAccess({
        tenantId: 'learn',
        agentId: master.id,
        enabled: false,
        actorId,
      });

      expect(await canUse(member, ResourceType.AGENT, master)).toBe(false);
      expect(await canUse(member, ResourceType.AGENT, other)).toBe(true);
      expect(await canUse(member, ResourceType.REMOTE_AGENT, specialist)).toBe(true);
      expect(await canUse(member, ResourceType.AGENT, specialist)).toBe(true);
      expect((await audienceOf('learn')).memberIds).toEqual([member._id.toString()]);

      await setTenantAgentAccess({ tenantId: 'learn', agentId: other.id, enabled: false, actorId });
      expect(await canUse(member, ResourceType.REMOTE_AGENT, specialist)).toBe(false);
      expect(await canUse(member, ResourceType.AGENT, specialist)).toBe(false);
    });

    it('keeps tenants independent when they share a platform-wide agent', async () => {
      await createInstitution('learn');
      await createInstitution('bdren');
      const { master } = await createOfficeTopology();
      const learnMember = await createUser('learn');
      const bdrenMember = await createUser('bdren');
      await setTenantAgentAccess({ tenantId: 'learn', agentId: master.id, enabled: true, actorId });
      await setTenantAgentAccess({ tenantId: 'bdren', agentId: master.id, enabled: true, actorId });

      await setTenantAgentAccess({
        tenantId: 'learn',
        agentId: master.id,
        enabled: false,
        actorId,
      });

      expect(await canUse(learnMember, ResourceType.AGENT, master)).toBe(false);
      expect(await canUse(bdrenMember, ResourceType.AGENT, master)).toBe(true);
      expect((await audienceOf('learn'))._id.toString()).not.toBe(
        (await audienceOf('bdren'))._id.toString(),
      );
    });

    it('refuses a tenant-scoped agent owned by another tenant', async () => {
      await createInstitution('learn');
      const { master } = await createOfficeTopology('bdren');

      await expect(
        setTenantAgentAccess({ tenantId: 'learn', agentId: master.id, enabled: true, actorId }),
      ).rejects.toMatchObject({ statusCode: 404 });
      expect(await audienceOf('learn')).toBeNull();
    });

    it('refuses unknown and inactive institutions', async () => {
      const { master } = await createOfficeTopology();
      await createInstitution('closed', { status: 'suspended' });

      await expect(
        setTenantAgentAccess({ tenantId: 'missing', agentId: master.id, enabled: true, actorId }),
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        setTenantAgentAccess({ tenantId: 'closed', agentId: master.id, enabled: true, actorId }),
      ).rejects.toMatchObject({ statusCode: 409 });
    });
  });

  describe('syncTenantMember', () => {
    it('does nothing when the tenant has no managed audience', async () => {
      await createInstitution('learn');
      const member = await createUser('learn');

      const result = await syncTenantMember({ tenantId: 'learn', userId: member._id });

      expect(result.action).toBe('no_audience');
      expect(await models.Group.countDocuments({})).toBe(0);
    });

    it('grants a newly activated member access immediately and follows suspension', async () => {
      await createInstitution('learn');
      const { master } = await createOfficeTopology();
      await setTenantAgentAccess({ tenantId: 'learn', agentId: master.id, enabled: true, actorId });
      const joiner = await createUser('learn', { membershipStatus: 'suspended' });
      expect(await canUse(joiner, ResourceType.AGENT, master)).toBe(false);

      await models.User.updateOne({ _id: joiner._id }, { membershipStatus: 'active' });
      expect((await syncTenantMember({ tenantId: 'learn', userId: joiner._id })).action).toBe(
        'added',
      );
      expect(await canUse(joiner, ResourceType.AGENT, master)).toBe(true);
      expect((await syncTenantMember({ tenantId: 'learn', userId: joiner._id })).action).toBe(
        'unchanged',
      );

      await models.User.updateOne({ _id: joiner._id }, { membershipStatus: 'suspended' });
      expect((await syncTenantMember({ tenantId: 'learn', userId: joiner._id })).action).toBe(
        'removed',
      );
      expect(await canUse(joiner, ResourceType.AGENT, master)).toBe(false);

      await models.User.updateOne({ _id: joiner._id }, { membershipStatus: 'active' });
      await syncTenantMember({ tenantId: 'learn', userId: joiner._id });
      expect(await canUse(joiner, ResourceType.AGENT, master)).toBe(true);
    });

    it('replaces an alternate key with the canonical one and prunes deleted accounts', async () => {
      await createInstitution('learn');
      const { master } = await createOfficeTopology();
      const member = await createUser('learn', { idOnTheSource: 'oidc-sub-2' });
      await setTenantAgentAccess({ tenantId: 'learn', agentId: master.id, enabled: true, actorId });
      const audience = await audienceOf('learn');
      await models.Group.updateOne({ _id: audience._id }, { memberIds: [member._id.toString()] });

      await syncTenantMember({ tenantId: 'learn', userId: member._id });
      expect((await audienceOf('learn')).memberIds).toEqual(['oidc-sub-2']);

      const snapshot = { ...member.toObject(), membershipStatus: 'removed' };
      await models.User.deleteOne({ _id: member._id });
      const result = await syncTenantMember({
        tenantId: 'learn',
        userId: member._id,
        previous: snapshot,
      });
      expect(result.action).toBe('removed');
      expect((await audienceOf('learn')).memberIds).toEqual([]);
    });

    it('removes a member who moved to another tenant', async () => {
      await createInstitution('learn');
      const { master } = await createOfficeTopology();
      const member = await createUser('learn');
      await setTenantAgentAccess({ tenantId: 'learn', agentId: master.id, enabled: true, actorId });

      await runAsSystem(() =>
        models.User.updateOne({ _id: member._id }, { tenantId: 'bdren' }).exec(),
      );
      await syncTenantMember({ tenantId: 'learn', userId: member._id });

      expect((await audienceOf('learn')).memberIds).toEqual([]);
    });
  });

  describe('reconcileTenantAudience', () => {
    it('repairs missing, stale, and foreign entries and supports dry runs', async () => {
      await createInstitution('learn');
      const { master } = await createOfficeTopology();
      const missing = await createUser('learn');
      const suspended = await createUser('learn', { membershipStatus: 'suspended' });
      const foreign = await createUser('bdren');
      await setTenantAgentAccess({ tenantId: 'learn', agentId: master.id, enabled: true, actorId });
      const audience = await audienceOf('learn');
      await models.Group.updateOne(
        { _id: audience._id },
        { memberIds: [suspended._id.toString(), foreign._id.toString(), 'deleted-user'] },
      );

      const preview = await reconcileTenantAudience({ tenantId: 'learn', dryRun: true });
      expect(preview).toMatchObject({ added: 1, removed: 3, dryRun: true });
      expect((await audienceOf('learn')).memberIds).toHaveLength(3);

      const applied = await reconcileTenantAudience({ tenantId: 'learn' });
      expect(applied).toMatchObject({ added: 1, removed: 3, activeMemberCount: 1 });
      expect((await audienceOf('learn')).memberIds).toEqual([missing._id.toString()]);
    });

    it('returns null for a tenant without an audience', async () => {
      expect(await reconcileTenantAudience({ tenantId: 'learn' })).toBeNull();
    });
  });

  describe('getTenantAgentAccess', () => {
    it('reports enabled agents and audience drift', async () => {
      await createInstitution('learn');
      const { master } = await createOfficeTopology();
      const other = await createAgent('research');
      await createUser('learn');
      await setTenantAgentAccess({ tenantId: 'learn', agentId: master.id, enabled: true, actorId });
      await createUser('learn');

      const state = await getTenantAgentAccess({ tenantId: 'learn' });

      expect(state.agents.map((agent) => agent.id)).not.toContain('platform_docx');
      expect(state.agents.find((agent) => agent.id === master.id).enabled).toBe(true);
      expect(state.agents.find((agent) => agent.id === other.id).enabled).toBe(false);
      expect(state.audience).toMatchObject({
        activeMemberCount: 2,
        enrolledMemberCount: 1,
        missingMemberCount: 1,
        inSync: false,
      });
    });
  });

  describe('adoptTenantAudience', () => {
    it('marks an explicitly named legacy group as the managed audience', async () => {
      await createInstitution('learn');
      const member = await createUser('learn');
      const { master } = await createOfficeTopology();
      const legacy = await models.Group.create({
        name: 'learn-all-users',
        source: 'local',
        tenantId: 'learn',
        memberIds: ['departed-user'],
      });
      await models.AclEntry.create({
        principalType: PrincipalType.GROUP,
        principalModel: 'Group',
        principalId: legacy._id,
        resourceType: ResourceType.AGENT,
        resourceId: master._id,
        permBits: PermissionBits.VIEW,
        tenantId: 'bdren',
      });

      const preview = await adoptTenantAudience({
        tenantId: 'learn',
        groupName: 'learn-all-users',
      });
      expect(preview).toMatchObject({
        adopted: true,
        mismatchedAclEntries: 1,
        membership: { added: 1, removed: 1, dryRun: true },
      });
      expect(await audienceOf('learn')).toBeNull();

      await adoptTenantAudience({ tenantId: 'learn', groupName: 'learn-all-users', dryRun: false });
      const audience = await audienceOf('learn');
      expect(audience._id.toString()).toBe(legacy._id.toString());
      expect(audience.memberIds).toEqual([member._id.toString()]);
      expect(await canUse(member, ResourceType.AGENT, master)).toBe(true);

      const again = await adoptTenantAudience({ tenantId: 'learn', groupName: 'learn-all-users' });
      expect(again).toMatchObject({ adopted: false, mismatchedAclEntries: 0 });
    });

    it('rejects a group from another tenant', async () => {
      await models.Group.create({ name: 'bdren-all-users', source: 'local', tenantId: 'bdren' });

      await expect(
        adoptTenantAudience({ tenantId: 'learn', groupName: 'bdren-all-users', dryRun: false }),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  it('never grants access through a public principal', async () => {
    await createInstitution('learn');
    const { master } = await createOfficeTopology();
    await setTenantAgentAccess({ tenantId: 'learn', agentId: master.id, enabled: true, actorId });

    expect(await models.AclEntry.countDocuments({ principalType: PrincipalType.PUBLIC })).toBe(0);
  });
});
