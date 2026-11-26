import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels, createMethods } from '@librechat/data-schemas';
import type { AllMethods, UsagePackageFields } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';
import type { PricedUsagePackage, UsagePricingView } from './packages';
import { createUsagePackageHandlers, priceUsagePackage, DEFAULT_USAGE_PRICING } from './packages';

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

function createRequest(overrides: {
  body?: object;
  params?: { key?: string };
  query?: Record<string, string>;
}): ServerRequest & { params: { key?: string } } {
  return {
    body: overrides.body ?? {},
    params: overrides.params ?? {},
    query: overrides.query ?? {},
    headers: { 'user-agent': 'jest' },
    ip: '127.0.0.1',
    user: { id: new mongoose.Types.ObjectId().toString(), name: 'Platform Admin' },
  } as unknown as ServerRequest & { params: { key?: string } };
}

function createHandlers(recordAuditEntry = jest.fn(methods.recordAuditEntry)) {
  const handlers = createUsagePackageHandlers({
    listUsagePackages: methods.listUsagePackages,
    getUsagePackage: methods.getUsagePackage,
    createUsagePackage: methods.createUsagePackage,
    updateUsagePackage: methods.updateUsagePackage,
    getUsagePricing: methods.getUsagePricing,
    saveUsagePricing: methods.saveUsagePricing,
    recordAuditEntry,
  });
  return { handlers, recordAuditEntry };
}

const starter = {
  key: 'starter',
  name: 'Starter',
  scopes: ['member'],
  price: 300,
  monthlyCredit: 300,
};

async function createStarter(handlers: ReturnType<typeof createHandlers>['handlers']) {
  const res = createResponse();
  await handlers.createPackage(createRequest({ body: starter }), res);
  return res;
}

async function listPackages(
  handlers: ReturnType<typeof createHandlers>['handlers'],
  query?: Record<string, string>,
) {
  const res = createResponse();
  await handlers.listPackages(createRequest({ query }), res);
  return res.body as { pricing: UsagePricingView; packages: PricedUsagePackage[] };
}

describe('priceUsagePackage', () => {
  const pkg: UsagePackageFields = {
    ...starter,
    scopes: ['member'],
    description: '',
    weeklyPercent: null,
    unlimited: false,
    active: true,
    sortOrder: 0,
  };

  it('converts the taka allowance to dollar credits at the configured rate', () => {
    const priced = priceUsagePackage(pkg, DEFAULT_USAGE_PRICING);
    expect(priced.monthlyUsd).toBeCloseTo(300 / 123, 6);
    expect(priced.monthlyCredits).toBe(2_439_024);
    expect(priced.effectiveWeeklyPercent).toBe(35);
    expect(priced.weeklyCredits).toBe(853_658);
  });

  it('folds the provider fee into the rate, so the same taka buys fewer credits', () => {
    const priced = priceUsagePackage(pkg, { ...DEFAULT_USAGE_PRICING, providerFeePercent: 5.5 });
    expect(priced.monthlyUsd).toBeCloseTo(300 / (123 * 1.055), 6);
  });

  it('prefers the package weekly percentage over the default', () => {
    const priced = priceUsagePackage({ ...pkg, weeklyPercent: 50 }, DEFAULT_USAGE_PRICING);
    expect(priced.weeklyCredits).toBe(Math.floor(priced.monthlyCredits / 2));
  });
});

describe('usage package handlers', () => {
  it('prices packages with the defaults before any pricing is saved', async () => {
    const { handlers } = createHandlers();
    const body = await listPackages(handlers);
    expect(body.pricing).toMatchObject({ configured: false, bdtPerUsd: 123, updatedAt: null });
    expect(body.packages).toEqual([]);
  });

  it('creates a package, returns it priced, and audits the creation', async () => {
    const { handlers } = createHandlers();
    const res = await createStarter(handlers);

    expect(res.statusCode).toBe(201);
    const created = (res.body as { package: PricedUsagePackage }).package;
    expect(created).toMatchObject({ key: 'starter', monthlyCredits: 2_439_024, unlimited: false });

    const audit = await mongoose.models.AuditLog.findOne({
      action: 'platform.usage_package_created',
    }).lean<{ category: string; target: { id: string }; metadata: Record<string, unknown> }>();
    expect(audit).toMatchObject({ category: 'platform', target: { id: 'starter' } });
    expect(audit?.metadata).toMatchObject({ monthlyCredit: 300, scopes: 'member' });
  });

  it('rejects a duplicate key with 409', async () => {
    /** `dropDatabase` between tests drops indexes; the unique key is what this asserts. */
    await mongoose.models.UsagePackage.createIndexes();
    const { handlers } = createHandlers();
    await createStarter(handlers);
    const res = await createStarter(handlers);
    expect(res.statusCode).toBe(409);
  });

  it.each([
    ['a zero allowance', { ...starter, monthlyCredit: 0 }],
    ['a key with spaces', { ...starter, key: 'big plan' }],
    ['an unknown scope', { ...starter, scopes: ['everyone'] }],
    ['no scopes', { ...starter, scopes: [] }],
    ['a weekly cap above 100%', { ...starter, weeklyPercent: 150 }],
  ])('rejects %s with 400 and writes nothing', async (_label, body) => {
    const { handlers, recordAuditEntry } = createHandlers();
    const res = createResponse();
    await handlers.createPackage(createRequest({ body }), res);
    expect(res.statusCode).toBe(400);
    expect(await methods.listUsagePackages({ includeArchived: true })).toHaveLength(0);
    expect(recordAuditEntry).not.toHaveBeenCalled();
  });

  it('updates a package and records the previous value beside the new one', async () => {
    const { handlers } = createHandlers();
    await createStarter(handlers);

    const res = createResponse();
    await handlers.updatePackage(
      createRequest({ params: { key: 'starter' }, body: { monthlyCredit: 600 } }),
      res,
    );

    expect((res.body as { package: PricedUsagePackage }).package.monthlyCredits).toBe(4_878_048);
    const audit = await mongoose.models.AuditLog.findOne({
      action: 'platform.usage_package_updated',
    }).lean<{ metadata: Record<string, unknown> }>();
    expect(audit?.metadata).toEqual({ monthlyCredit: 600, previous_monthlyCredit: 300 });
  });

  it('refuses to change the key or set unknown fields', async () => {
    const { handlers } = createHandlers();
    await createStarter(handlers);
    const res = createResponse();
    await handlers.updatePackage(
      createRequest({ params: { key: 'starter' }, body: { key: 'renamed' } }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(await methods.getUsagePackage('starter')).not.toBeNull();
  });

  it('returns 404 for an unknown package', async () => {
    const { handlers } = createHandlers();
    const res = createResponse();
    await handlers.updatePackage(
      createRequest({ params: { key: 'missing' }, body: { price: 10 } }),
      res,
    );
    expect(res.statusCode).toBe(404);
  });

  it('hides archived packages unless they are asked for', async () => {
    const { handlers } = createHandlers();
    await createStarter(handlers);
    await handlers.archivePackage(createRequest({ params: { key: 'starter' } }), createResponse());

    expect((await listPackages(handlers)).packages).toHaveLength(0);
    const all = await listPackages(handlers, { includeArchived: 'true' });
    expect(all.packages).toEqual([expect.objectContaining({ key: 'starter', active: false })]);
    expect(
      await mongoose.models.AuditLog.countDocuments({ action: 'platform.usage_package_archived' }),
    ).toBe(1);
  });

  it('reprices every package when the exchange rate changes', async () => {
    const { handlers } = createHandlers();
    await createStarter(handlers);

    const res = createResponse();
    await handlers.updatePricing(
      createRequest({ body: { bdtPerUsd: 120, providerFeePercent: 0, defaultWeeklyPercent: 40 } }),
      res,
    );
    expect((res.body as { pricing: UsagePricingView }).pricing.configured).toBe(true);

    const body = await listPackages(handlers);
    expect(body.packages[0]).toMatchObject({
      monthlyCredits: 2_500_000,
      weeklyCredits: 1_000_000,
      effectiveWeeklyPercent: 40,
    });
  });

  it('fails the request when the audit write fails', async () => {
    const { handlers } = createHandlers(jest.fn().mockRejectedValue(new Error('audit down')));
    const res = createResponse();
    await handlers.updatePricing(
      createRequest({ body: { bdtPerUsd: 120, providerFeePercent: 0, defaultWeeklyPercent: 35 } }),
      res,
    );
    expect(res.statusCode).toBe(500);
  });
});
