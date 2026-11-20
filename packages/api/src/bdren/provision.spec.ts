import http from 'http';
import express from 'express';
import mongoose from 'mongoose';
import { createHmac } from 'crypto';
import { createModels, createMethods, runAsSystem } from '@librechat/data-schemas';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { IInstitution, IAuditLog, BdrenAllowancePayload } from '@librechat/data-schemas';
import type { AddressInfo } from 'net';
import type { BdrenConfig } from './types';
import { getAlertModel } from '~/admin/alerts/store';
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
  const bodies: Array<Record<string, string>> = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (state.down) {
        res.writeHead(503).end();
        return;
      }
      const body = JSON.parse(raw);
      bodies.push(body);
      const answer = answers.get(body.zitadel_subject);
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
    bodies: typeof bodies;
    close: () => Promise<void>;
  }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        answers,
        state,
        bodies,
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
  getAlertModel();
  await Promise.all(
    ['BdrenAllowance', 'BdrenEvent', 'Institution', 'User', 'PlatformAlert'].map((name) =>
      mongoose.models[name]?.init(),
    ),
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
  bdren.bodies.length = 0;
  await Promise.all(
    [
      'BdrenAllowance',
      'BdrenEvent',
      'Institution',
      'AuditLog',
      'User',
      'Conversation',
      'PlatformAlert',
    ].map((name) => mongoose.models[name].collection.deleteMany({})),
  );
  const client = createAllowanceClient(config);
  onCreated = jest.fn().mockResolvedValue(undefined);
  provisioner = createProvisioner({
    config,
    client,
    service: createAllowanceService({ config, client }),
    recordAuditEntry: createMethods(mongoose).recordAuditEntry,
    onCreated,
    placeMember,
  });
});

/** Stands in for the activation service: claims a seat or throws, like `activateProvisionedMember`. */
async function placeMember(userId: string, tenantId: string) {
  const institution = await Institution().findOne({ tenantId }).lean<IInstitution>();
  const max = institution?.limits?.maxActiveMembers;
  if (max != null && (institution?.stats?.activeMembers ?? 0) >= max) {
    return null;
  }
  await Institution().updateOne({ tenantId }, { $inc: { 'stats.activeMembers': 1 } });
  return runAsSystem(() =>
    User()
      .findOneAndUpdate(
        { _id: userId, tenantId: null },
        { $set: { tenantId, membershipStatus: 'active' } },
        { new: true },
      )
      .lean<Record<string, unknown>>()
      .exec(),
  );
}

const User = () => mongoose.models.User;
let seq = 0;
async function makeUser(over: Record<string, unknown> = {}) {
  seq += 1;
  const doc = await User().create({
    provider: 'openid',
    email: `u${seq}@x.test`,
    username: `u${seq}`,
    name: `U${seq}`,
    openidId: `sub-${seq}`,
    openidIssuer: ISSUER,
    ...over,
  });
  return doc.toObject();
}

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

const linked = (over: Record<string, unknown> = {}) =>
  Institution().create({
    tenantId: 'dhaka-university',
    slug: 'dhaka-university',
    name: 'Dhaka University',
    bdrenOrganizationId: ORG.id,
    ...over,
  });

describe('an unlinked institution already holds the slug', () => {
  it('creates nothing, records link_needed once and an alert, and members land in it after linking', async () => {
    await Institution().create({ tenantId: 'du', slug: 'du', name: 'Dhaka University' });
    const org = { id: ORG.id, slug: 'du', name: 'Dhaka University' };

    expect(await provisioner.ensureInstitutionForOrganization(org)).toBeNull();
    expect(await provisioner.ensureInstitutionForOrganization(org)).toBeNull();

    expect(await Institution().countDocuments()).toBe(1);
    const entries = await audits('institution.link_needed');
    expect(entries).toHaveLength(1);
    expect(entries[0].metadata).toMatchObject({ organizationId: ORG.id, unlinkedTenantId: 'du' });
    const alerts = await mongoose.models.PlatformAlert.find({ kind: 'institution_link' }).lean();
    expect(alerts).toHaveLength(1);
    expect(await audits('institution.provisioned')).toHaveLength(0);

    bdren.answers.set('sub-m', institutionAnswer('sub-m', org));
    expect(await provisioner.tenantForNewMember({ issuer: ISSUER, subject: 'sub-m' })).toBeNull();

    await Institution().updateOne({ tenantId: 'du' }, { $set: { bdrenOrganizationId: ORG.id } });
    expect(await provisioner.tenantForNewMember({ issuer: ISSUER, subject: 'sub-m' })).toBe('du');
    expect(await Institution().countDocuments()).toBe(1);
  });

  it('still suffixes when the holder is linked to a different organization', async () => {
    await linked({ bdrenOrganizationId: 'someone-else' });
    const tenantId = await provisioner.ensureInstitutionForOrganization(ORG);
    expect(tenantId).toMatch(/^dhaka-university-/);
    expect(await audits('institution.link_needed')).toHaveLength(0);
  });
});

describe('reviewExistingMember', () => {
  it('never creates an institution; it records an unlinked one once and moves nobody', async () => {
    const user = await makeUser();
    bdren.answers.set(user.openidId as string, institutionAnswer(user.openidId as string));

    await provisioner.reviewExistingMember(user);
    const again = await User().findById(user._id).lean<typeof user>();
    await provisioner.reviewExistingMember(again as typeof user);

    expect(await Institution().countDocuments()).toBe(0);
    const entries = await audits('member.coverage_mismatch');
    expect(entries).toHaveLength(1);
    expect(entries[0].metadata).toMatchObject({
      organizationId: ORG.id,
      institutionTenantId: null,
      currentTenantId: null,
    });
  });

  it('records a member of another tenant and nothing for one already in the right tenant', async () => {
    await linked();
    const other = await makeUser({ tenantId: 'other-uni' });
    bdren.answers.set(other.openidId as string, institutionAnswer(other.openidId as string));
    await provisioner.reviewExistingMember(other);
    expect(await audits('member.coverage_mismatch')).toHaveLength(1);
    expect((await User().findById(other._id).lean<typeof other>())?.tenantId).toBe('other-uni');

    await mongoose.models.AuditLog.collection.deleteMany({});
    const inside = await makeUser({ tenantId: 'dhaka-university' });
    bdren.answers.set(inside.openidId as string, institutionAnswer(inside.openidId as string));
    await provisioner.reviewExistingMember(inside);
    expect(await audits('member.coverage_mismatch')).toHaveLength(0);
  });

  it('places a tenantless user with no chats on a later login and sends the id token', async () => {
    await linked();
    const user = await makeUser();
    bdren.answers.set(user.openidId as string, institutionAnswer(user.openidId as string));

    await provisioner.reviewExistingMember(user, { idToken: 'tok-later' });

    const saved = await User().findById(user._id).lean<typeof user>();
    expect(saved).toMatchObject({ tenantId: 'dhaka-university', membershipStatus: 'active' });
    expect(bdren.bodies[0].id_token).toBe('tok-later');
    expect(await audits('member.coverage_mismatch')).toHaveLength(0);
  });

  it('does not move a tenantless user who already has chats', async () => {
    await linked();
    const user = await makeUser();
    await mongoose.models.Conversation.collection.insertOne({
      conversationId: 'c1',
      user: String(user._id),
    });
    bdren.answers.set(user.openidId as string, institutionAnswer(user.openidId as string));

    await provisioner.reviewExistingMember(user);

    expect((await User().findById(user._id).lean<typeof user>())?.tenantId).toBeUndefined();
    expect(await audits('member.coverage_mismatch')).toHaveLength(1);
  });

  it('does not place into a full institution, and never throws when bdren.ai is down', async () => {
    await linked({ limits: { maxActiveMembers: 1 }, stats: { activeMembers: 1 } });
    const user = await makeUser();
    bdren.answers.set(user.openidId as string, institutionAnswer(user.openidId as string));
    await provisioner.reviewExistingMember(user);
    expect((await User().findById(user._id).lean<typeof user>())?.tenantId).toBeUndefined();

    bdren.state.down = true;
    await expect(provisioner.reviewExistingMember(await makeUser())).resolves.toBeUndefined();
  });
});

describe('first login of a new member', () => {
  it('sends the id token to bdren.ai, and never logs it', async () => {
    const { logger } = jest.requireActual('@librechat/data-schemas');
    const spies = ['info', 'warn', 'error', 'debug'].map((level) => jest.spyOn(logger, level));
    bdren.answers.set('sub-first', institutionAnswer('sub-first'));

    const tenantId = await provisioner.tenantForNewMember({
      issuer: ISSUER,
      subject: 'sub-first',
      idToken: 'secret-id-token',
    });

    expect(tenantId).toBe('dhaka-university');
    expect(bdren.bodies[0]).toMatchObject({
      zitadel_subject: 'sub-first',
      id_token: 'secret-id-token',
    });
    const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
    expect(logged).not.toContain('secret-id-token');
    spies.forEach((spy) => spy.mockRestore());
  });

  it('sends no id_token field when there is none', async () => {
    await provisioner.tenantForNewMember({ issuer: ISSUER, subject: 'sub-none' });
    expect(bdren.bodies[0]).not.toHaveProperty('id_token');
  });

  it('does not name a full institution, so the user is created without a tenant', async () => {
    await linked({ limits: { maxActiveMembers: 1 }, stats: { activeMembers: 1 } });
    bdren.answers.set('sub-full', institutionAnswer('sub-full'));
    expect(
      await provisioner.tenantForNewMember({ issuer: ISSUER, subject: 'sub-full' }),
    ).toBeNull();
  });

  it('keeps a user tenantless, with no suspended row, when placement fails', async () => {
    await linked();
    const user = await makeUser();
    const failing = createProvisioner({
      config,
      client: createAllowanceClient(config),
      service: createAllowanceService({ config, client: createAllowanceClient(config) }),
      recordAuditEntry: createMethods(mongoose).recordAuditEntry,
      placeMember: async () => {
        throw new Error('Seat limit reached');
      },
    });

    expect(await failing.adoptNewMember(String(user._id), 'dhaka-university')).toBeNull();

    const saved = await User().findById(user._id).lean<typeof user>();
    expect(saved?.tenantId).toBeUndefined();
    expect(await User().countDocuments({ membershipStatus: 'suspended' })).toBe(0);
    expect(await audits('member.coverage_mismatch')).toHaveLength(1);
  });

  it('places a user created without a tenant when there is room', async () => {
    await linked();
    const user = await makeUser();
    const placed = await provisioner.adoptNewMember(String(user._id), 'dhaka-university');
    expect(placed).toMatchObject({ tenantId: 'dhaka-university', membershipStatus: 'active' });
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
        user: { issuer: ISSUER, subject: 'someone' },
        organization: { id: ORG.id, slug: 'du', name: 'Dhaka University' },
      });

      expect(response.status).toBe(204);
      const row = await Institution().findOne({ bdrenOrganizationId: ORG.id }).lean<IInstitution>();
      expect(row).toMatchObject({ tenantId: 'du', name: 'Dhaka University' });
    },
  );

  it.each([
    ['subscription.expired', undefined],
    ['subscription.cancelled', undefined],
    ['subscription.downgraded', undefined],
    ['membership.coverage_changed', undefined],
  ])('creates nothing on %s without a person', async (type) => {
    const response = await deliver({
      id: `evt-td-${type}`,
      type,
      organization: { id: ORG.id, slug: 'du', name: 'Dhaka University' },
    });
    expect(response.status).toBe(204);
    expect(await Institution().countDocuments()).toBe(0);
  });

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
