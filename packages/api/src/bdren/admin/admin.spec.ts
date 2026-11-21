import os from 'os';
import fs from 'fs';
import path from 'path';
import http from 'http';
import multer from 'multer';
import express from 'express';
import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { AccessRoleIds, ResourceType } from 'librechat-data-provider';
import {
  KbLimits,
  runAsSystem,
  createModels,
  createMethods,
  tenantStorage,
} from '@librechat/data-schemas';
import type { AllMethods } from '@librechat/data-schemas';
import type { RequestHandler } from 'express';
import type { AddressInfo } from 'net';
import { createLocalKbFileStore } from '~/kb/store';
import { recordKbStorage } from '~/kb/disk';
import { dhakaDay } from '~/usage/rollup';
import { createBdrenRouter } from './router';

const KEY = 'bdren_prod_key_test';
const ISSUER = 'https://auth.bdren.test';
const AGENT_VIEWER_ROLE = new Types.ObjectId();
const REMOTE_VIEWER_ROLE = new Types.ObjectId();

let mongoServer: MongoMemoryServer;
let methods: AllMethods;
let server: http.Server;
let base: string;
let root: string;
let productKey: string | undefined = KEY;
let ttl = 300;
let testStart = new Date();

const oneFile: RequestHandler = (req, res, next) => {
  const ticket = (req as unknown as { bdrenTicket: { sizeBytes: number } }).bdrenTicket;
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: ticket.sizeBytes + 1, files: 1 },
  }).single('file')(req, res, (error: unknown) => {
    if ((error as { code?: string } | undefined)?.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: 'too large' });
      return;
    }
    if (error) {
      res.status(400).json({ error: String(error) });
      return;
    }
    next();
  });
};

const ids = {
  adminA: '',
  memberA: '',
  adminB: '',
  suspendedA: '',
  globalAgent: '',
  agentA: '',
  agentB: '',
  specialist: '',
};

async function makeUser(tenantId: string, sub: string, extra: Record<string, unknown> = {}) {
  const user = await runAsSystem(() =>
    mongoose.models.User.create({
      name: `User ${sub}`,
      email: `${sub}@${tenantId}.test`,
      provider: 'openid',
      openidId: sub,
      openidIssuer: ISSUER,
      tenantId,
      ...extra,
    }),
  );
  return String(user._id);
}

async function call(
  method: string,
  route: string,
  opts: {
    org?: string;
    sub?: string;
    key?: string | null;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
) {
  const org = opts.org ?? 'org-a';
  const headers: Record<string, string> = { 'content-type': 'application/json', ...opts.headers };
  if (opts.key !== null) headers['x-product-key'] = opts.key ?? KEY;
  if (opts.sub !== null && !('x-acting-subject' in headers))
    headers['x-acting-subject'] = opts.sub ?? 'sub-admin-a';
  const response = await fetch(`${base}/institutions/${org}${route}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

/** Writes are audited right after the response is sent, so wait briefly for the last one. */
async function auditEntries(tenantId: string, settle = true) {
  if (settle) await new Promise((r) => setTimeout(r, 800));
  return runAsSystem(() =>
    mongoose.models.AuditLog.find({ tenantId, createdAt: { $gte: testStart } }).lean(),
  );
}

async function makeDoc(tenantId: string, title: string) {
  return tenantStorage.run({ tenantId }, () =>
    methods.createKbDocument({
      title,
      createdBy: null,
      file: {
        fileRef: `kb/x/${title}.txt`,
        filename: `${title}.txt`,
        mimeType: 'text/plain',
        sha256: title,
        sizeBytes: 10,
      },
    }),
  );
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  Object.assign(mongoose.models, createModels(mongoose));
  methods = createMethods(mongoose);
  await mongoose.connect(mongoServer.getUri());
  await mongoose.models.AuditLog.init();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bdren-admin-'));

  const app = express();
  app.use(express.json());
  app.use(
    createBdrenRouter({
      productKey: () => productKey,
      issuer: () => ISSUER,
      uploadSecret: () => (productKey ? `upload:${productKey}` : undefined),
      uploadTtlSeconds: () => ttl,
      oneFile,
      methods,
      store: createLocalKbFileStore(root),
      index: null,
      uploadBaseUrl: () => `${base}/upload`,
      recordAuditEntry: (entry) => methods.recordAuditEntry(entry as never),
      grantPermission: async ({
        principalType,
        principalId,
        tenantId,
        resourceType,
        resourceId,
        accessRoleId,
      }) =>
        runAsSystem(() =>
          mongoose.models.AclEntry.updateOne(
            { principalType, principalId, tenantId, resourceType, resourceId },
            {
              $set: {
                principalModel: 'Group',
                permBits: 1,
                roleId:
                  accessRoleId === AccessRoleIds.REMOTE_AGENT_VIEWER
                    ? REMOTE_VIEWER_ROLE
                    : AGENT_VIEWER_ROLE,
              },
            },
            { upsert: true },
          ),
        ),
      findRoleByIdentifier: async (id) => ({
        _id: id === AccessRoleIds.REMOTE_AGENT_VIEWER ? REMOTE_VIEWER_ROLE : AGENT_VIEWER_ROLE,
      }),
      deleteConfig: async () => null,
    }),
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((done) => server.close(done));
  await mongoose.disconnect();
  await mongoServer.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  productKey = KEY;
  ttl = 300;
  testStart = new Date();
  const names = [
    'Institution',
    'User',
    'Group',
    'AclEntry',
    'Agent',
    'KbDocument',
    'KbDocumentVersion',
    'KbIngestJob',
    'KbStorageDaily',
    'UsageDaily',
    'BdrenUploadTicket',
  ];
  await Promise.all(names.map((n) => runAsSystem(() => mongoose.models[n].deleteMany({}))));
  await runAsSystem(async () => {
    await mongoose.models.Institution.create([
      { tenantId: 'tenant-a', name: 'Uni A', bdrenOrganizationId: 'org-a' },
      { tenantId: 'tenant-b', name: 'Uni B', bdrenOrganizationId: 'org-b' },
    ]);
  });
  ids.adminA = await makeUser('tenant-a', 'sub-admin-a');
  ids.memberA = await makeUser('tenant-a', 'sub-member-a');
  ids.suspendedA = await makeUser('tenant-a', 'sub-suspended-a', { membershipStatus: 'suspended' });
  ids.adminB = await makeUser('tenant-b', 'sub-admin-b');
  await makeUser('tenant-b', 'sub-member-b');
  const agent = (over: Record<string, unknown>) =>
    runAsSystem(async () =>
      String(
        (
          await mongoose.models.Agent.create({
            author: new Types.ObjectId(),
            provider: 'x',
            model: 'y',
            versions: [],
            ...over,
          })
        )._id,
      ),
    );
  ids.specialist = await agent({ id: 'agent_spec', name: 'Specialist', orchestrationOnly: true });
  ids.globalAgent = await agent({
    id: 'agent_global',
    name: 'Global',
    edges: [{ from: 'agent_global', to: 'agent_spec', edgeType: 'handoff' }],
  });
  ids.agentA = await agent({ id: 'agent_a', name: 'Agent A', tenantId: 'tenant-a' });
  ids.agentB = await agent({ id: 'agent_b', name: 'Agent B', tenantId: 'tenant-b' });
  /** The superadmin enabled the platform agent (and its specialist) for tenant A only. */
  const audience = await runAsSystem(() =>
    mongoose.models.Group.create({
      name: 'All A',
      source: 'local',
      tenantId: 'tenant-a',
      managedKind: 'tenant_all_active_members',
      memberIds: [],
    }),
  );
  await runAsSystem(() =>
    mongoose.models.AclEntry.create(
      [ids.globalAgent, ids.specialist].map((resourceId) => ({
        principalType: 'group',
        principalModel: 'Group',
        principalId: audience._id,
        tenantId: 'tenant-a',
        resourceType: ResourceType.AGENT,
        resourceId,
        permBits: 1,
        roleId: AGENT_VIEWER_ROLE,
      })),
    ),
  );
});

const READ_ROUTES: [string, string][] = [
  ['GET', '/knowledge'],
  ['GET', '/knowledge/storage'],
  ['GET', '/groups'],
  ['GET', '/agents'],
  ['GET', '/members'],
  ['GET', '/usage/daily?start=2026-11-01&end=2026-11-02'],
];

describe('authentication', () => {
  it('refuses every route without a product key (401)', async () => {
    for (const [method, route] of READ_ROUTES) {
      expect((await call(method, route, { key: null })).status).toBe(401);
    }
    expect((await call('POST', '/groups', { key: null, body: { name: 'x' } })).status).toBe(401);
    expect((await call('POST', '/knowledge/upload-url', { key: null, body: {} })).status).toBe(401);
    expect((await fetch(`${base}/admin-manifest`)).status).toBe(401);
  });

  it('refuses a wrong key (401) and fails closed when no key is configured (503)', async () => {
    for (const [method, route] of READ_ROUTES) {
      expect((await call(method, route, { key: 'nope' })).status).toBe(401);
    }
    productKey = undefined;
    expect((await call('GET', '/groups')).status).toBe(503);
  });

  it('serves the manifest to the product key', async () => {
    const response = await fetch(`${base}/admin-manifest`, { headers: { 'x-product-key': KEY } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.sections.map((s: { key: string }) => s.key)).toEqual([
      'knowledge',
      'access-groups',
      'usage',
    ]);
  });

  it('404 for an organization that is not mapped, 400 for malformed ids and a missing subject', async () => {
    expect((await call('GET', '/groups', { org: 'org-unknown' })).status).toBe(404);
    expect((await call('GET', '/groups', { org: 'bad%20id' })).status).toBe(400);
    expect((await call('GET', '/groups', { sub: null as never, key: KEY })).status).toBe(400);
  });

  it('403 for a subject that is unknown, suspended, from another issuer, or in no tenant', async () => {
    expect((await call('GET', '/groups', { sub: 'sub-nobody' })).status).toBe(403);
    expect((await call('GET', '/groups', { sub: 'sub-suspended-a' })).status).toBe(403);
    expect(
      (await call('GET', '/groups', { headers: { 'x-acting-issuer': 'https://evil.test' } }))
        .status,
    ).toBe(403);
    await runAsSystem(() =>
      mongoose.models.User.updateOne(
        { openidId: 'sub-member-a' },
        { $set: { openidIssuer: 'https://other.test' } },
      ),
    );
    expect((await call('GET', '/groups', { sub: 'sub-member-a' })).status).toBe(403);
  });
});

describe('tenant isolation: a forged or mismatched organization id', () => {
  it('tenant A admin on tenant B organization reaches nothing, on every read and write route', async () => {
    const docB = (await makeDoc('tenant-b', 'b-secret')).document;
    const group = await call('POST', '/groups', {
      org: 'org-b',
      sub: 'sub-admin-b',
      body: { name: 'B group', members: ['sub-member-b'] },
    });
    expect(group.status).toBe(201);
    const groupId = group.body.group.id;

    for (const [method, route] of READ_ROUTES) {
      expect((await call(method, route, { org: 'org-b', sub: 'sub-admin-a' })).status).toBe(403);
    }
    const attempts: [string, string, unknown?][] = [
      ['POST', '/knowledge/upload-url', { filename: 'a.txt', sizeBytes: 5 }],
      ['PATCH', `/knowledge/${docB._id}`, { title: 'pwned' }],
      ['DELETE', `/knowledge/${docB._id}`],
      ['POST', `/knowledge/${docB._id}/retry`],
      ['GET', `/knowledge/${docB._id}/versions`],
      ['POST', '/groups', { name: 'evil' }],
      ['GET', `/groups/${groupId}`],
      ['PATCH', `/groups/${groupId}`, { name: 'pwned' }],
      ['DELETE', `/groups/${groupId}`],
    ];
    for (const [method, route, body] of attempts) {
      const { status } = await call(method, route, { org: 'org-b', sub: 'sub-admin-a', body });
      expect([method, route, status]).toEqual([method, route, 403]);
    }
    const after = await tenantStorage.run({ tenantId: 'tenant-b' }, () =>
      methods.getKbDocument(String(docB._id)),
    );
    expect(after?.title).toBe('b-secret');
    const groups = await call('GET', '/groups', { org: 'org-b', sub: 'sub-admin-b' });
    expect(groups.body.groups.map((g: { name: string }) => g.name)).toEqual(['B group']);
  });

  it('a subject cannot be borrowed across tenants even when it exists in both', async () => {
    await makeUser('tenant-b', 'sub-admin-a');
    const mine = await call('GET', '/groups', { org: 'org-a', sub: 'sub-admin-a' });
    expect(mine.status).toBe(200);
    const theirs = await call('GET', '/groups', { org: 'org-b', sub: 'sub-admin-a' });
    expect(theirs.status).toBe(200);
    await call('POST', '/groups', {
      org: 'org-a',
      sub: 'sub-admin-a',
      body: { name: 'only in A' },
    });
    const inB = await call('GET', '/groups', { org: 'org-b', sub: 'sub-admin-a' });
    expect(inB.body.groups).toEqual([]);
  });

  it("with the right organization, another tenant's ids are simply not found (404)", async () => {
    const docB = (await makeDoc('tenant-b', 'b-doc')).document;
    const groupB = await call('POST', '/groups', {
      org: 'org-b',
      sub: 'sub-admin-b',
      body: { name: 'B' },
    });
    const idB = groupB.body.group.id;
    for (const [method, route, body] of [
      ['PATCH', `/knowledge/${docB._id}`, { title: 'x' }],
      ['DELETE', `/knowledge/${docB._id}`],
      ['POST', `/knowledge/${docB._id}/retry`],
      ['GET', `/groups/${idB}`],
      ['PATCH', `/groups/${idB}`, { name: 'x' }],
      ['DELETE', `/groups/${idB}`],
    ] as [string, string, unknown?][]) {
      expect([method, route, (await call(method, route, { body })).status]).toEqual([
        method,
        route,
        404,
      ]);
    }
    const intact = await tenantStorage.run({ tenantId: 'tenant-b' }, () =>
      methods.getKbDocument(String(docB._id)),
    );
    expect(intact?.title).toBe('b-doc');
    expect(
      (await call('GET', '/groups', { org: 'org-b', sub: 'sub-admin-b' })).body.groups,
    ).toHaveLength(1);
  });
});

describe('knowledge base', () => {
  it("lists only the caller's documents", async () => {
    await makeDoc('tenant-a', 'a-doc');
    await makeDoc('tenant-b', 'b-doc');
    const a = await call('GET', '/knowledge');
    expect(a.body.documents.map((d: { title: string }) => d.title)).toEqual(['a-doc']);
    const b = await call('GET', '/knowledge', { org: 'org-b', sub: 'sub-admin-b' });
    expect(b.body.documents.map((d: { title: string }) => d.title)).toEqual(['b-doc']);
  });

  it("reports only the caller's disk use, now and per day, and adds versions to usage", async () => {
    await makeDoc('tenant-a', 'a-doc');
    await makeDoc('tenant-a', 'a-doc-2');
    await makeDoc('tenant-b', 'b-doc');
    await recordKbStorage(methods, 'tenant-a');
    await recordKbStorage(methods, 'tenant-b');

    const a = await call('GET', '/knowledge/storage?days=30');
    expect(a.status).toBe(200);
    expect(a.body).toEqual({
      current: {
        documents: 2,
        versions: 2,
        originalBytes: 20,
        parsedBytes: 0,
        indexChunks: 0,
        totalBytes: 20,
        limitBytes: KbLimits.maxTotalBytes,
        measuredAt: expect.any(String),
      },
      daily: [
        {
          day: dhakaDay(new Date()),
          documents: 2,
          versions: 2,
          originalBytes: 20,
          parsedBytes: 0,
          totalBytes: 20,
        },
      ],
    });
    const b = await call('GET', '/knowledge/storage', { org: 'org-b', sub: 'sub-admin-b' });
    expect(b.body.current).toMatchObject({ documents: 1, totalBytes: 10 });
    expect(b.body.daily).toEqual([expect.objectContaining({ totalBytes: 10 })]);

    const crossed = await call('GET', '/knowledge/storage', { org: 'org-b', sub: 'sub-admin-a' });
    expect(crossed.status).toBe(403);
    for (const days of ['0', '366', 'x', '1.5']) {
      expect((await call('GET', `/knowledge/storage?days=${days}`)).status).toBe(400);
    }

    const listed = await call('GET', '/knowledge');
    expect(listed.body.usage).toEqual({ documents: 2, bytes: 20, versions: 2, totalBytes: 20 });
  });

  const issue = (extra: Record<string, unknown> = {}, who: { org?: string; sub?: string } = {}) =>
    call('POST', '/knowledge/upload-url', {
      ...who,
      body: { filename: 'contacts.txt', sizeBytes: 12, title: 'Contacts', ...extra },
    });

  const send = (url: string, content: string, name = 'contacts.txt') => {
    const form = new FormData();
    form.append('file', new Blob([content]), name);
    return fetch(url, { method: 'POST', body: form });
  };

  it('issues a signed URL and accepts exactly one upload into the issuing tenant', async () => {
    const ticket = await issue();
    expect(ticket.status).toBe(201);
    expect(ticket.body).toMatchObject({ method: 'POST', fieldName: 'file', maxBytes: 12 });
    const first = await send(ticket.body.uploadUrl, 'hello world!');
    expect(first.status).toBe(201);
    const second = await send(ticket.body.uploadUrl, 'hello world!');
    expect(second.status).toBe(410);

    const a = await call('GET', '/knowledge');
    expect(a.body.documents).toHaveLength(1);
    expect(a.body.documents[0]).toMatchObject({ title: 'Contacts', filename: 'contacts.txt' });
    const b = await call('GET', '/knowledge', { org: 'org-b', sub: 'sub-admin-b' });
    expect(b.body.documents).toEqual([]);
    const created = await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
      methods.listKbDocuments(),
    );
    expect(String(created[0].createdBy)).toBe(ids.adminA);
  });

  it('rejects an expired link (410)', async () => {
    ttl = 1;
    const ticket = await issue();
    await new Promise((r) => setTimeout(r, 2100));
    expect((await send(ticket.body.uploadUrl, 'hello world!')).status).toBe(410);
  });

  it('rejects forged, tampered and swapped links (403) and spends nothing', async () => {
    const t1 = await issue();
    const t2 = await issue({}, { org: 'org-b', sub: 'sub-admin-b' });
    const url = new URL(t1.body.uploadUrl);
    const other = new URL(t2.body.uploadUrl);
    const forged = new URL(url);
    forged.searchParams.set('sig', 'a'.repeat(64));
    expect((await send(forged.toString(), 'hello world!')).status).toBe(403);
    const tampered = new URL(url);
    tampered.searchParams.set('exp', String(Number(url.searchParams.get('exp')) + 600));
    expect((await send(tampered.toString(), 'hello world!')).status).toBe(403);
    const swapped = new URL(other);
    swapped.searchParams.set('sig', url.searchParams.get('sig')!);
    expect((await send(swapped.toString(), 'hello world!')).status).toBe(403);
    const noSig = new URL(url);
    noSig.search = '';
    expect((await send(noSig.toString(), 'hello world!')).status).toBe(403);
    expect((await send(`${base}/upload/not-a-ticket?exp=1&sig=ab`, 'x')).status).toBe(403);
    expect((await send(t1.body.uploadUrl, 'hello world!')).status).toBe(201);
  });

  it('a ticket from one tenant cannot write into another, and cannot target their document', async () => {
    const docB = (await makeDoc('tenant-b', 'b-doc')).document;
    expect((await issue({ documentId: String(docB._id) })).status).toBe(404);
    const t = await issue({}, { org: 'org-b', sub: 'sub-admin-b' });
    expect((await send(t.body.uploadUrl, 'hello world!')).status).toBe(201);
    expect((await call('GET', '/knowledge')).body.documents).toEqual([]);
    expect(
      (await call('GET', '/knowledge', { org: 'org-b', sub: 'sub-admin-b' })).body.documents,
    ).toHaveLength(2);
  });

  it('enforces the size and type fixed at issue time', async () => {
    expect((await issue({ filename: 'run.exe' })).status).toBe(400);
    expect((await issue({ sizeBytes: 0 })).status).toBe(400);
    expect((await issue({ sizeBytes: 10 * 1024 * 1024 * 1024 })).status).toBe(400);
    const big = await issue();
    expect((await send(big.body.uploadUrl, 'x'.repeat(5000))).status).toBe(413);
    const wrongType = await issue();
    expect((await send(wrongType.body.uploadUrl, 'hello world!', 'contacts.pdf')).status).toBe(400);
    expect((await call('GET', '/knowledge')).body.documents).toEqual([]);
  });

  it('refuses the upload when the acting admin has left the tenant meanwhile', async () => {
    const t = await issue();
    await runAsSystem(() =>
      mongoose.models.User.updateOne(
        { openidId: 'sub-admin-a' },
        { $set: { membershipStatus: 'suspended' } },
      ),
    );
    expect((await send(t.body.uploadUrl, 'hello world!')).status).toBe(403);
  });

  it('renames, retries and deletes inside the tenant, and audits each write', async () => {
    const doc = (await makeDoc('tenant-a', 'old')).document;
    expect((await call('PATCH', `/knowledge/${doc._id}`, { body: { title: 'new' } })).status).toBe(
      200,
    );
    expect((await call('DELETE', `/knowledge/${doc._id}`)).status).toBe(204);
    const t = await issue();
    await send(t.body.uploadUrl, 'hello world!');
    const actions = (await auditEntries('tenant-a')).map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'institution.kb_document_renamed',
        'institution.kb_document_deleted',
        'institution.kb_upload_url_issued',
        'institution.kb_document_uploaded',
      ]),
    );
    expect(await auditEntries('tenant-b')).toEqual([]);
    const entry = (await auditEntries('tenant-a')).find(
      (e) => e.action === 'institution.kb_document_renamed',
    );
    expect(entry?.actor).toMatchObject({ type: 'api', id: ids.adminA });
    expect(entry?.actor.name).toContain('sub-admin-a');
  });
});

describe('access groups and agents', () => {
  it("lists grantable agents of the tenant and the platform, never another tenant's or specialists", async () => {
    const a = await call('GET', '/agents');
    expect(a.body.agents.map((x: { id: string }) => x.id).sort()).toEqual([
      'agent_a',
      'agent_global',
    ]);
    const b = await call('GET', '/agents', { org: 'org-b', sub: 'sub-admin-b' });
    expect(b.body.agents.map((x: { id: string }) => x.id)).toEqual(['agent_b']);
  });

  it('does not let an admin hand out a platform agent the superadmin has not enabled for the tenant', async () => {
    const res = await call('POST', '/groups', {
      org: 'org-b',
      sub: 'sub-admin-b',
      body: { name: 'x', agents: ['agent_global'] },
    });
    expect(res.status).toBe(400);
    expect(
      await runAsSystem(() => mongoose.models.AclEntry.countDocuments({ tenantId: 'tenant-b' })),
    ).toBe(0);
    const failed = (await auditEntries('tenant-b')).filter((e) => e.outcome === 'failure');
    expect(failed.map((e) => e.action)).toContain('institution.access_group_created');
  });

  it('creates, updates and deletes a group with members and agents, and audits it', async () => {
    const created = await call('POST', '/groups', {
      body: {
        name: 'Faculty',
        description: 'd',
        members: ['sub-member-a'],
        agents: ['agent_global', 'agent_a'],
      },
    });
    expect(created.status).toBe(201);
    const id = created.body.group.id;
    expect(created.body.group.members.map((m: { subject: string }) => m.subject)).toEqual([
      'sub-member-a',
    ]);
    expect(created.body.group.agents.map((x: { id: string }) => x.id).sort()).toEqual([
      'agent_a',
      'agent_global',
    ]);
    const specialistAcl = await runAsSystem(() =>
      mongoose.models.AclEntry.countDocuments({
        principalId: new Types.ObjectId(id),
        resourceType: ResourceType.REMOTE_AGENT,
      }),
    );
    expect(specialistAcl).toBe(1);

    const updated = await call('PATCH', `/groups/${id}`, {
      body: { name: 'Faculty 2', members: ['sub-admin-a'], agents: ['agent_a'] },
    });
    expect(updated.body.group).toMatchObject({ name: 'Faculty 2' });
    expect(updated.body.group.agents.map((x: { id: string }) => x.id)).toEqual(['agent_a']);
    expect(updated.body.group.members.map((m: { subject: string }) => m.subject)).toEqual([
      'sub-admin-a',
    ]);
    expect(
      await runAsSystem(() =>
        mongoose.models.AclEntry.countDocuments({ principalId: new Types.ObjectId(id) }),
      ),
    ).toBe(1);

    expect((await call('DELETE', `/groups/${id}`)).status).toBe(204);
    expect(
      await runAsSystem(() =>
        mongoose.models.AclEntry.countDocuments({ principalId: new Types.ObjectId(id) }),
      ),
    ).toBe(0);
    expect((await call('GET', '/groups')).body.groups).toEqual([]);

    const actions = (await auditEntries('tenant-a')).map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'institution.access_group_created',
        'institution.access_group_updated',
        'institution.access_group_deleted',
      ]),
    );
    expect(await auditEntries('tenant-b')).toEqual([]);
  });

  it("refuses another tenant's members and agents, and ids that are not real", async () => {
    const memberB = await call('POST', '/groups', {
      body: { name: 'x', members: ['sub-member-b'] },
    });
    expect(memberB.status).toBe(400);
    const agentB = await call('POST', '/groups', { body: { name: 'x', agents: ['agent_b'] } });
    expect(agentB.status).toBe(400);
    const specialist = await call('POST', '/groups', {
      body: { name: 'x', agents: ['agent_spec'] },
    });
    expect(specialist.status).toBe(400);
    const suspended = await call('POST', '/groups', {
      body: { name: 'x', members: ['sub-suspended-a'] },
    });
    expect(suspended.status).toBe(400);
    expect((await call('GET', '/groups/not-an-id')).status).toBe(404);
    expect((await call('POST', '/groups', { body: { name: '' } })).status).toBe(400);
    expect((await call('GET', '/groups')).body.groups).toEqual([]);
    expect(
      await runAsSystem(() =>
        mongoose.models.AclEntry.countDocuments({
          resourceType: ResourceType.AGENT,
          tenantId: 'tenant-a',
          principalId: { $ne: undefined },
          roleId: AGENT_VIEWER_ROLE,
        }),
      ),
    ).toBe(2);
  });

  it('never exposes or edits system-managed groups', async () => {
    const managed = await runAsSystem(() =>
      mongoose.models.Group.findOne({
        tenantId: 'tenant-a',
        managedKind: 'tenant_all_active_members',
      }).lean(),
    );
    if (!managed) throw new Error('audience missing');
    expect((await call('GET', '/groups')).body.groups).toEqual([]);
    expect((await call('PATCH', `/groups/${managed._id}`, { body: { name: 'x' } })).status).toBe(
      404,
    );
    expect((await call('DELETE', `/groups/${managed._id}`)).status).toBe(404);
  });

  it("lists members of the caller's tenant only", async () => {
    const a = await call('GET', '/members');
    expect(a.body.members.map((m: { subject: string }) => m.subject).sort()).toEqual([
      'sub-admin-a',
      'sub-member-a',
    ]);
  });
});

describe('usage', () => {
  it("returns only the caller's tenant, per member per day, and validates the range", async () => {
    const row = (tenantId: string, user: string, day: string) => ({
      key: `${tenantId}|${user}|${day}`,
      tenantId,
      user,
      day,
      service: 'openrouter',
      taskType: 'chat',
      billable: true,
      requests: 2,
      units: 10,
      costUsd: 0.001,
      rows: 2,
    });
    await runAsSystem(() =>
      mongoose.models.UsageDaily.create([
        row('tenant-a', ids.memberA, '2026-11-01'),
        row('tenant-a', ids.adminA, '2026-11-02'),
        row('tenant-b', ids.adminB, '2026-11-01'),
      ]),
    );
    const a = await call('GET', '/usage/daily?start=2026-11-01&end=2026-11-30');
    expect(a.status).toBe(200);
    expect(a.body.rows).toHaveLength(2);
    expect(a.body.rows.map((r: { member: { subject: string } }) => r.member.subject)).toEqual([
      'sub-member-a',
      'sub-admin-a',
    ]);
    expect(a.body.rows[0]).toMatchObject({
      requests: 2,
      units: 10,
      credits: 1000,
      taskType: 'chat',
    });
    const b = await call('GET', '/usage/daily?start=2026-11-01&end=2026-11-30', {
      org: 'org-b',
      sub: 'sub-admin-b',
    });
    expect(b.body.rows).toHaveLength(1);
    expect(b.body.rows[0].member.subject).toBe('sub-admin-b');
    expect((await call('GET', '/usage/daily?start=2026-11-01')).status).toBe(400);
    expect((await call('GET', '/usage/daily?start=2026-01-01&end=2026-12-31')).status).toBe(400);
  });
});
