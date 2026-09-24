const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const {
  Permissions,
  PermissionTypes,
  SystemRoles,
  roleDefaults,
} = require('librechat-data-provider');
const {
  INSTITUTION_ADMIN_ROLE,
  loadDefaultInterface,
  runAsSystem,
  tenantStorage,
} = require('@librechat/data-schemas');

const mockConfig = {
  interface: {
    bookmarks: false,
    memories: false,
    agents: { use: true, create: false, share: false, public: true },
  },
};
let mockAppConfig;

jest.mock('./Config', () => ({ getAppConfig: jest.fn(async () => mockAppConfig) }));

const { ensureInstitutionAdminRole, syncAllTenantInterfacePermissions } = require('./tenancy');
const models = require('~/db/models');

let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  Object.assign(mongoose.models, models);
  const interfaceConfig = await loadDefaultInterface({
    config: mockConfig,
    configDefaults: { interface: {} },
  });
  mockAppConfig = { config: mockConfig, interfaceConfig };
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await Promise.all([models.Role.deleteMany({}), models.Institution.deleteMany({})]);
});

async function tenantRole(tenantId, name) {
  return await tenantStorage.run({ tenantId }, () => models.Role.findOne({ name }).lean().exec());
}

function uiFlags(role) {
  return {
    agentBuilder: role.permissions[PermissionTypes.AGENTS][Permissions.CREATE],
    bookmarks: role.permissions[PermissionTypes.BOOKMARKS][Permissions.USE],
    memories: role.permissions[PermissionTypes.MEMORIES][Permissions.USE],
  };
}

const hidden = { agentBuilder: false, bookmarks: false, memories: false };

describe('tenant interface permissions', () => {
  it('seeds a new institution roles from librechat.yaml, not the hardcoded defaults', async () => {
    await models.Institution.create({ tenantId: 'uni-new', name: 'New University' });

    await ensureInstitutionAdminRole('uni-new');

    expect(uiFlags(await tenantRole('uni-new', INSTITUTION_ADMIN_ROLE))).toEqual(hidden);
    expect(uiFlags(await tenantRole('uni-new', SystemRoles.USER))).toEqual(hidden);
  });

  it('repairs existing institution roles at startup without touching other tenants', async () => {
    await models.Institution.create({ tenantId: 'uni-old', name: 'Old University' });
    const seeded = roleDefaults[SystemRoles.USER].permissions;
    await runAsSystem(() =>
      models.Role.create([
        { name: SystemRoles.USER, tenantId: 'uni-old', permissions: seeded },
        { name: INSTITUTION_ADMIN_ROLE, tenantId: 'uni-old', permissions: seeded },
        { name: SystemRoles.USER, tenantId: 'not-an-institution', permissions: seeded },
      ]),
    );
    expect(uiFlags(await tenantRole('uni-old', SystemRoles.USER)).agentBuilder).toBe(true);

    const failed = await syncAllTenantInterfacePermissions();

    expect(failed).toEqual([]);
    expect(uiFlags(await tenantRole('uni-old', SystemRoles.USER))).toEqual(hidden);
    expect(uiFlags(await tenantRole('uni-old', INSTITUTION_ADMIN_ROLE))).toEqual(hidden);
    expect(uiFlags(await tenantRole('not-an-institution', SystemRoles.USER)).agentBuilder).toBe(
      true,
    );
  });
});
