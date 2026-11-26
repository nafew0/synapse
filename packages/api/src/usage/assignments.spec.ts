import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels, createMethods, INDIVIDUAL_USAGE_ACCOUNT } from '@librechat/data-schemas';
import type { AllMethods, IUser } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';
import { createUsageAssignmentHandlers } from './assignments';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { error: jest.fn(), warn: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));

let mongoServer: MongoMemoryServer;
let methods: AllMethods;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  methods = createMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
});

type TestResponse = Response & { statusCode: number; body: unknown };

function createResponse(): TestResponse {
  const res = { statusCode: 200, body: undefined } as TestResponse;
  res.status = jest.fn((code: number) => {
    res.statusCode = code;
    return res;
  }) as TestResponse['status'];
  res.json = jest.fn((body: unknown) => {
    res.body = body;
    return res;
  }) as TestResponse['json'];
  return res;
}

function createRequest(params: Record<string, string>, body: object = {}) {
  return {
    body,
    params,
    headers: {},
    ip: '127.0.0.1',
    user: { id: new mongoose.Types.ObjectId().toString(), name: 'Platform Admin' },
  } as unknown as ServerRequest & { params: Record<string, string> };
}

function createHandlers(recordAuditEntry = jest.fn(methods.recordAuditEntry)) {
  return {
    recordAuditEntry,
    handlers: createUsageAssignmentHandlers({
      getUsagePackage: methods.getUsagePackage,
      getQuotaOwner: methods.getQuotaOwner,
      setQuotaOwnerPackage: methods.setQuotaOwnerPackage,
      getUserById: methods.getUserById,
      updateUser: methods.updateUser,
      recordAuditEntry,
    }),
  };
}

async function seed() {
  await methods.createInstitution({ tenantId: 'uni', name: 'University' });
  await methods.createUsagePackage({
    key: 'pool',
    name: 'Pool',
    scopes: ['institution'],
    price: 0,
    monthlyCredit: 30000,
    weeklyPercent: null,
    unlimited: false,
    active: true,
    sortOrder: 0,
  });
  await methods.createUsagePackage({
    key: 'standard',
    name: 'Standard',
    scopes: ['member'],
    price: 600,
    monthlyCredit: 600,
    weeklyPercent: null,
    unlimited: false,
    active: true,
    sortOrder: 1,
  });
  const user = (await methods.createUser({
    email: 'member@uni.edu',
    name: 'Member',
    tenantId: 'uni',
  } as Parameters<AllMethods['createUser']>[0])) as IUser;
  return String(user._id);
}

describe('usage package assignment', () => {
  it("sets an institution's own package and its members' default, and audits it", async () => {
    await seed();
    const { handlers } = createHandlers();
    const res = createResponse();
    await handlers.setInstitutionPackage(
      createRequest({ tenantId: 'uni' }, { packageKey: 'pool', memberPackageKey: 'standard' }),
      res,
    );

    expect(res.statusCode).toBe(200);
    const institution = await methods.getInstitutionByTenantId('uni');
    expect(institution?.usagePackage).toMatchObject({
      packageKey: 'pool',
      memberPackageKey: 'standard',
    });
    const audit = await mongoose.models.AuditLog.findOne({
      action: 'platform.usage_package_assigned',
    }).lean<{ target: { id: string }; metadata: Record<string, unknown> }>();
    expect(audit?.target.id).toBe('uni');
    expect(audit?.metadata).toMatchObject({ packageKey: 'pool', previous_packageKey: null });
  });

  it.each([
    [
      'a member package as the institution package',
      { packageKey: 'standard' },
      /cannot be assigned to institutions/,
    ],
    [
      'an institution package as the member default',
      { memberPackageKey: 'pool' },
      /cannot be assigned to members/,
    ],
    ['a package that does not exist', { packageKey: 'missing' }, /does not exist/],
  ])('refuses %s', async (_label, body, message) => {
    await seed();
    const { handlers, recordAuditEntry } = createHandlers();
    const res = createResponse();
    await handlers.setInstitutionPackage(createRequest({ tenantId: 'uni' }, body), res);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toMatch(message);
    expect(recordAuditEntry).not.toHaveBeenCalled();
  });

  it('refuses an archived package', async () => {
    await seed();
    await methods.updateUsagePackage('standard', { active: false });
    const { handlers } = createHandlers();
    const res = createResponse();
    await handlers.setInstitutionPackage(
      createRequest({ tenantId: 'uni' }, { memberPackageKey: 'standard' }),
      res,
    );
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for an unknown institution', async () => {
    await seed();
    const { handlers } = createHandlers();
    const res = createResponse();
    await handlers.setInstitutionPackage(
      createRequest({ tenantId: 'nowhere' }, { packageKey: 'pool' }),
      res,
    );
    expect(res.statusCode).toBe(404);
  });

  describe('the individuals account', () => {
    it('creates the account with its trial package on the first assignment', async () => {
      await seed();
      const { handlers } = createHandlers();
      const res = createResponse();
      await handlers.setInstitutionPackage(
        createRequest({ tenantId: INDIVIDUAL_USAGE_ACCOUNT }, { memberPackageKey: 'standard' }),
        res,
      );
      expect(res.statusCode).toBe(200);
      expect(await methods.getQuotaOwner(INDIVIDUAL_USAGE_ACCOUNT)).toMatchObject({
        name: 'Individuals',
        usagePackage: { packageKey: null, memberPackageKey: 'standard' },
      });
      expect(await mongoose.models.Institution.countDocuments({})).toBe(1);
      const audit = await mongoose.models.AuditLog.findOne({
        action: 'platform.usage_package_assigned',
      }).lean<{ target: { type: string; id: string } }>();
      expect(audit?.target).toMatchObject({ type: 'usage_account', id: INDIVIDUAL_USAGE_ACCOUNT });
    });

    it('refuses a shared package, since individuals have no pool', async () => {
      await seed();
      const { handlers, recordAuditEntry } = createHandlers();
      const res = createResponse();
      await handlers.setInstitutionPackage(
        createRequest({ tenantId: INDIVIDUAL_USAGE_ACCOUNT }, { packageKey: 'pool' }),
        res,
      );
      expect(res.statusCode).toBe(400);
      expect(recordAuditEntry).not.toHaveBeenCalled();
    });

    it('reads as empty until configured, and clears back to empty', async () => {
      expect(await methods.getQuotaOwner(INDIVIDUAL_USAGE_ACCOUNT)).toMatchObject({
        usagePackage: null,
      });
      await seed();
      const { handlers } = createHandlers();
      await handlers.setInstitutionPackage(
        createRequest({ tenantId: INDIVIDUAL_USAGE_ACCOUNT }, { memberPackageKey: 'standard' }),
        createResponse(),
      );
      const res = createResponse();
      await handlers.clearInstitutionPackage(
        createRequest({ tenantId: INDIVIDUAL_USAGE_ACCOUNT }),
        res,
      );
      expect(res.statusCode).toBe(200);
      expect(await methods.getQuotaOwner(INDIVIDUAL_USAGE_ACCOUNT)).toMatchObject({
        usagePackage: null,
      });
    });
  });

  it("sets and clears a member's own package with an expiry", async () => {
    const userId = await seed();
    const { handlers } = createHandlers();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const setRes = createResponse();
    await handlers.setMemberPackage(
      createRequest({ userId }, { packageKey: 'standard', expiresAt }),
      setRes,
    );
    expect(setRes.statusCode).toBe(200);
    const assigned = await methods.getUserById(userId, 'usagePackage');
    expect(assigned?.usagePackage).toMatchObject({ packageKey: 'standard' });
    expect(assigned?.usagePackage?.expiresAt?.toISOString()).toBe(expiresAt);

    const clearRes = createResponse();
    await handlers.clearMemberPackage(createRequest({ userId }), clearRes);
    expect((await methods.getUserById(userId, 'usagePackage'))?.usagePackage).toBeNull();
    expect(
      await mongoose.models.AuditLog.countDocuments({ action: 'platform.usage_package_revoked' }),
    ).toBe(1);
  });

  it('refuses an expiry in the past', async () => {
    const userId = await seed();
    const { handlers } = createHandlers();
    const res = createResponse();
    await handlers.setMemberPackage(
      createRequest({ userId }, { packageKey: 'standard', expiresAt: '2020-01-01T00:00:00Z' }),
      res,
    );
    expect(res.statusCode).toBe(400);
  });

  it('fails the change when the audit write fails', async () => {
    await seed();
    const { handlers } = createHandlers(jest.fn().mockRejectedValue(new Error('audit down')));
    const res = createResponse();
    await handlers.clearInstitutionPackage(createRequest({ tenantId: 'uni' }), res);
    expect(res.statusCode).toBe(500);
  });
});
