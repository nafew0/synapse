import http from 'http';
import express from 'express';
import mongoose, { Types } from 'mongoose';
import { createHmac } from 'crypto';
import { MongoMemoryServer, MongoMemoryReplSet } from 'mongodb-memory-server';
import { createModels, createMethods, tenantStorage } from '@librechat/data-schemas';
import type { IAuditLog, IMemberMove, BdrenAllowancePayload } from '@librechat/data-schemas';
import type { AddressInfo } from 'net';
import type { BdrenConfig } from './types';
import type { MemberMover } from './move';
import { createAllowanceService } from './allowance';
import { createAllowanceClient } from './client';
import { createWebhookHandler } from './webhook';
import { createProvisioner } from './provision';
import { createMemberPlacer } from './place';
import { createMemberMover } from './move';
import { readBdrenConfig } from './config';
import { getAlertModel } from '~/admin/alerts/store';

const SECRET = 'whsec_move';
const ISSUER = 'https://auth.bdren.test';
const ORG_X = { id: 'org-x-0000', slug: 'x-uni', name: 'X University' };
const ORG_Y = { id: 'org-y-0000', slug: 'y-uni', name: 'Y University' };
const START = '2026-11-15T04:00:00Z';
const END = '2026-12-15T04:00:00Z';

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
      res.end(JSON.stringify({ ...answer, etag: `e-${answer.plan_source}` }));
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

function answer(
  subject: string,
  org: typeof ORG_X | null,
  source: BdrenAllowancePayload['plan_source'] = org ? 'institution' : 'personal',
): BdrenAllowancePayload {
  return {
    product: 'synapse',
    user: { subject },
    plan_source: source,
    package: { slug: 'pro', name: 'Pro', version: 1 },
    institution: org ? { id: org.id, slug: org.slug, name: org.name, seats: 50 } : null,
    subscription: { id: 's', status: 'active', starts_at: START, expires_at: END },
    limits: { ai_credits: { monthly: 1000, weekly: 350 } },
    windows: { month: { start: START, end: END }, week: { start: START, end: END } },
    etag: '',
  };
}

const OWNED: ReadonlyArray<readonly [string, string]> = [
  ['Conversation', 'user'],
  ['Message', 'user'],
  ['File', 'user'],
  ['MemoryEntry', 'userId'],
  ['Preset', 'user'],
  ['PromptGroup', 'author'],
  ['Prompt', 'author'],
  ['Agent', 'author'],
];

const M = (name: string) => mongoose.models[name];
const raw = (name: string) => mongoose.models[name].collection;
const audits = (action: string) =>
  M('AuditLog').find({ action }).sort({ createdAt: 1 }).lean<IAuditLog[]>().exec();
const ownerOf = (name: string, field: string, user: Types.ObjectId) =>
  M(name).schema.path(field)?.instance === 'ObjectId' ? user : String(user);

let mongo: MongoMemoryServer;
let bdren: Awaited<ReturnType<typeof startBdren>>;
let config: BdrenConfig;
let move: MemberMover;
let provisioner: ReturnType<typeof createProvisioner>;

async function reserveSeat(tenantId: string): Promise<boolean> {
  const taken = await M('Institution').findOneAndUpdate(
    {
      tenantId,
      $or: [
        { 'limits.maxActiveMembers': null },
        {
          $expr: { $lt: [{ $ifNull: ['$stats.activeMembers', 0] }, '$limits.maxActiveMembers'] },
        },
      ],
    },
    { $inc: { 'stats.activeMembers': 1 } },
  );
  return taken != null;
}

function build(): void {
  move = createMemberMover({
    reserveSeat,
    releaseSeat: async (tenantId) => {
      await M('Institution').updateOne({ tenantId }, { $inc: { 'stats.activeMembers': -1 } });
    },
    syncMember: async () => undefined,
    recordAuditEntry: (input, options) => createMethods(mongoose).recordAuditEntry(input, options),
  });
  const client = createAllowanceClient(config);
  provisioner = createProvisioner({
    config,
    client,
    service: createAllowanceService({ config, client }),
    recordAuditEntry: createMethods(mongoose).recordAuditEntry,
    place: createMemberPlacer({ activate: async () => ({}) }),
    move,
  });
}

async function connect(uri: string): Promise<void> {
  await mongoose.connect(uri);
  createModels(mongoose);
  getAlertModel();
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
}

async function linkInstitution(
  org: typeof ORG_X,
  over: Record<string, unknown> = {},
): Promise<void> {
  await raw('Institution').insertOne({
    tenantId: org.slug,
    slug: org.slug,
    name: org.name,
    bdrenOrganizationId: org.id,
    status: 'active',
    stats: { activeMembers: 0 },
    ...over,
  });
}

let seq = 0;
interface TestUser {
  _id: Types.ObjectId;
  provider: string;
  email: string;
  username: string;
  name: string;
  role: string;
  openidId: string;
  openidIssuer: string;
  accountScope: 'institution' | 'standalone';
  tenantId?: string;
  membershipStatus?: 'active' | 'suspended';
}

async function makeUser(over: Partial<TestUser> = {}): Promise<TestUser> {
  seq += 1;
  const doc: TestUser = {
    _id: new Types.ObjectId(),
    provider: 'openid',
    email: `u${seq}@x.test`,
    username: `u${seq}`,
    name: `U${seq}`,
    role: 'USER',
    openidId: `sub-${seq}`,
    openidIssuer: ISSUER,
    accountScope: 'standalone',
    ...over,
  };
  await raw('User').insertOne(doc);
  return doc;
}

const tenantOf = (tenantId: string | null) => (tenantId ? { tenantId } : {});

/** One of each private item the person can own, written in `tenantId`. */
async function seedPrivate(user: Types.ObjectId, tenantId: string | null) {
  const uid = String(user);
  const at = tenantOf(tenantId);
  const groupId = new Types.ObjectId();
  const agentId = new Types.ObjectId();
  await Promise.all([
    raw('Conversation').insertOne({ conversationId: `c-${uid}`, user: uid, title: 'Mine', ...at }),
    raw('Message').insertMany([
      { messageId: `m1-${uid}`, conversationId: `c-${uid}`, user: uid, text: 'hi', ...at },
      { messageId: `m2-${uid}`, conversationId: `c-${uid}`, user: uid, text: 'yo', ...at },
    ]),
    raw('File').insertOne({
      user,
      file_id: `f-private-${uid}`,
      filename: 'a.txt',
      filepath: `${tenantId ? `t/${tenantId}/` : ''}uploads/${uid}/a.txt`,
      bytes: 1,
      type: 'text/plain',
      object: 'file',
      usage: 0,
      ...at,
    }),
    raw('MemoryEntry').insertOne({ userId: user, key: 'k', value: 'v', tokenCount: 1, ...at }),
    raw('Preset').insertOne({ presetId: `p-${uid}`, user: uid, title: 'P', ...at }),
    raw('PromptGroup').insertOne({ _id: groupId, name: 'G', author: user, authorName: 'U', ...at }),
    raw('Prompt').insertOne({ groupId, author: user, prompt: 'x', type: 'text', ...at }),
    raw('Agent').insertOne({
      _id: agentId,
      id: `agent_private_${uid}`,
      name: 'Private',
      author: user,
      provider: 'openai',
      model: 'gpt',
      ...at,
    }),
    raw('AclEntry').insertOne({
      principalType: 'user',
      principalModel: 'User',
      principalId: user,
      resourceType: 'agent',
      resourceId: agentId,
      permBits: 15,
      ...at,
    }),
  ]);
  return { agentId, groupId };
}

/** An agent the person shared with the institution, using one of their files. */
async function seedShared(user: Types.ObjectId, tenantId: string) {
  const uid = String(user);
  const agentId = new Types.ObjectId();
  await Promise.all([
    raw('Agent').insertOne({
      _id: agentId,
      id: `agent_shared_${uid}`,
      name: 'Shared',
      author: user,
      provider: 'openai',
      model: 'gpt',
      tool_resources: { file_search: { file_ids: [`f-shared-${uid}`] } },
      tenantId,
    }),
    raw('File').insertOne({
      user,
      file_id: `f-shared-${uid}`,
      filename: 'b.txt',
      filepath: `t/${tenantId}/uploads/${uid}/b.txt`,
      bytes: 1,
      type: 'text/plain',
      object: 'file',
      usage: 0,
      tenantId,
    }),
    raw('AclEntry').insertMany([
      {
        principalType: 'user',
        principalModel: 'User',
        principalId: user,
        resourceType: 'agent',
        resourceId: agentId,
        permBits: 15,
        tenantId,
      },
      {
        principalType: 'group',
        principalModel: 'Group',
        principalId: new Types.ObjectId(),
        resourceType: 'agent',
        resourceId: agentId,
        permBits: 1,
        tenantId,
      },
    ]),
  ]);
  return agentId;
}

async function countOwned(user: Types.ObjectId, tenantId: string | null) {
  const counts = await Promise.all(
    OWNED.map(([name, field]) =>
      raw(name).countDocuments({ [field]: ownerOf(name, field, user), tenantId }),
    ),
  );
  return Object.fromEntries(OWNED.map(([name], i) => [name, counts[i]]));
}

const seats = async (tenantId: string) =>
  (await raw('Institution').findOne({ tenantId }))?.stats?.activeMembers;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await connect(mongo.getUri());
  bdren = await startBdren();
  config = readBdrenConfig({
    BDREN_ALLOWANCE_ENABLED: 'true',
    BDREN_API_URL: bdren.url,
    BDREN_PRODUCT_KEY: 'bdren_prod_synapse_move',
    BDREN_ISSUER: ISSUER,
    BDREN_WEBHOOK_SECRET: SECRET,
    BDREN_ALLOWANCE_TIMEOUT_MS: '500',
  });
});

afterAll(async () => {
  await bdren.close();
  await mongoose.disconnect();
  await mongo?.stop();
});

beforeEach(async () => {
  bdren.state.down = false;
  bdren.answers.clear();
  jest.restoreAllMocks();
  await Promise.all(Object.values(mongoose.models).map((model) => model.collection.deleteMany({})));
  build();
});

describe('an individual whom bdren.ai now covers joins the institution with their data', () => {
  it('moves every private item, leaves nothing tenantless and audits the counts', async () => {
    await linkInstitution(ORG_X);
    const user = await makeUser();
    await seedPrivate(user._id, null);
    bdren.answers.set(user.openidId, answer(user.openidId, ORG_X));

    const moved = await provisioner.reviewExistingMember(user, { idToken: 'tok' });

    expect(moved).toMatchObject({
      tenantId: 'x-uni',
      accountScope: 'institution',
      membershipStatus: 'active',
    });
    const visible = await tenantStorage.run({ tenantId: 'x-uni' }, async () =>
      Promise.all(
        OWNED.map(([name, field]) =>
          M(name).countDocuments({ [field]: ownerOf(name, field, user._id) }),
        ),
      ),
    );
    expect(visible).toEqual([1, 2, 1, 1, 1, 1, 1, 1]);
    expect(Object.values(await countOwned(user._id, null)).every((n) => n === 0)).toBe(true);
    const file = await raw('File').findOne({ user: user._id });
    expect(file).toMatchObject({ tenantId: 'x-uni', storageTenantId: null });
    expect(await raw('AclEntry').countDocuments({ tenantId: 'x-uni' })).toBe(1);
    expect(await seats('x-uni')).toBe(1);

    const [entry] = await audits('member.moved');
    expect(entry.metadata).toMatchObject({
      from: null,
      to: 'x-uni',
      reason: 'coverage_joined',
      moved_conversations: 1,
      moved_messages: 2,
      moved_files: 1,
      moved_memories: 1,
      moved_presets: 1,
      moved_promptGroups: 1,
      moved_prompts: 1,
      moved_agents: 1,
      moved_aclEntries: 1,
    });
    expect(await audits('member.coverage_mismatch')).toHaveLength(0);
  });

  it('is idempotent: a second review and a repeated move change nothing', async () => {
    await linkInstitution(ORG_X);
    const user = await makeUser();
    await seedPrivate(user._id, null);
    bdren.answers.set(user.openidId, answer(user.openidId, ORG_X));
    const moved = await provisioner.reviewExistingMember(user);

    expect(await provisioner.reviewExistingMember({ ...user, ...moved })).toBeNull();
    expect(
      await move({ userId: String(user._id), from: null, to: 'x-uni', reason: 'again' }),
    ).toEqual({ status: 'noop' });
    expect(await audits('member.moved')).toHaveLength(1);
    expect(await seats('x-uni')).toBe(1);
  });
});

describe('a member bdren.ai no longer covers leaves, keeping their data', () => {
  async function member(org = ORG_X) {
    await linkInstitution(org, { stats: { activeMembers: 1 } });
    const user = await makeUser({
      tenantId: org.slug,
      accountScope: 'institution',
      membershipStatus: 'active',
      role: 'INSTITUTION_ADMIN',
    });
    await seedPrivate(user._id, org.slug);
    const sharedAgent = await seedShared(user._id, org.slug);
    return { user, sharedAgent };
  }

  it('takes private items back, leaves shared ones in the institution and keeps the account', async () => {
    const { user, sharedAgent } = await member();
    const colleagueAgent = new Types.ObjectId();
    await raw('AclEntry').insertOne({
      principalType: 'user',
      principalModel: 'User',
      principalId: user._id,
      resourceType: 'agent',
      resourceId: colleagueAgent,
      permBits: 1,
      tenantId: 'x-uni',
    });
    await raw('Group').insertOne({
      name: 'Staff',
      memberIds: [String(user._id), 'someone-else'],
      tenantId: 'x-uni',
    });
    bdren.answers.set(user.openidId, answer(user.openidId, null, 'personal'));

    const moved = await provisioner.reviewExistingMember(user);

    expect(moved).toMatchObject({ accountScope: 'standalone', role: 'USER' });
    expect(moved?.tenantId).toBeUndefined();
    expect(moved?.membershipStatus).toBeUndefined();
    expect(await raw('User').countDocuments({ _id: user._id })).toBe(1);
    expect(await countOwned(user._id, null)).toEqual({
      Conversation: 1,
      Message: 2,
      File: 1,
      MemoryEntry: 1,
      Preset: 1,
      PromptGroup: 1,
      Prompt: 1,
      Agent: 1,
    });
    expect(await raw('Agent').findOne({ _id: sharedAgent })).toMatchObject({ tenantId: 'x-uni' });
    expect(await raw('File').findOne({ file_id: `f-shared-${user._id}` })).toMatchObject({
      tenantId: 'x-uni',
    });
    const privateFile = await raw('File').findOne({ file_id: `f-private-${user._id}` });
    expect(privateFile?.tenantId).toBeUndefined();
    expect(privateFile?.storageTenantId).toBe('x-uni');
    expect(await raw('AclEntry').countDocuments({ principalId: user._id, tenantId: 'x-uni' })).toBe(
      0,
    );
    expect(await raw('AclEntry').countDocuments({ resourceId: sharedAgent })).toBe(1);
    expect((await raw('Group').findOne({ name: 'Staff' }))?.memberIds).toEqual(['someone-else']);
    expect(await seats('x-uni')).toBe(0);

    const [entry] = await audits('member.moved');
    expect(entry.metadata).toMatchObject({
      from: 'x-uni',
      to: null,
      reason: 'coverage_left',
      keptOwner: String(user._id),
      keptAgents: String(sharedAgent),
      keptFiles: `f-shared-${user._id}`,
      moved_agents: 1,
      moved_files: 1,
      moved_aclRevoked: 2,
      moved_groups: 1,
    });
  });

  it('moves from X to Y when bdren.ai covers them under Y: a leave from X and a join to Y', async () => {
    const { user, sharedAgent } = await member();
    await linkInstitution(ORG_Y);
    bdren.answers.set(user.openidId, answer(user.openidId, ORG_Y));

    const moved = await provisioner.reviewExistingMember(user);

    expect(moved).toMatchObject({
      tenantId: 'y-uni',
      membershipStatus: 'active',
      accountScope: 'institution',
      role: 'USER',
    });
    expect(await countOwned(user._id, 'y-uni')).toMatchObject({ Conversation: 1, Agent: 1 });
    expect(await raw('Agent').findOne({ _id: sharedAgent })).toMatchObject({ tenantId: 'x-uni' });
    expect([await seats('x-uni'), await seats('y-uni')]).toEqual([0, 1]);
  });

  it('leaves X when the institution now covering them is full, and records the refusal', async () => {
    const { user } = await member();
    await linkInstitution(ORG_Y, { limits: { maxActiveMembers: 0 } });
    bdren.answers.set(user.openidId, answer(user.openidId, ORG_Y));

    const moved = await provisioner.reviewExistingMember(user);

    expect(moved?.tenantId).toBeUndefined();
    const [refused] = await audits('member.coverage_mismatch');
    expect(refused.metadata).toMatchObject({
      reason: 'institution_full',
      organizationId: ORG_Y.id,
    });
  });

  it('follows a membership.coverage_changed webhook with a fresh answer', async () => {
    const { user } = await member();
    const client = createAllowanceClient(config);
    const handler = createWebhookHandler({
      config,
      service: createAllowanceService({ config, client }),
      findSubject: async () => null,
      reviewMember: async (issuer, subject) => {
        const found = await raw('User').findOne({ openidId: subject, openidIssuer: issuer });
        if (found) {
          await provisioner.reviewExistingMember(
            { ...found, _id: String(found._id) },
            { fresh: true },
          );
        }
      },
    });
    const app = express();
    app.post('/hook', express.raw({ type: () => true }), (req, res) => void handler(req, res));
    const server = await new Promise<http.Server>((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    bdren.answers.set(user.openidId, answer(user.openidId, null, 'personal'));
    const body = JSON.stringify({
      id: 'evt-coverage-1',
      type: 'membership.coverage_changed',
      user: { issuer: ISSUER, subject: user.openidId },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex');

    const response = await fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-BdREN-Timestamp': timestamp,
          'X-BdREN-Signature': `v1=${signature}`,
        },
        body,
      },
    );
    await new Promise((done) => server.close(done));

    expect(response.status).toBe(204);
    expect((await raw('User').findOne({ _id: user._id }))?.tenantId).toBeUndefined();
    expect(await audits('member.moved')).toHaveLength(1);
  });
});

describe('crash safety and locking', () => {
  it('finishes a move that crashed midway on the next try, applying each step exactly once', async () => {
    await linkInstitution(ORG_X);
    const user = await makeUser();
    await seedPrivate(user._id, null);
    jest
      .spyOn(raw('Message'), 'updateMany')
      .mockRejectedValueOnce(new Error('connection lost mid-move'));
    const request = { userId: String(user._id), from: null, to: 'x-uni', reason: 'test' };

    await expect(move(request)).rejects.toThrow('connection lost mid-move');
    const halfway = await M('MemberMove').findOne({ userId: user._id }).lean<IMemberMove>();
    expect(halfway).toMatchObject({ status: 'running', seatReserved: true });
    expect(halfway?.completed).toEqual(['conversations']);
    expect((await raw('User').findOne({ _id: user._id }))?.tenantId).toBeUndefined();

    const outcome = await move(request);

    expect(outcome).toMatchObject({
      status: 'moved',
      moved: expect.objectContaining({ conversations: 1, messages: 2, agents: 1 }),
    });
    expect(await countOwned(user._id, 'x-uni')).toMatchObject({ Conversation: 1, Message: 2 });
    expect(await seats('x-uni')).toBe(1);
    expect(await audits('member.moved')).toHaveLength(1);
    expect(await M('MemberMove').countDocuments({ status: 'running' })).toBe(0);
  });

  it('runs one move when several triggers fire at once', async () => {
    await linkInstitution(ORG_X);
    const user = await makeUser();
    await seedPrivate(user._id, null);
    const request = { userId: String(user._id), from: null, to: 'x-uni', reason: 'race' };

    const outcomes = await Promise.all(Array.from({ length: 6 }, () => move(request)));

    expect(outcomes.filter((outcome) => outcome.status === 'moved')).toHaveLength(1);
    expect(outcomes.every((outcome) => ['moved', 'busy', 'noop'].includes(outcome.status))).toBe(
      true,
    );
    expect(await audits('member.moved')).toHaveLength(1);
    expect(await seats('x-uni')).toBe(1);
    expect(await countOwned(user._id, 'x-uni')).toMatchObject({ Message: 2 });
  });

  it('leaves a clashing record in place and counts it, moving the rest', async () => {
    await linkInstitution(ORG_X);
    const user = await makeUser();
    const colleague = new Types.ObjectId();
    await raw('MCPServer').insertMany([
      { serverName: 'github', author: colleague, config: {}, tenantId: 'x-uni' },
      { serverName: 'github', author: user._id, config: {} },
      { serverName: 'notion', author: user._id, config: {} },
    ]);

    const outcome = await move({
      userId: String(user._id),
      from: null,
      to: 'x-uni',
      reason: 'clash',
    });

    expect(outcome).toMatchObject({
      status: 'moved',
      moved: expect.objectContaining({ mcpServers: 1 }),
      conflicts: expect.objectContaining({ mcpServers: 1 }),
    });
    expect(await raw('MCPServer').countDocuments({ author: user._id, tenantId: 'x-uni' })).toBe(1);
  });
});

describe('who is never moved', () => {
  it('never moves a member of an institution that is not linked to bdren.ai', async () => {
    await linkInstitution(ORG_X);
    await raw('Institution').insertOne({ tenantId: 'old-uni', slug: 'old-uni', name: 'Old' });
    const user = await makeUser({ tenantId: 'old-uni', accountScope: 'institution' });
    await seedPrivate(user._id, 'old-uni');
    bdren.answers.set(user.openidId, answer(user.openidId, ORG_X));

    expect(await provisioner.reviewExistingMember(user)).toBeNull();

    expect((await raw('User').findOne({ _id: user._id }))?.tenantId).toBe('old-uni');
    expect(await countOwned(user._id, 'old-uni')).toMatchObject({ Conversation: 1 });
    const [entry] = await audits('member.coverage_mismatch');
    expect(entry.metadata).toMatchObject({ reason: 'legacy_tenant' });
  });

  it('never moves platform staff, by role or by platform-admin row', async () => {
    await linkInstitution(ORG_X);
    const admin = await makeUser({ role: 'ADMIN' });
    const staff = await makeUser();
    await raw('PlatformAdmin').insertOne({ userId: staff._id, email: staff.email, active: true });
    for (const user of [admin, staff]) {
      bdren.answers.set(user.openidId, answer(user.openidId, ORG_X));
      expect(await provisioner.reviewExistingMember(user)).toBeNull();
      expect((await raw('User').findOne({ _id: user._id }))?.tenantId).toBeUndefined();
    }
    expect(
      await move({ userId: String(staff._id), from: null, to: 'x-uni', reason: 'direct' }),
    ).toEqual({ status: 'refused', reason: 'staff' });
    expect(await audits('member.moved')).toHaveLength(0);
  });

  it('never moves anyone on the Free fallback or a stale answer', async () => {
    await linkInstitution(ORG_X, { stats: { activeMembers: 2 } });
    const unreachable = await makeUser({
      tenantId: 'x-uni',
      accountScope: 'institution',
      membershipStatus: 'active',
    });
    bdren.state.down = true;
    expect(await provisioner.reviewExistingMember(unreachable)).toBeNull();

    const stale = await makeUser({
      tenantId: 'x-uni',
      accountScope: 'institution',
      membershipStatus: 'active',
    });
    bdren.state.down = false;
    bdren.answers.set(stale.openidId, answer(stale.openidId, null, 'personal'));
    const client = createAllowanceClient(config);
    await createAllowanceService({ config, client }).getAllowance({
      userId: String(stale._id),
      account: 'x-uni',
      issuer: ISSUER,
      subject: stale.openidId,
    });
    await raw('BdrenAllowance').updateOne(
      { userId: stale._id },
      { $set: { verifiedAt: new Date(Date.now() - 2 * 3_600_000) } },
    );
    bdren.state.down = true;
    expect(await provisioner.reviewExistingMember(stale)).toBeNull();

    expect(await raw('User').countDocuments({ tenantId: 'x-uni' })).toBe(2);
    expect(await audits('member.moved')).toHaveLength(0);
    const refused = await audits('member.coverage_mismatch');
    expect(refused.map((entry) => entry.metadata?.reason)).toEqual([
      'unverified_answer',
      'unverified_answer',
    ]);
  });

  it('refuses a join into a full institution, before moving anything', async () => {
    await linkInstitution(ORG_X, { limits: { maxActiveMembers: 1 }, stats: { activeMembers: 1 } });
    const user = await makeUser();
    await seedPrivate(user._id, null);
    bdren.answers.set(user.openidId, answer(user.openidId, ORG_X));

    expect(await provisioner.reviewExistingMember(user)).toBeNull();
    const [entry] = await audits('member.coverage_mismatch');
    expect(entry.metadata).toMatchObject({ reason: 'institution_full' });

    /** Full by the time the seat is taken, though it looked free when the review checked. */
    expect(
      await move({ userId: String(user._id), from: null, to: 'x-uni', reason: 'race' }),
    ).toEqual({ status: 'refused', reason: 'full' });
    expect(await countOwned(user._id, null)).toMatchObject({ Conversation: 1, Message: 2 });
    expect(await M('MemberMove').findOne({ userId: user._id }).lean()).toMatchObject({
      status: 'refused',
      refusal: 'full',
    });
  });
});

describe('with transactions (replica set)', () => {
  let replSet: MongoMemoryReplSet;

  beforeAll(async () => {
    await mongoose.disconnect();
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await connect(replSet.getUri());
  }, 60_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await replSet.stop();
    await connect(mongo.getUri());
  });

  it('moves everything and the user in one transaction', async () => {
    await linkInstitution(ORG_X);
    const user = await makeUser();
    await seedPrivate(user._id, null);

    const outcome = await move({ userId: String(user._id), from: null, to: 'x-uni', reason: 'tx' });

    expect(outcome).toMatchObject({ status: 'moved', to: 'x-uni' });
    expect(await M('MemberMove').findOne({ userId: user._id }).lean()).toMatchObject({
      status: 'done',
      mode: 'transaction',
    });
    expect(await countOwned(user._id, 'x-uni')).toMatchObject({ Conversation: 1, Message: 2 });
  });

  it('falls back to the step-by-step move when the transaction hits a clash', async () => {
    await linkInstitution(ORG_X);
    const user = await makeUser();
    await seedPrivate(user._id, null);
    await raw('MCPServer').insertMany([
      { serverName: 'github', author: new Types.ObjectId(), config: {}, tenantId: 'x-uni' },
      { serverName: 'github', author: user._id, config: {} },
    ]);

    const outcome = await move({ userId: String(user._id), from: null, to: 'x-uni', reason: 'tx' });

    expect(outcome).toMatchObject({
      status: 'moved',
      conflicts: expect.objectContaining({ mcpServers: 1 }),
    });
    expect(await M('MemberMove').findOne({ userId: user._id }).lean()).toMatchObject({
      mode: 'sequential',
    });
    expect(await countOwned(user._id, 'x-uni')).toMatchObject({ Conversation: 1, Message: 2 });
  });
});
