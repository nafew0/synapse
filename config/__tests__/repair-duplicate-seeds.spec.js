const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const { MongoMemoryServer } = require('mongodb-memory-server');

jest.mock('../connect', () => jest.fn().mockResolvedValue(true));

logger.silent = true;

describe('repair-duplicate-seeds', () => {
  let mongoServer;
  let models;
  let repairDuplicateSeeds;

  const UNIQUE_INDEXES = {
    Role: 'name_1_tenantId_1',
    AccessRole: 'accessRoleId_1_tenantId_1',
    AgentCategory: 'value_1_tenantId_1',
  };

  /**
   * Reproduces the production state: rows seeded twice and the unique index absent because its
   * build failed. Inserts go through the raw collection, as a seed run without the index did.
   */
  async function withoutUniqueIndexes() {
    for (const [name, index] of Object.entries(UNIQUE_INDEXES)) {
      await models[name].init().catch(() => {});
      await models[name].collection.dropIndex(index).catch(() => {});
    }
  }

  const accessRole = (tenantId, extra = {}) => ({
    accessRoleId: 'agent_owner',
    name: 'com_ui_role_owner',
    description: 'com_ui_role_owner_desc',
    resourceType: 'agent',
    permBits: 15,
    ...(tenantId === undefined ? {} : { tenantId }),
    ...extra,
  });

  const indexNames = async (name) =>
    (await models[name].collection.indexes()).map((index) => index.name);

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    models = require('~/db/models');
    ({ repairDuplicateSeeds } = require('../repair-duplicate-seeds'));
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await mongoose.connection.dropDatabase();
    await withoutUniqueIndexes();
  });

  it('reports duplicates without writing anything on a dry run', async () => {
    await models.AccessRole.collection.insertMany([accessRole('uni'), accessRole('uni')]);

    const { applied, results } = await repairDuplicateSeeds();

    expect(applied).toBe(false);
    expect(results.find((r) => r.model === 'AccessRole')).toMatchObject({ groups: 1, removed: 1 });
    expect(await models.AccessRole.countDocuments({})).toBe(2);
    expect(await indexNames('AccessRole')).not.toContain(UNIQUE_INDEXES.AccessRole);
  });

  it('keeps the copy the app reads, repoints its ACL entries, and builds the index', async () => {
    const { insertedIds } = await models.AccessRole.collection.insertMany([
      accessRole('uni'),
      accessRole('uni'),
      accessRole('other'),
    ]);
    const [read, copy] = [insertedIds[0], insertedIds[1]];
    await models.AclEntry.collection.insertOne({
      principalType: 'user',
      principalId: new mongoose.Types.ObjectId(),
      resourceType: 'agent',
      resourceId: new mongoose.Types.ObjectId(),
      permBits: 15,
      roleId: copy,
      tenantId: 'uni',
    });

    const { applied, results } = await repairDuplicateSeeds({ apply: true });

    expect(applied).toBe(true);
    expect(results.find((r) => r.model === 'AccessRole')).toMatchObject({
      groups: 1,
      removed: 1,
      repointed: { 'AclEntry.roleId': 1 },
      indexBuilt: true,
    });
    const remaining = await models.AccessRole.find({ tenantId: 'uni' }).lean();
    expect(remaining.map((row) => String(row._id))).toEqual([String(read)]);
    expect(await models.AccessRole.countDocuments({ tenantId: 'other' })).toBe(1);
    const entry = await models.AclEntry.collection.findOne({});
    expect(String(entry.roleId)).toBe(String(read));
    expect(await indexNames('AccessRole')).toContain(UNIQUE_INDEXES.AccessRole);
    await expect(models.AccessRole.collection.insertOne(accessRole('uni'))).rejects.toThrow(
      /E11000/,
    );
  });

  it('treats a missing tenantId and a null one as the same key, as the index does', async () => {
    await models.AgentCategory.collection.insertMany([
      { value: 'hr', label: 'HR', order: 1, isActive: true },
      { value: 'hr', label: 'HR', order: 1, isActive: true, tenantId: null },
    ]);

    await repairDuplicateSeeds({ apply: true });

    expect(await models.AgentCategory.countDocuments({ value: 'hr' })).toBe(1);
    expect(await indexNames('AgentCategory')).toContain(UNIQUE_INDEXES.AgentCategory);
  });

  it('does not apply when copies differ, unless told to keep the copy the app reads', async () => {
    await models.Role.collection.insertMany([
      { name: 'USER', tenantId: 'uni', permissions: { PROMPTS: { USE: true } } },
      { name: 'USER', tenantId: 'uni', permissions: { PROMPTS: { USE: false } } },
    ]);

    const blocked = await repairDuplicateSeeds({ apply: true });
    expect(blocked).toMatchObject({ applied: false, blocked: true });
    expect(
      blocked.results.find((r) => r.model === 'Role').differing[0].differences[0].fields,
    ).toEqual(['permissions']);
    expect(await models.Role.countDocuments({})).toBe(2);

    const forced = await repairDuplicateSeeds({ apply: true, allowDifferences: true });
    expect(forced.applied).toBe(true);
    const [kept] = await models.Role.find({}).lean();
    expect(kept.permissions.PROMPTS.USE).toBe(true);
  });

  it('writes nothing on a second run', async () => {
    await models.AccessRole.collection.insertMany([accessRole('uni'), accessRole('uni')]);
    await repairDuplicateSeeds({ apply: true });

    const again = await repairDuplicateSeeds({ apply: true });

    expect(again.results.every((result) => result.removed === 0)).toBe(true);
    expect(await models.AccessRole.countDocuments({})).toBe(1);
  });
});
