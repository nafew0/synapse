import http from 'http';
import express from 'express';
import mongoose, { Types } from 'mongoose';
import { createHmac } from 'crypto';
import { MongoMemoryServer, MongoMemoryReplSet } from 'mongodb-memory-server';
import { createModels, createMethods, tenantStorage } from '@librechat/data-schemas';
import type { IAuditLog, IMemberMove, BdrenAllowancePayload } from '@librechat/data-schemas';
import type { AddressInfo } from 'net';
import type { BdrenConfig } from './types';
import { createAllowanceService } from './allowance';
import { createAllowanceClient } from './client';
import { createWebhookHandler } from './webhook';
import { createProvisioner } from './provision';
import { createMemberPlacer } from './place';
import { createMemberMover } from './move';
import { reserveMoveSeat, releaseMoveSeat } from './seats';
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
let mover: ReturnType<typeof createMemberMover>;
const move = (request: Parameters<typeof mover.move>[0]) => mover.move(request);
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
  mover = createMemberMover({
    schedule: () => undefined,
    reserveSeat: reserveMoveSeat,
    releaseSeat: releaseMoveSeat,
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
    mover,
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
      avatar: { filepath: `${tenantId ? `t/${tenantId}/` : ''}avatars/${uid}/a.png`, source: 's3' },
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
    expect((await raw('Agent').findOne({ author: user._id }))?.avatar).toMatchObject({
      source: 's3',
      storageTenantId: null,
    });
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
    expect(halfway?.completed).toEqual(['renames', 'strippedServers', 'conversations']);
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

  it('renames a server or skill whose name is taken in the target, so everything moves', async () => {
    await linkInstitution(ORG_X);
    const user = await makeUser();
    const colleague = new Types.ObjectId();
    const skillId = new Types.ObjectId();
    await raw('MCPServer').insertMany([
      { serverName: 'github', author: colleague, config: {}, tenantId: 'x-uni' },
      { serverName: 'github', author: user._id, config: {} },
      { serverName: 'notion', author: user._id, config: {} },
    ]);
    await raw('Skill').insertMany([
      { name: 'summarise', author: user._id, tenantId: 'x-uni', transferredFrom: null },
      { _id: skillId, name: 'summarise', author: user._id },
    ]);
    await raw('SkillFile').insertOne({
      skillId,
      relativePath: 'run.py',
      author: user._id,
      filepath: `uploads/${user._id}/run.py`,
    });
    await raw('Agent').insertOne({
      id: 'agent_uses_github',
      name: 'Uses github',
      author: user._id,
      provider: 'openai',
      model: 'gpt',
      mcpServerNames: ['github'],
      tools: ['search_issues_mcp_github', 'web_search'],
    });

    const outcome = await move({
      userId: String(user._id),
      from: null,
      to: 'x-uni',
      reason: 'clash',
    });

    expect(outcome).toMatchObject({ status: 'moved', conflicts: {} });
    expect(
      await raw('MCPServer')
        .find({ author: user._id, tenantId: 'x-uni' })
        .map((server) => server.serverName)
        .toArray(),
    ).toEqual(expect.arrayContaining(['github-moved', 'notion']));
    expect(await raw('Agent').findOne({ id: 'agent_uses_github' })).toMatchObject({
      tenantId: 'x-uni',
      mcpServerNames: ['github-moved'],
      tools: ['search_issues_mcp_github-moved', 'web_search'],
    });
    expect(await raw('Skill').findOne({ _id: skillId })).toMatchObject({
      name: 'summarise-moved',
      tenantId: 'x-uni',
    });
    expect(await raw('SkillFile').findOne({ skillId })).toMatchObject({
      tenantId: 'x-uni',
      storageTenantId: null,
    });
    const [entry] = await audits('member.moved');
    expect(entry.metadata?.renamed).toBe(
      'MCPServer:github->github-moved,Skill:summarise->summarise-moved',
    );
  });

  it('moves skill files only with a skill that moved', async () => {
    await linkInstitution(ORG_X, { stats: { activeMembers: 1 } });
    const user = await makeUser({ tenantId: 'x-uni', accountScope: 'institution' });
    const shared = new Types.ObjectId();
    await raw('Skill').insertOne({
      _id: shared,
      name: 'shared',
      author: user._id,
      tenantId: 'x-uni',
    });
    await raw('SkillFile').insertOne({
      skillId: shared,
      relativePath: 'a',
      author: user._id,
      tenantId: 'x-uni',
    });
    await raw('AclEntry').insertOne({
      principalType: 'group',
      principalId: new Types.ObjectId(),
      resourceType: 'skill',
      resourceId: shared,
      permBits: 1,
      tenantId: 'x-uni',
    });

    await move({ userId: String(user._id), from: 'x-uni', to: null, reason: 'leave' });

    expect(await raw('SkillFile').findOne({ skillId: shared })).toMatchObject({
      tenantId: 'x-uni',
    });
  });
});

describe('what stays in the institution on a leave', () => {
  async function leaver(extra: Partial<TestUser> = {}) {
    await linkInstitution(ORG_X, { stats: { activeMembers: 2 } });
    return makeUser({
      tenantId: 'x-uni',
      accountScope: 'institution',
      membershipStatus: 'active',
      ...extra,
    });
  }

  it("keeps the person's files that a colleague's agent uses", async () => {
    const user = await leaver();
    await seedPrivate(user._id, 'x-uni');
    await raw('File').insertOne({
      user: user._id,
      file_id: 'f-used-by-colleague',
      filename: 'c.txt',
      filepath: `t/x-uni/uploads/${user._id}/c.txt`,
      tenantId: 'x-uni',
    });
    await raw('Agent').insertOne({
      id: 'agent_colleague',
      author: new Types.ObjectId(),
      tool_resources: { execute_code: { file_ids: ['f-used-by-colleague'] } },
      tenantId: 'x-uni',
    });

    await move({ userId: String(user._id), from: 'x-uni', to: null, reason: 'leave' });

    expect(await raw('File').findOne({ file_id: 'f-used-by-colleague' })).toMatchObject({
      tenantId: 'x-uni',
      transferredFrom: user._id,
      storageUserId: String(user._id),
    });
    expect(
      (await raw('File').findOne({ file_id: `f-private-${user._id}` }))?.tenantId,
    ).toBeUndefined();
  });

  it('hands what stays to an institution admin, who inherits the grants; the person keeps none', async () => {
    const admin = await makeUser({
      tenantId: 'x-uni',
      accountScope: 'institution',
      role: 'INSTITUTION_ADMIN',
      membershipStatus: 'active',
    });
    const user = await leaver();
    const sharedAgent = await seedShared(user._id, 'x-uni');
    await raw('Prompt').insertOne({
      groupId: new Types.ObjectId(),
      author: user._id,
      prompt: 'in a colleague group',
      tenantId: 'x-uni',
    });

    await move({ userId: String(user._id), from: 'x-uni', to: null, reason: 'leave' });

    expect(await raw('Agent').findOne({ _id: sharedAgent })).toMatchObject({
      author: admin._id,
      transferredFrom: user._id,
      tenantId: 'x-uni',
    });
    expect(await raw('File').findOne({ file_id: `f-shared-${user._id}` })).toMatchObject({
      user: admin._id,
      storageUserId: String(user._id),
    });
    expect(await raw('Prompt').findOne({ prompt: 'in a colleague group' })).toMatchObject({
      author: admin._id,
    });
    /** Owner-keyed lookups the person can run as an individual (no tenant filter) find nothing kept. */
    for (const [name, field] of OWNED) {
      expect(
        await raw(name).countDocuments({
          [field]: ownerOf(name, field, user._id),
          tenantId: 'x-uni',
        }),
      ).toBe(0);
    }
    expect(await raw('AclEntry').countDocuments({ principalId: user._id })).toBe(0);
    expect(
      await raw('AclEntry').findOne({ principalId: admin._id, resourceId: sharedAgent }),
    ).toMatchObject({ permBits: 15, tenantId: 'x-uni' });
    expect(
      await raw('AclEntry').countDocuments({ resourceId: sharedAgent, principalType: 'group' }),
    ).toBe(1);
    const [entry] = await audits('member.moved');
    expect(entry.metadata).toMatchObject({ heir: String(admin._id), heirIsUser: true });
  });

  it('hands what stays to the institution itself when it has no admin', async () => {
    const user = await leaver();
    const sharedAgent = await seedShared(user._id, 'x-uni');
    const institution = await raw('Institution').findOne({ tenantId: 'x-uni' });

    await move({ userId: String(user._id), from: 'x-uni', to: null, reason: 'leave' });

    expect(await raw('Agent').findOne({ _id: sharedAgent })).toMatchObject({
      author: institution?._id,
      transferredFrom: user._id,
    });
  });

  it('removes per-user settings in the old institution and clears both override caches', async () => {
    const cleared: Array<string | undefined> = [];
    mover = createMemberMover({
      schedule: () => undefined,
      reserveSeat,
      releaseSeat: async () => undefined,
      syncMember: async () => undefined,
      clearOverrides: async (tenantId) => cleared.push(tenantId),
      recordAuditEntry: (input, options) =>
        createMethods(mongoose).recordAuditEntry(input, options),
    });
    const user = await leaver();
    await raw('Config').insertOne({
      principalType: 'user',
      principalId: String(user._id),
      principalModel: 'User',
      priority: 30,
      overrides: { interface: { agents: false } },
      tenantId: 'x-uni',
    });

    await move({ userId: String(user._id), from: 'x-uni', to: null, reason: 'leave' });

    expect(await raw('Config').countDocuments({ principalId: String(user._id) })).toBe(0);
    expect(cleared).toEqual(['x-uni', undefined]);
  });
});

describe('grants on what a joining individual brings', () => {
  it('drops grants to principals outside the institution and keeps public ones', async () => {
    await linkInstitution(ORG_X);
    const user = await makeUser();
    const other = await makeUser();
    const { agentId } = await seedPrivate(user._id, null);
    await raw('AclEntry').insertMany([
      {
        principalType: 'user',
        principalId: other._id,
        resourceType: 'agent',
        resourceId: agentId,
        permBits: 1,
      },
      {
        principalType: 'role',
        principalId: 'USER',
        resourceType: 'agent',
        resourceId: agentId,
        permBits: 1,
      },
      { principalType: 'public', resourceType: 'agent', resourceId: agentId, permBits: 1 },
    ]);

    await move({ userId: String(user._id), from: null, to: 'x-uni', reason: 'join' });

    const left = await raw('AclEntry').find({ resourceId: agentId }).toArray();
    expect(left.map((entry) => entry.principalType).sort()).toEqual(['public', 'user']);
    expect(left.every((entry) => entry.tenantId === 'x-uni')).toBe(true);
    const [entry] = await audits('member.moved');
    expect(entry.metadata?.droppedGrantCount).toBe(2);
    expect(String(entry.metadata?.droppedGrants)).toContain(`user:${String(other._id)}`);
  });
});

describe('unfinished moves', () => {
  it('finishes a stranded move on the next review, then redirects it when coverage changed', async () => {
    await linkInstitution(ORG_X);
    const user = await makeUser();
    await seedPrivate(user._id, null);
    jest.spyOn(raw('Message'), 'updateMany').mockRejectedValueOnce(new Error('crash'));
    await expect(
      move({ userId: String(user._id), from: null, to: 'x-uni', reason: 'join' }),
    ).rejects.toThrow('crash');
    bdren.answers.set(user.openidId, answer(user.openidId, null, 'personal'));

    const reviewed = await provisioner.reviewExistingMember(user);

    expect(reviewed?.tenantId).toBeUndefined();
    expect(await countOwned(user._id, null)).toMatchObject({ Conversation: 1, Message: 2 });
    expect(await seats('x-uni')).toBe(0);
    expect(await M('MemberMove').countDocuments({ status: 'running' })).toBe(0);
    expect((await audits('member.moved')).map((entry) => entry.metadata?.to)).toEqual([
      'x-uni',
      null,
    ]);
  });

  it('is finished by the recovery timer once its lease has run out', async () => {
    await linkInstitution(ORG_X);
    const user = await makeUser();
    await seedPrivate(user._id, null);
    jest.spyOn(raw('Message'), 'updateMany').mockRejectedValueOnce(new Error('crash'));
    await expect(
      move({ userId: String(user._id), from: null, to: 'x-uni', reason: 'join' }),
    ).rejects.toThrow('crash');

    expect(await mover.resumeStranded()).toMatchObject({ resumed: 1 });
    expect((await raw('User').findOne({ _id: user._id }))?.tenantId).toBe('x-uni');
  });

  it('follows the person when someone else places them mid-move, giving the seat back', async () => {
    await linkInstitution(ORG_X);
    await raw('Institution').insertOne({ tenantId: 'z-uni', slug: 'z-uni', name: 'Z' });
    const user = await makeUser();
    await seedPrivate(user._id, null);
    const sessions = raw('Session');
    const original = sessions.updateMany.bind(sessions);
    jest.spyOn(sessions, 'updateMany').mockImplementationOnce(async (...args) => {
      await raw('User').updateOne({ _id: user._id }, { $set: { tenantId: 'z-uni' } });
      return original(...args);
    });

    const outcome = await move({
      userId: String(user._id),
      from: null,
      to: 'x-uni',
      reason: 'join',
    });

    expect(outcome).toEqual({ status: 'redirected', to: 'z-uni' });
    expect(await countOwned(user._id, 'z-uni')).toMatchObject({
      Conversation: 1,
      Message: 2,
      Agent: 1,
    });
    expect(await countOwned(user._id, 'x-uni')).toMatchObject({ Conversation: 0, Message: 0 });
    expect(await seats('x-uni')).toBe(0);
    expect((await raw('User').findOne({ _id: user._id }))?.movingUntil).toBeUndefined();
  });

  it('gives back the seat it took when it is refused after taking it', async () => {
    await linkInstitution(ORG_X);
    const user = await makeUser();
    mover = createMemberMover({
      schedule: () => undefined,
      reserveSeat: async (tenantId) => {
        await raw('User').deleteOne({ _id: user._id });
        return reserveSeat(tenantId);
      },
      releaseSeat: async (tenantId) => {
        await M('Institution').updateOne({ tenantId }, { $inc: { 'stats.activeMembers': -1 } });
      },
      syncMember: async () => undefined,
      recordAuditEntry: (input, options) =>
        createMethods(mongoose).recordAuditEntry(input, options),
    });

    expect(
      await move({ userId: String(user._id), from: null, to: 'x-uni', reason: 'join' }),
    ).toEqual({
      status: 'refused',
      reason: 'not_found',
    });
    expect(await seats('x-uni')).toBe(0);
  });

  it('records a seat as given back only once that worked, and retries it', async () => {
    await linkInstitution(ORG_X, { stats: { activeMembers: 1 } });
    const user = await makeUser({
      tenantId: 'x-uni',
      accountScope: 'institution',
      membershipStatus: 'active',
    });
    let failures = 1;
    mover = createMemberMover({
      schedule: () => undefined,
      reserveSeat,
      releaseSeat: async (tenantId) => {
        if (failures-- > 0) {
          throw new Error('seat counter unavailable');
        }
        await M('Institution').updateOne({ tenantId }, { $inc: { 'stats.activeMembers': -1 } });
      },
      syncMember: async () => undefined,
      recordAuditEntry: (input, options) =>
        createMethods(mongoose).recordAuditEntry(input, options),
    });
    const request = { userId: String(user._id), from: 'x-uni', to: null, reason: 'leave' };

    await expect(move(request)).rejects.toThrow('seat counter unavailable');
    expect(await M('MemberMove').findOne({ userId: user._id }).lean()).toMatchObject({
      status: 'running',
      userSwitched: true,
      seatReleased: false,
    });
    expect(await mover.resume(String(user._id))).toMatchObject({ status: 'moved' });
    expect(await seats('x-uni')).toBe(0);
  });
});

describe('requests still running when the move happened', () => {
  it('fences the account while it moves and lifts the fence after', async () => {
    await linkInstitution(ORG_X);
    const user = await makeUser();
    await seedPrivate(user._id, null);
    let fenced: Date | undefined;
    const messages = raw('Message');
    const original = messages.updateMany.bind(messages);
    jest.spyOn(messages, 'updateMany').mockImplementationOnce(async (...args) => {
      fenced = (await raw('User').findOne({ _id: user._id }))?.movingUntil;
      return original(...args);
    });

    await move({ userId: String(user._id), from: null, to: 'x-uni', reason: 'join' });

    expect(fenced?.getTime()).toBeGreaterThan(Date.now());
    expect((await raw('User').findOne({ _id: user._id }))?.movingUntil).toBeUndefined();
  });

  it('merges late writes into the moved conversation instead of duplicating it', async () => {
    mover = createMemberMover({
      schedule: () => undefined,
      lateSweepMs: 0,
      reserveSeat,
      releaseSeat: async () => undefined,
      syncMember: async () => undefined,
      recordAuditEntry: (input, options) =>
        createMethods(mongoose).recordAuditEntry(input, options),
    });
    await linkInstitution(ORG_X);
    const user = await makeUser();
    await seedPrivate(user._id, null);
    const uid = String(user._id);
    await move({ userId: uid, from: null, to: 'x-uni', reason: 'join' });
    const later = new Date(Date.now() + 1_000);
    await raw('Conversation').insertOne({
      conversationId: `c-${uid}`,
      user: uid,
      title: 'Renamed late',
      updatedAt: later,
    });
    await raw('Message').insertMany([
      {
        messageId: `m2-${uid}`,
        conversationId: `c-${uid}`,
        user: uid,
        text: 'final answer',
        updatedAt: later,
      },
      {
        messageId: `m3-${uid}`,
        conversationId: `c-${uid}`,
        user: uid,
        text: 'late reply',
        updatedAt: later,
      },
    ]);
    const record = await M('MemberMove')
      .findOne({ userId: user._id })
      .lean<{ _id: Types.ObjectId }>();

    expect(await mover.sweepLate(String(record?._id))).toBe(true);
    expect(await mover.sweepLate(String(record?._id))).toBe(false);

    expect(await raw('Conversation').find({ user: uid }).toArray()).toEqual([
      expect.objectContaining({ title: 'Renamed late', tenantId: 'x-uni' }),
    ]);
    const texts = await raw('Message')
      .find({ user: uid })
      .sort({ messageId: 1 })
      .map((message) => `${message.tenantId}:${message.text}`)
      .toArray();
    expect(texts).toEqual(['x-uni:hi', 'x-uni:final answer', 'x-uni:late reply']);
  });
});

describe('second review fixes', () => {
  const memberOfX = async (extra: Partial<TestUser> = {}) =>
    makeUser({
      tenantId: 'x-uni',
      accountScope: 'institution',
      membershipStatus: 'active',
      ...extra,
    });

  it("never hands the heir the person's grants on a colleague's prompt group", async () => {
    await linkInstitution(ORG_X, { stats: { activeMembers: 2 } });
    const admin = await memberOfX({ role: 'INSTITUTION_ADMIN' });
    const user = await memberOfX();
    const colleagueGroup = new Types.ObjectId();
    await raw('PromptGroup').insertOne({
      _id: colleagueGroup,
      name: 'Theirs',
      author: new Types.ObjectId(),
      tenantId: 'x-uni',
    });
    await raw('Prompt').insertOne({
      groupId: colleagueGroup,
      author: user._id,
      prompt: 'mine',
      tenantId: 'x-uni',
    });
    await raw('AclEntry').insertOne({
      principalType: 'user',
      principalId: user._id,
      resourceType: 'promptGroup',
      resourceId: colleagueGroup,
      permBits: 3,
      tenantId: 'x-uni',
    });

    await move({ userId: String(user._id), from: 'x-uni', to: null, reason: 'leave' });

    expect(await raw('AclEntry').countDocuments({ resourceId: colleagueGroup })).toBe(0);
    expect(await raw('Prompt').findOne({ prompt: 'mine' })).toMatchObject({
      author: admin._id,
      tenantId: 'x-uni',
    });
    const record = await M('MemberMove').findOne({ userId: user._id }).lean<IMemberMove>();
    expect(record?.plan).toMatchObject({
      keptPromptGroups: [],
      foreignPromptGroups: [String(colleagueGroup)],
    });
  });

  it('strips MCP servers that stay behind from moving agents, and keeps the moving and yaml ones', async () => {
    await linkInstitution(ORG_X);
    const user = await makeUser();
    await raw('MCPServer').insertMany([
      { serverName: 'other', author: new Types.ObjectId(), config: {} },
      { serverName: 'mine', author: user._id, config: {} },
    ]);
    await raw('Agent').insertOne({
      id: 'agent_mcp',
      author: user._id,
      mcpServerNames: ['other', 'mine', 'yamlsrv'],
      tools: ['a_mcp_other', 'b_mcp_mine', 'c_mcp_yamlsrv', 'web_search'],
      tool_options: { a_mcp_other: { defer: true }, b_mcp_mine: { defer: false } },
    });

    await move({ userId: String(user._id), from: null, to: 'x-uni', reason: 'join' });

    expect(await raw('Agent').findOne({ id: 'agent_mcp' })).toMatchObject({
      tenantId: 'x-uni',
      mcpServerNames: ['mine', 'yamlsrv'],
      tools: ['b_mcp_mine', 'c_mcp_yamlsrv', 'web_search'],
      tool_options: { b_mcp_mine: { defer: false } },
    });
    const [entry] = await audits('member.moved');
    expect(entry.metadata?.removedServers).toMatch(/:other$/);
  });

  it("carries a renamed server's credentials, tokens and tool options with it", async () => {
    await linkInstitution(ORG_X);
    const user = await makeUser();
    const uid = String(user._id);
    await raw('MCPServer').insertMany([
      { serverName: 'github', author: new Types.ObjectId(), config: {}, tenantId: 'x-uni' },
      { serverName: 'github', author: user._id, config: {} },
    ]);
    await raw('Agent').insertOne({
      id: 'agent_gh',
      author: user._id,
      mcpServerNames: ['github'],
      tools: ['issues_mcp_github'],
      tool_options: { issues_mcp_github: { defer: true } },
    });
    await raw('PluginAuth').insertOne({
      userId: uid,
      pluginKey: 'mcp_github',
      authField: 'TOKEN',
      value: 'x',
    });
    await raw('Token').insertMany(
      ['mcp:github', 'mcp:github:client', 'mcp:github:refresh', 'mcp:githubber'].map(
        (identifier) => ({
          userId: user._id,
          type: 'mcp_oauth',
          identifier,
          token: 't',
          expiresAt: new Date(Date.now() + 3_600_000),
        }),
      ),
    );

    await move({ userId: uid, from: null, to: 'x-uni', reason: 'join' });

    expect(await raw('PluginAuth').findOne({ userId: uid })).toMatchObject({
      pluginKey: 'mcp_github-moved',
      tenantId: 'x-uni',
    });
    const identifiers = await raw('Token')
      .find({ userId: user._id })
      .map((token) => token.identifier)
      .toArray();
    expect(identifiers.sort()).toEqual([
      'mcp:github-moved',
      'mcp:github-moved:client',
      'mcp:github-moved:refresh',
      'mcp:githubber',
    ]);
    expect((await raw('Agent').findOne({ id: 'agent_gh' }))?.tool_options).toEqual({
      'issues_mcp_github-moved': { defer: true },
    });
  });

  it('gives up after repeated failures: fence kept while half-moved, then lifted, seat back, alerted', async () => {
    mover = createMemberMover({
      schedule: () => undefined,
      maxAttempts: 2,
      reserveSeat: reserveMoveSeat,
      releaseSeat: releaseMoveSeat,
      syncMember: async () => undefined,
      recordAuditEntry: (input, options) =>
        createMethods(mongoose).recordAuditEntry(input, options),
    });
    await linkInstitution(ORG_X);
    const user = await makeUser();
    await seedPrivate(user._id, null);
    jest.spyOn(raw('Message'), 'updateMany').mockRejectedValue(new Error('disk full'));
    const request = { userId: String(user._id), from: null, to: 'x-uni', reason: 'join' };

    await expect(move(request)).rejects.toThrow('disk full');
    /** Half-moved: the fence stays, but only until its lease runs out. */
    const fenced = (await raw('User').findOne({ _id: user._id }))?.movingUntil as Date;
    expect(fenced.getTime()).toBeGreaterThan(Date.now());
    expect(fenced.getTime()).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
    await expect(move(request)).rejects.toThrow('disk full');

    expect(await M('MemberMove').findOne({ userId: user._id }).lean()).toMatchObject({
      status: 'failed',
    });
    expect((await raw('User').findOne({ _id: user._id }))?.movingUntil).toBeUndefined();
    expect(await seats('x-uni')).toBe(0);
    expect(await getAlertModel().findOne({ kind: 'member_move' }).lean()).toMatchObject({
      status: 'open',
      severity: 'critical',
    });
    jest.restoreAllMocks();
    expect(await move(request)).toMatchObject({ status: 'moved' });
  });

  it('refuses cleanly when another account of theirs appears in the target mid-move', async () => {
    await linkInstitution(ORG_X);
    const user = await makeUser();
    await seedPrivate(user._id, null);
    const sessions = raw('Session');
    const original = sessions.updateMany.bind(sessions);
    jest.spyOn(sessions, 'updateMany').mockImplementationOnce(async (...args) => {
      await raw('User').insertOne({ email: user.email, username: 'dup', tenantId: 'x-uni' });
      return original(...args);
    });

    const outcome = await move({
      userId: String(user._id),
      from: null,
      to: 'x-uni',
      reason: 'join',
    });

    expect(outcome).toEqual({ status: 'refused', reason: 'duplicate_account' });
    expect((await raw('User').findOne({ _id: user._id }))?.tenantId).toBeUndefined();
    expect(await countOwned(user._id, null)).toMatchObject({
      Conversation: 1,
      Message: 2,
      Agent: 1,
    });
    expect(await seats('x-uni')).toBe(0);
  });

  it('brings everything back from a half-finished join target, keeping nothing there', async () => {
    await linkInstitution(ORG_X);
    await raw('Institution').insertOne({ tenantId: 'z-uni', slug: 'z-uni', name: 'Z' });
    await makeUser({ tenantId: 'x-uni', role: 'INSTITUTION_ADMIN', membershipStatus: 'active' });
    const user = await makeUser();
    const { agentId } = await seedPrivate(user._id, null);
    await raw('AclEntry').insertOne({
      principalType: 'public',
      resourceType: 'agent',
      resourceId: agentId,
      permBits: 1,
    });
    const sessions = raw('Session');
    const original = sessions.updateMany.bind(sessions);
    jest.spyOn(sessions, 'updateMany').mockImplementationOnce(async (...args) => {
      await raw('User').updateOne({ _id: user._id }, { $set: { tenantId: 'z-uni' } });
      return original(...args);
    });

    expect(
      await move({ userId: String(user._id), from: null, to: 'x-uni', reason: 'join' }),
    ).toEqual({
      status: 'redirected',
      to: 'z-uni',
    });
    expect(await raw('Agent').findOne({ _id: agentId })).toMatchObject({
      tenantId: 'z-uni',
      author: user._id,
    });
    expect(await raw('AclEntry').countDocuments({ resourceId: agentId, tenantId: 'z-uni' })).toBe(
      2,
    );
  });

  it('releases a seat only if the member was active at the moment of the switch', async () => {
    await linkInstitution(ORG_X, { stats: { activeMembers: 2 } });
    const user = await memberOfX();
    await seedPrivate(user._id, 'x-uni');
    const sessions = raw('Session');
    const original = sessions.updateMany.bind(sessions);
    jest.spyOn(sessions, 'updateMany').mockImplementationOnce(async (...args) => {
      await raw('User').updateOne({ _id: user._id }, { $set: { membershipStatus: 'suspended' } });
      await raw('Institution').updateOne(
        { tenantId: 'x-uni' },
        { $inc: { 'stats.activeMembers': -1 } },
      );
      return original(...args);
    });

    await move({ userId: String(user._id), from: 'x-uni', to: null, reason: 'leave' });

    expect(await seats('x-uni')).toBe(1);
    expect(await M('MemberMove').findOne({ userId: user._id }).lean()).toMatchObject({
      wasActive: false,
    });
  });

  it('applies each seat change once per move and reports a counter at zero as drift', async () => {
    await linkInstitution(ORG_X, { limits: { maxActiveMembers: 2 } });
    expect(await reserveMoveSeat('x-uni', 'm1')).toBe(true);
    expect(await reserveMoveSeat('x-uni', 'm1')).toBe(true);
    expect(await seats('x-uni')).toBe(1);
    expect(await releaseMoveSeat('x-uni', 'm1')).toBe('released');
    expect(await releaseMoveSeat('x-uni', 'm1')).toBe('already');
    expect(await seats('x-uni')).toBe(0);
    expect(await releaseMoveSeat('x-uni', 'm2')).toBe('drift');
    expect(await seats('x-uni')).toBe(0);
  });

  it('records seat drift on the move and in the audit', async () => {
    await linkInstitution(ORG_X, { stats: { activeMembers: 0 } });
    const user = await memberOfX();

    await move({ userId: String(user._id), from: 'x-uni', to: null, reason: 'leave' });

    const [entry] = await audits('member.moved');
    expect(entry.metadata?.seatDrift).toBe(true);
  });
});

describe('final check fixes', () => {
  const steal = (moveFilter: Record<string, unknown>) =>
    M('MemberMove').updateOne(moveFilter, { $set: { leaseId: 'another-trigger' } });

  it('never touches a move another trigger took over, and never switches the user for it', async () => {
    await linkInstitution(ORG_X);
    const user = await makeUser();
    await seedPrivate(user._id, null);
    const theirFence = new Date(Date.now() + 120_000);
    const sessions = raw('Session');
    const original = sessions.updateMany.bind(sessions);
    jest.spyOn(sessions, 'updateMany').mockImplementationOnce(async (...args) => {
      await steal({ userId: user._id });
      const result = await original(...args);
      await raw('User').updateOne({ _id: user._id }, { $set: { movingUntil: theirFence } });
      return result;
    });

    await expect(
      move({ userId: String(user._id), from: null, to: 'x-uni', reason: 'join' }),
    ).rejects.toThrow('lease lost');

    const after = await raw('User').findOne({ _id: user._id });
    expect(after?.tenantId).toBeUndefined();
    expect(after?.movingUntil).toEqual(theirFence);
    expect(await M('MemberMove').findOne({ userId: user._id }).lean()).toMatchObject({
      status: 'running',
      leaseId: 'another-trigger',
    });
  });

  it('lifts the fence at once when a failure left nothing moved', async () => {
    await linkInstitution(ORG_X);
    const user = await makeUser();
    await seedPrivate(user._id, null);
    jest.spyOn(raw('Conversation'), 'updateMany').mockRejectedValueOnce(new Error('blip'));

    await expect(
      move({ userId: String(user._id), from: null, to: 'x-uni', reason: 'join' }),
    ).rejects.toThrow('blip');

    expect((await raw('User').findOne({ _id: user._id }))?.movingUntil).toBeUndefined();
  });

  it('renews lease and fence while one long step runs', async () => {
    mover = createMemberMover({
      schedule: () => undefined,
      leaseMs: 3_000,
      reserveSeat: reserveMoveSeat,
      releaseSeat: releaseMoveSeat,
      syncMember: async () => undefined,
      recordAuditEntry: (input, options) =>
        createMethods(mongoose).recordAuditEntry(input, options),
    });
    await linkInstitution(ORG_X);
    const user = await makeUser();
    await seedPrivate(user._id, null);
    const leases: number[] = [];
    const messages = raw('Message');
    const original = messages.updateMany.bind(messages);
    jest.spyOn(messages, 'updateMany').mockImplementationOnce(async (...args) => {
      const read = async () =>
        new Date(
          (await M('MemberMove').findOne({ userId: user._id }).lean<IMemberMove>())
            ?.leaseUntil as Date,
        ).getTime();
      leases.push(await read());
      await new Promise((resolve) => setTimeout(resolve, 1_300));
      leases.push(await read());
      return original(...args);
    });

    await move({ userId: String(user._id), from: null, to: 'x-uni', reason: 'join' });

    expect(leases[1]).toBeGreaterThan(leases[0]);
  });

  it('treats a unique-index clash at the switch as another account, and puts stripped servers back', async () => {
    await linkInstitution(ORG_X);
    const user = await makeUser();
    await seedPrivate(user._id, null);
    await raw('MCPServer').insertOne({
      serverName: 'other',
      author: new Types.ObjectId(),
      config: {},
    });
    await raw('Agent').insertOne({
      id: 'agent_other',
      author: user._id,
      mcpServerNames: ['other'],
      tools: ['a_mcp_other', 'web_search'],
      tool_options: { a_mcp_other: { defer: true } },
    });
    const usersCollection = raw('User');
    const findOne = usersCollection.findOne.bind(usersCollection);
    /** The duplicate appears after every pre-check: only the unique index can catch it. */
    jest
      .spyOn(usersCollection, 'findOne')
      .mockImplementation(((filter: Record<string, unknown>, ...rest: unknown[]) =>
        filter && '$or' in filter
          ? Promise.resolve(null)
          : findOne(filter, ...(rest as []))) as typeof usersCollection.findOne);
    const sessions = raw('Session');
    const original = sessions.updateMany.bind(sessions);
    jest.spyOn(sessions, 'updateMany').mockImplementationOnce(async (...args) => {
      await usersCollection.insertOne({ email: user.email, username: 'dup', tenantId: 'x-uni' });
      return original(...args);
    });

    const outcome = await move({
      userId: String(user._id),
      from: null,
      to: 'x-uni',
      reason: 'join',
    });

    expect(outcome).toEqual({ status: 'refused', reason: 'duplicate_account' });
    expect(await raw('Agent').findOne({ id: 'agent_other' })).toMatchObject({
      mcpServerNames: ['other'],
      tools: expect.arrayContaining(['a_mcp_other', 'web_search']),
      tool_options: { a_mcp_other: { defer: true } },
    });
    expect((await raw('Agent').findOne({ id: 'agent_other' }))?.tenantId).toBeUndefined();
  });

  it('forgets its seat operations once the move is over', async () => {
    await linkInstitution(ORG_X);
    const user = await makeUser();

    await move({ userId: String(user._id), from: null, to: 'x-uni', reason: 'join' });

    expect((await raw('Institution').findOne({ tenantId: 'x-uni' }))?.seatOps ?? []).toEqual([]);
    expect(await seats('x-uni')).toBe(1);
  });

  it('does not rename into the name of a server staying in the source', async () => {
    await linkInstitution(ORG_X);
    const user = await makeUser();
    await raw('MCPServer').insertMany([
      { serverName: 'github', author: new Types.ObjectId(), config: {}, tenantId: 'x-uni' },
      { serverName: 'github', author: user._id, config: {} },
      { serverName: 'github-moved', author: new Types.ObjectId(), config: {} },
    ]);

    await move({ userId: String(user._id), from: null, to: 'x-uni', reason: 'join' });

    expect((await raw('MCPServer').findOne({ author: user._id }))?.serverName).toBe(
      'github-moved-2',
    );
  });

  it('treats a missing institution as an error that is retried and then alerted, not as full', async () => {
    mover = createMemberMover({
      schedule: () => undefined,
      maxAttempts: 1,
      reserveSeat: reserveMoveSeat,
      releaseSeat: releaseMoveSeat,
      syncMember: async () => undefined,
      recordAuditEntry: (input, options) =>
        createMethods(mongoose).recordAuditEntry(input, options),
    });
    const user = await makeUser();

    await expect(
      move({ userId: String(user._id), from: null, to: 'ghost-uni', reason: 'join' }),
    ).rejects.toThrow('not found');

    expect(await M('MemberMove').findOne({ userId: user._id }).lean()).toMatchObject({
      status: 'failed',
    });
    expect(await getAlertModel().countDocuments({ kind: 'member_move' })).toBe(1);
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

  it('falls back to the step-by-step move, merging, when the transaction hits a clash', async () => {
    await linkInstitution(ORG_X);
    const user = await makeUser();
    await seedPrivate(user._id, null);
    await raw('Conversation').insertOne({
      conversationId: `c-${user._id}`,
      user: String(user._id),
      title: 'Older copy',
      tenantId: 'x-uni',
      updatedAt: new Date(0),
    });

    const outcome = await move({ userId: String(user._id), from: null, to: 'x-uni', reason: 'tx' });

    expect(outcome).toMatchObject({ status: 'moved', conflicts: {} });
    expect(await M('MemberMove').findOne({ userId: user._id }).lean()).toMatchObject({
      mode: 'sequential',
    });
    expect(
      await raw('Conversation')
        .find({ user: String(user._id) })
        .toArray(),
    ).toEqual([expect.objectContaining({ title: 'Mine', tenantId: 'x-uni' })]);
  });

  it('skips the transaction for a heavy move', async () => {
    mover = createMemberMover({
      schedule: () => undefined,
      transactionDocLimit: 1,
      reserveSeat,
      releaseSeat: async () => undefined,
      syncMember: async () => undefined,
      recordAuditEntry: (input, options) =>
        createMethods(mongoose).recordAuditEntry(input, options),
    });
    await linkInstitution(ORG_X);
    const user = await makeUser();
    await seedPrivate(user._id, null);

    await move({ userId: String(user._id), from: null, to: 'x-uni', reason: 'heavy' });

    expect(await M('MemberMove').findOne({ userId: user._id }).lean()).toMatchObject({
      status: 'done',
      mode: 'sequential',
    });
  });
});
