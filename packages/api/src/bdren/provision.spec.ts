import http from 'http';
import express from 'express';
import mongoose from 'mongoose';
import { createHmac } from 'crypto';
import { createModels, createMethods } from '@librechat/data-schemas';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { IInstitution, IAuditLog, BdrenAllowancePayload } from '@librechat/data-schemas';
import type { AddressInfo } from 'net';
import type { BdrenConfig } from './types';
import { createProvisioner, tenantIdFromSlug } from './provision';
import { createAllowanceService } from './allowance';
import { createAllowanceClient } from './client';
import { createWebhookHandler } from './webhook';
import { readBdrenConfig } from './config';

const PRODUCT_KEY = 'bdren_prod_synapse_provision';
const SECRET = 'whsec_provision';
const ISSUER = 'https://auth.bdren.test';
const ORG = {
  id: '7d1c2a9e-0000-4000-8000-00000000abcd',
  slug: 'Dhaka University',
  name: 'Dhaka University',
};

function startBdren() {
  const answers = new Map<string, BdrenAllowancePayload>();
  const state = { down: false };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (state.down) {
        res.writeHead(503).end();
        return;
      }
      const answer = answers.get(JSON.parse(raw).zitadel_subject);
      if (!answer) {
        res.writeHead(404).end('{}');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...answer, etag: 'e' }));
    });
  });
  return new Promise<{
    url: string;
    answers: typeof answers;
    state: typeof state;
    close: () => Promise<void>;
  }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        answers,
        state,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function institutionAnswer(subject: string, org = ORG): BdrenAllowancePayload {
  const start = '2026-11-15T04:00:00Z';
  const end = '2026-12-15T04:00:00Z';
  return {
    product: 'synapse',
    user: { subject },
    plan_source: 'institution',
    package: { slug: 'pro', name: 'Pro', version: 1 },
    institution: { id: org.id, slug: org.slug, name: org.name, seats: 50 },
    subscription: { id: 's', status: 'active', starts_at: start, expires_at: end },
    limits: { ai_credits: { monthly: 1000, weekly: 350 } },
    windows: { month: { start, end }, week: { start, end } },
    etag: '',
  };
}

let mongo: MongoMemoryServer;
let bdren: Awaited<ReturnType<typeof startBdren>>;
let config: BdrenConfig;
let provisioner: ReturnType<typeof createProvisioner>;
let onCreated: jest.Mock;

const Institution = () => mongoose.models.Institution;
const audits = (action: string) =>
  mongoose.models.AuditLog.find({ action }).lean<IAuditLog[]>().exec();

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  createModels(mongoose);
  await Promise.all(
    ['BdrenAllowance', 'BdrenEvent', 'Institution'].map((name) => mongoose.models[name].init()),
  );
  bdren = await startBdren();
  config = readBdrenConfig({
    BDREN_ALLOWANCE_ENABLED: 'true',
    BDREN_API_URL: bdren.url,
    BDREN_PRODUCT_KEY: PRODUCT_KEY,
    BDREN_ISSUER: ISSUER,
    BDREN_WEBHOOK_SECRET: SECRET,
    BDREN_ALLOWANCE_TIMEOUT_MS: '500',
  });
});

afterAll(async () => {
  await bdren.close();
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  bdren.state.down = false;
  bdren.answers.clear();
  await Promise.all(
    ['BdrenAllowance', 'BdrenEvent', 'Institution', 'AuditLog'].map((name) =>
      mongoose.models[name].collection.deleteMany({}),
    ),
  );
  const client = createAllowanceClient(config);
  onCreated = jest.fn().mockResolvedValue(undefined);
  provisioner = createProvisioner({
    config,
    client,
    service: createAllowanceService({ config, client }),
    recordAuditEntry: createMethods(mongoose).recordAuditEntry,
    onCreated,
  });
});

describe('tenantIdFromSlug', () => {
  it('keeps lowercase letters, digits and single hyphens and never starts with an underscore', () => {
    expect(tenantIdFromSlug('Dhaka University')).toBe('dhaka-university');
    expect(tenantIdFromSlug('__reserved__')).toBe('reserved');
    expect(tenantIdFromSlug('  !!  ')).toBe('institution');
    expect(tenantIdFromSlug('a'.repeat(80))).toHaveLength(40);
  });
});

describe('ensureInstitutionForOrganization', () => {
  it('creates exactly one institution under concurrent calls and audits it once', async () => {
    const tenants = await Promise.all(
      Array.from({ length: 12 }, () => provisioner.ensureInstitutionForOrganization(ORG)),
    );

    expect(new Set(tenants).size).toBe(1);
    expect(await Institution().countDocuments({ bdrenOrganizationId: ORG.id })).toBe(1);
    const row = await Institution().findOne({ bdrenOrganizationId: ORG.id }).lean<IInstitution>();
    expect(row).toMatchObject({
      tenantId: 'dhaka-university',
      name: 'Dhaka University',
      status: 'active',
    });
    expect(row?.limits?.maxActiveMembers ?? null).toBeNull();
    expect(await audits('institution.provisioned')).toHaveLength(1);
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(onCreated).toHaveBeenCalledWith('dhaka-university');
  });

  it('reuses an existing link without creating or auditing anything', async () => {
    await Institution().create({
      tenantId: 'du-old',
      name: 'DU',
      slug: 'du-old',
      bdrenOrganizationId: ORG.id,
    });

    expect(await provisioner.ensureInstitutionForOrganization(ORG)).toBe('du-old');
    expect(await Institution().countDocuments()).toBe(1);
    expect(await audits('institution.provisioned')).toHaveLength(0);
  });

  it('gives a colliding tenant id a suffix and never links the unlinked institution', async () => {
    await Institution().create({
      tenantId: 'dhaka-university',
      name: 'Hand made',
      slug: 'dhaka-university',
    });

    const tenantId = await provisioner.ensureInstitutionForOrganization(ORG);

    expect(tenantId).not.toBe('dhaka-university');
    expect(tenantId).toMatch(/^dhaka-university-[a-z0-9]+$/);
    const handMade = await Institution()
      .findOne({ tenantId: 'dhaka-university' })
      .lean<IInstitution>();
    expect(handMade?.bdrenOrganizationId).toBeUndefined();
    expect(await Institution().countDocuments()).toBe(2);
  });

  it('falls back to the slug as the name when bdren.ai sends none', async () => {
    await provisioner.ensureInstitutionForOrganization({ id: 'org-2', slug: 'bracu' });
    const row = await Institution().findOne({ bdrenOrganizationId: 'org-2' }).lean<IInstitution>();
    expect(row).toMatchObject({ tenantId: 'bracu', name: 'bracu' });
  });
});

describe('tenantForNewMember', () => {
  it('provisions the institution and returns its tenant for an institution member', async () => {
    bdren.answers.set('sub-new', institutionAnswer('sub-new'));
    const tenantId = await provisioner.tenantForNewMember({ issuer: ISSUER, subject: 'sub-new' });
    expect(tenantId).toBe('dhaka-university');
    expect(await Institution().countDocuments()).toBe(1);
  });

  it('returns null for a person who is not covered by an institution', async () => {
    bdren.answers.set('sub-p', {
      ...institutionAnswer('sub-p'),
      plan_source: 'personal',
      institution: null,
    });
    expect(await provisioner.tenantForNewMember({ issuer: ISSUER, subject: 'sub-p' })).toBeNull();
    expect(await Institution().countDocuments()).toBe(0);
  });

  it('returns null, not an error, when bdren.ai is down, unknown to the user or the issuer differs', async () => {
    bdren.answers.set('sub-x', institutionAnswer('sub-x'));
    bdren.state.down = true;
    expect(await provisioner.tenantForNewMember({ issuer: ISSUER, subject: 'sub-x' })).toBeNull();
    bdren.state.down = false;
    expect(await provisioner.tenantForNewMember({ issuer: ISSUER, subject: 'nobody' })).toBeNull();
    expect(
      await provisioner.tenantForNewMember({ issuer: 'https://other.test', subject: 'sub-x' }),
    ).toBeNull();
    expect(await Institution().countDocuments()).toBe(0);
  });

  it('does not place a member in a closed institution', async () => {
    await Institution().create({
      tenantId: 'du',
      name: 'DU',
      slug: 'du',
      status: 'closed',
      bdrenOrganizationId: ORG.id,
    });
    bdren.answers.set('sub-c', institutionAnswer('sub-c'));
    expect(await provisioner.tenantForNewMember({ issuer: ISSUER, subject: 'sub-c' })).toBeNull();
  });
});

describe('reviewExistingMember', () => {
  const userId = new mongoose.Types.ObjectId().toString();
  const individual = {
    id: userId,
    openidId: 'sub-old',
    openidIssuer: ISSUER,
    accountScope: 'standalone' as const,
  };

  it('records, once, an individual who is covered by an institution, and moves nobody', async () => {
    bdren.answers.set('sub-old', institutionAnswer('sub-old'));

    await provisioner.reviewExistingMember(individual);
    await provisioner.reviewExistingMember(individual);

    const entries = await audits('member.coverage_mismatch');
    expect(entries).toHaveLength(1);
    expect(entries[0].target.id).toBe(userId);
    expect(entries[0].metadata).toMatchObject({
      organizationId: ORG.id,
      institutionTenantId: 'dhaka-university',
      currentTenantId: null,
    });
  });

  it('records a member of a different tenant, and nothing for one already in the right tenant', async () => {
    bdren.answers.set('sub-old', institutionAnswer('sub-old'));
    await provisioner.reviewExistingMember({ ...individual, tenantId: 'other-uni' });
    expect(await audits('member.coverage_mismatch')).toHaveLength(1);

    await mongoose.models.AuditLog.collection.deleteMany({});
    await provisioner.reviewExistingMember({ ...individual, tenantId: 'dhaka-university' });
    expect(await audits('member.coverage_mismatch')).toHaveLength(0);
  });

  it('never throws when bdren.ai is down', async () => {
    bdren.state.down = true;
    await expect(provisioner.reviewExistingMember(individual)).resolves.toBeUndefined();
    expect(await audits('member.coverage_mismatch')).toHaveLength(0);
  });
});

describe('webhook for an unknown organization', () => {
  let app: http.Server;
  let hookUrl: string;

  beforeEach(async () => {
    const client = createAllowanceClient(config);
    const handler = createWebhookHandler({
      config,
      service: createAllowanceService({ config, client }),
      findSubject: async () => null,
      ensureInstitution: provisioner.ensureInstitutionForOrganization,
    });
    const server = express();
    server.post('/hook', express.raw({ type: () => true }), (req, res) => void handler(req, res));
    app = await new Promise<http.Server>((resolve) => {
      const listener = server.listen(0, '127.0.0.1', () => resolve(listener));
    });
    hookUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}/hook`;
  });

  afterEach(async () => {
    await new Promise((done) => app.close(done));
  });

  async function deliver(event: Record<string, unknown>) {
    const body = JSON.stringify(event);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex');
    return fetch(hookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-BdREN-Timestamp': timestamp,
        'X-BdREN-Signature': `v1=${signature}`,
      },
      body,
    });
  }

  it.each(['subscription.activated', 'membership.coverage_changed'])(
    'provisions the institution on %s',
    async (type) => {
      const response = await deliver({
        id: `evt-${type}`,
        type,
        organization: { id: ORG.id, slug: 'du', name: 'Dhaka University' },
      });

      expect(response.status).toBe(204);
      const row = await Institution().findOne({ bdrenOrganizationId: ORG.id }).lean<IInstitution>();
      expect(row).toMatchObject({ tenantId: 'du', name: 'Dhaka University' });
    },
  );

  it('does not provision on other event types, and a redelivery adds nothing', async () => {
    await deliver({
      id: 'evt-other',
      type: 'version.published',
      organization: { id: ORG.id, slug: 'du' },
    });
    expect(await Institution().countDocuments()).toBe(0);

    const event = {
      id: 'evt-once',
      type: 'subscription.activated',
      organization: { id: ORG.id, slug: 'du' },
    };
    await deliver(event);
    await deliver({ ...event, id: 'evt-twice' });
    expect(await Institution().countDocuments()).toBe(1);
  });
});
