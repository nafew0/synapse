import http from 'http';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels, createMethods, runAsSystem } from '@librechat/data-schemas';
import type { IUser } from '@librechat/data-schemas';
import type { AddressInfo } from 'net';
import type { MigrationOptions, MigrationReport } from './migrate';
import {
  isProductionDbName,
  migrateUsersToZitadel,
  profileNames,
  unlinkMigratedUser,
} from './migrate';
import { createZitadelClient } from './zitadel';
import { findOpenIDUser } from '~/auth/openid';

const TOKEN = 'zitadel-test-token-never-logged';
const ISSUER = 'https://auth.bdren.test';
const DEFAULT_ORG = 'org-individuals';
const DU_ORG = 'org-du';
const BUET_ORG = 'org-buet';
/** bcrypt of `Old-Password-1`, the shape Synapse stores. */
const PASSWORD_HASH = '$2a$04$MkIwtrI6Qghb7K2XvbxP.uPx6jAWpgfNhgh5RklNy7cTsSOajjIVy';

interface StubUser {
  userId: string;
  username: string;
  organizationId: string;
  email: string;
  isVerified: boolean;
  body?: Record<string, unknown>;
}

type StubRequest = { method: string; path: string; auth?: string; body?: Record<string, unknown> };

/** A stand-in for the ZITADEL v2 user API: the only external service here. */
function startZitadel() {
  const users = new Map<string, StubUser>();
  const requests: StubRequest[] = [];
  const state = { failing: false };
  const asApi = (user: StubUser) => ({
    userId: user.userId,
    username: user.username,
    details: { resourceOwner: user.organizationId },
    human: { email: { email: user.email, isVerified: user.isVerified } },
  });
  const send = (res: http.ServerResponse, status: number, body: object) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      const path = req.url ?? '';
      requests.push({ method: req.method ?? '', path, auth: req.headers.authorization, body });
      if (state.failing) {
        return send(res, 503, { message: 'unavailable' });
      }
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        return send(res, 401, { message: 'Errors.Token.Invalid' });
      }
      const single = path.match(/^\/v2\/users\/([^/]+)$/);
      if (req.method === 'GET' && single) {
        const user = users.get(decodeURIComponent(single[1]));
        return user
          ? send(res, 200, { user: asApi(user) })
          : send(res, 404, { message: 'not found' });
      }
      if (req.method === 'POST' && path === '/v2/users') {
        const query = body.queries[0];
        const wanted = String(
          query.emailQuery?.emailAddress ?? query.userNameQuery?.userName ?? '',
        ).toLowerCase();
        const field = query.emailQuery ? 'email' : 'username';
        const result = [...users.values()].filter((user) => user[field].toLowerCase() === wanted);
        return send(res, 200, { result: result.map(asApi) });
      }
      if (req.method === 'POST' && path === '/v2/users/human') {
        const taken = [...users.values()].some(
          (user) => user.userId === body.userId || user.username === body.username,
        );
        if (taken) {
          return send(res, 409, { message: 'User already exists (V3-DKcYh)' });
        }
        users.set(body.userId, {
          userId: body.userId,
          username: body.username,
          organizationId: body.organization.orgId,
          email: body.email.email,
          isVerified: body.email.isVerified === true,
          body,
        });
        return send(res, 201, { userId: body.userId });
      }
      send(res, 404, { message: 'no route' });
    });
  });

  return new Promise<{
    url: string;
    users: typeof users;
    requests: typeof requests;
    state: typeof state;
    close: () => Promise<void>;
  }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        users,
        requests,
        state,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

let mongo: MongoMemoryServer;
let zitadel: Awaited<ReturnType<typeof startZitadel>>;
const User = () => mongoose.models.User;
const db = () => mongoose.connection.db as NonNullable<typeof mongoose.connection.db>;
const client = () => createZitadelClient({ baseUrl: zitadel.url, token: TOKEN });
const creates = () => zitadel.requests.filter((r) => r.path === '/v2/users/human');

const options = (over: Partial<MigrationOptions> = {}): MigrationOptions => ({
  apply: true,
  issuer: `${ISSUER}/`,
  defaultOrganizationId: DEFAULT_ORG,
  organizationMap: { 'dhaka-university': DU_ORG, 'bdren-org-buet': BUET_ORG },
  ...over,
});

let seq = 0;
async function makeUser(over: Record<string, unknown> = {}) {
  seq += 1;
  const doc = await runAsSystem(() =>
    User().create({
      provider: 'local',
      email: `member${seq}@example.test`,
      username: `member${seq}`,
      name: `Member Number${seq}`,
      password: PASSWORD_HASH,
      emailVerified: true,
      tenantId: 'dhaka-university',
      accountScope: 'institution',
      ...over,
    }),
  );
  return doc.toObject() as IUser & { _id: mongoose.Types.ObjectId };
}

/** The stored document as it is, including fields the schema hides such as the password hash. */
const load = (id: mongoose.Types.ObjectId) =>
  User().collection.findOne<IUser & Record<string, unknown>>({ _id: id });

function entryFor(report: MigrationReport, id: mongoose.Types.ObjectId) {
  return report.users.find((entry) => entry.id === id.toHexString());
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  createModels(mongoose);
  await Promise.all(['User', 'Institution'].map((name) => mongoose.models[name].init()));
  zitadel = await startZitadel();
});

afterAll(async () => {
  await zitadel.close();
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  zitadel.users.clear();
  zitadel.requests.length = 0;
  zitadel.state.failing = false;
  await Promise.all(
    ['User', 'Institution'].map((name) => mongoose.models[name].collection.deleteMany({})),
  );
  await mongoose.models.Institution.collection.insertMany([
    { tenantId: 'dhaka-university', name: 'DU', slug: 'du', status: 'active' },
    {
      tenantId: 'buet',
      name: 'BUET',
      slug: 'buet',
      status: 'active',
      bdrenOrganizationId: 'bdren-org-buet',
    },
    { tenantId: 'closed-uni', name: 'Closed', slug: 'closed-uni', status: 'closed' },
  ]);
});

describe('isProductionDbName', () => {
  it('flags any name containing prod, in any case', () => {
    expect(['SynapseProd', 'prod', 'librechat-PRODUCTION'].map(isProductionDbName)).toEqual([
      true,
      true,
      true,
    ]);
    expect(isProductionDbName('SynapseRunTest')).toBe(false);
  });
});

describe('profileNames', () => {
  it('fills the family name ZITADEL requires and keeps the display name as Synapse had it', () => {
    expect(profileNames({ name: 'Rahim', email: 'r@x.test' })).toEqual({
      displayName: 'Rahim',
      givenName: 'Rahim',
      familyName: 'Rahim',
    });
    expect(profileNames({ name: ' Abdul  Karim Khan ', email: 'a@x.test' })).toEqual({
      displayName: 'Abdul  Karim Khan',
      givenName: 'Abdul',
      familyName: 'Karim Khan',
    });
    expect(profileNames({ name: '', username: '', email: 'only.mail@x.test' }).displayName).toBe(
      'only.mail',
    );
  });
});

describe('dry run', () => {
  it('writes nothing anywhere and reports a plan without emails, names or hashes', async () => {
    const member = await makeUser();
    const standalone = await makeUser({ tenantId: undefined, accountScope: 'standalone' });
    const before = await load(member._id);

    const report = await migrateUsersToZitadel(
      { db: db(), zitadel: client() },
      options({ apply: false }),
    );

    expect(report.mode).toBe('dry-run');
    expect(report.counts).toEqual({ would_create: 2 });
    expect(creates()).toHaveLength(0);
    expect(await load(member._id)).toEqual(before);
    expect(entryFor(report, standalone._id)?.organizationId).toBe(DEFAULT_ORG);
    const text = JSON.stringify(report);
    expect(text).not.toMatch(/example\.test|Member Number|\$2[aby]\$/);
    expect(text).not.toContain(TOKEN);
  });

  it('plans without ZITADEL when no client is given', async () => {
    await makeUser();
    const report = await migrateUsersToZitadel({ db: db() }, options({ apply: false }));
    expect(report).toMatchObject({ zitadelChecked: false, counts: { would_create: 1 } });
    expect(zitadel.requests).toHaveLength(0);
  });

  it('refuses to apply without a client', async () => {
    await expect(migrateUsersToZitadel({ db: db() }, options())).rejects.toThrow(/ZITADEL client/);
  });
});

describe('apply', () => {
  it('creates the ZITADEL user with the same hash and links the Synapse account in place', async () => {
    const member = await makeUser();
    const before = await load(member._id);

    const report = await migrateUsersToZitadel({ db: db(), zitadel: client() }, options());

    const id = member._id.toHexString();
    expect(report.counts).toEqual({ created: 1 });
    const created = zitadel.users.get(id);
    expect(created).toMatchObject({
      organizationId: DU_ORG,
      username: member.email,
      isVerified: true,
    });
    expect(created?.body).toMatchObject({
      hashedPassword: { hash: PASSWORD_HASH, changeRequired: false },
      profile: { givenName: 'Member', familyName: `Number${seq}`, displayName: member.name },
    });
    expect(zitadel.requests.every((r) => r.auth === `Bearer ${TOKEN}`)).toBe(true);

    const after = await load(member._id);
    expect(after).toMatchObject({
      provider: 'openid',
      openidId: id,
      openidIssuer: ISSUER,
      bdrenHoldTenantId: 'dhaka-university',
      tenantId: 'dhaka-university',
      password: PASSWORD_HASH,
    });
    expect(after?.ssoMigratedAt).toBeInstanceOf(Date);
    const changed = ['provider', 'openidId', 'openidIssuer', 'ssoMigratedAt', 'bdrenHoldTenantId'];
    const strip = (doc: Record<string, unknown> | null) =>
      Object.fromEntries(Object.entries(doc ?? {}).filter(([key]) => !changed.includes(key)));
    expect(strip(after)).toEqual(strip(before));
  });

  it('is found by the OpenID login lookup as the same account', async () => {
    const member = await makeUser();
    await migrateUsersToZitadel({ db: db(), zitadel: client() }, options());

    const { findUser } = createMethods(mongoose);
    const result = await runAsSystem(() =>
      findOpenIDUser({
        findUser,
        openidId: member._id.toHexString(),
        openidIssuer: ISSUER,
        email: member.email,
      }),
    );

    expect(result.error).toBeNull();
    expect(String(result.user?._id)).toBe(member._id.toHexString());
    expect(result.user?.tenantId).toBe('dhaka-university');
  });

  it('maps organizations by tenant, by bdren.ai organization, and reports unmapped tenants', async () => {
    const du = await makeUser();
    const buet = await makeUser({ tenantId: 'buet' });
    const closed = await makeUser({ tenantId: 'closed-uni' });
    const alone = await makeUser({ tenantId: undefined, accountScope: 'standalone' });

    const report = await migrateUsersToZitadel({ db: db(), zitadel: client() }, options());

    const orgOf = (id: mongoose.Types.ObjectId) =>
      zitadel.users.get(id.toHexString())?.organizationId;
    expect([du, buet, closed, alone].map((u) => orgOf(u._id))).toEqual([
      DU_ORG,
      BUET_ORG,
      DEFAULT_ORG,
      DEFAULT_ORG,
    ]);
    expect(report.flags.unmappedTenant).toBe(1);
    expect(report.tenants['closed-uni']).toEqual({
      users: 1,
      organizationId: DEFAULT_ORG,
      mapped: false,
      institution: 'closed',
      linkedToBdren: false,
    });
    expect(report.tenants.buet).toMatchObject({ mapped: true, linkedToBdren: true });
    expect((await load(alone._id))?.bdrenHoldTenantId).toBeUndefined();
  });

  it('leaves unmapped tenants alone when asked to skip them', async () => {
    const closed = await makeUser({ tenantId: 'closed-uni' });
    const report = await migrateUsersToZitadel(
      { db: db(), zitadel: client() },
      options({ unmapped: 'skip' }),
    );
    expect(entryFor(report, closed._id)?.status).toBe('unmapped_tenant');
    expect((await load(closed._id))?.provider).toBe('local');
  });

  it('skips admins, other providers and duplicate emails, and flags no-password and unverified users', async () => {
    const admin = await makeUser({ role: 'ADMIN' });
    const google = await makeUser({ provider: 'google', password: undefined });
    const first = await makeUser({ email: 'twin@example.test' });
    const second = await makeUser({ email: 'twin@example.test', tenantId: 'buet' });
    const invited = await makeUser({ password: undefined, emailVerified: false });

    const report = await migrateUsersToZitadel({ db: db(), zitadel: client() }, options());

    expect(entryFor(report, admin._id)?.status).toBe('platform_staff');
    expect(entryFor(report, google._id)).toMatchObject({
      status: 'other_provider',
      reason: 'google',
    });
    expect(entryFor(report, first._id)).toMatchObject({
      status: 'conflict',
      reason: 'duplicate_email',
    });
    expect(entryFor(report, second._id)).toMatchObject({
      status: 'conflict',
      reason: 'duplicate_email',
    });
    expect(entryFor(report, invited._id)).toMatchObject({
      status: 'created',
      noPassword: true,
      emailUnverified: true,
    });
    const body = zitadel.users.get(invited._id.toHexString())?.body;
    expect(body?.hashedPassword).toBeUndefined();
    expect(body?.email).toEqual({ email: invited.email, returnCode: {} });
    expect(report.conflicts).toEqual({ duplicate_email: 2 });
    expect((await load(admin._id))?.provider).toBe('local');
    expect((await load(first._id))?.provider).toBe('local');
  });

  it('treats an active PlatformAdmin row as staff, by id or by email', async () => {
    const byId = await makeUser();
    await makeUser({ email: 'staff@example.test', tenantId: undefined, accountScope: undefined });
    await mongoose.connection.collection('platformadmins').insertMany([
      { userId: byId._id, email: 'other-staff@example.test', active: true },
      { email: 'STAFF@example.test', active: true },
    ]);

    const report = await migrateUsersToZitadel({ db: db(), zitadel: client() }, options());

    expect(report.counts).toEqual({ platform_staff: 2 });
    await mongoose.connection.collection('platformadmins').deleteMany({});
  });

  it('migrates an institution account whose email is on the superadmin list', async () => {
    const institutionAdmin = await makeUser({
      email: 'boss@example.test',
      role: 'INSTITUTION_ADMIN',
    });
    await mongoose.connection
      .collection('platformadmins')
      .insertOne({ email: 'boss@example.test', active: true });

    const report = await migrateUsersToZitadel(
      { db: db(), zitadel: client() },
      options({ staffEmails: ['boss@example.test'] }),
    );

    expect(entryFor(report, institutionAdmin._id)?.status).toBe('created');
    expect((await load(institutionAdmin._id))?.provider).toBe('openid');
    await mongoose.connection.collection('platformadmins').deleteMany({});
  });

  it('treats superadmins named only in configuration as staff', async () => {
    const configured = await makeUser({
      email: 'boss@example.test',
      tenantId: undefined,
      accountScope: undefined,
    });
    const member = await makeUser();

    const report = await migrateUsersToZitadel(
      { db: db(), zitadel: client() },
      options({ staffEmails: [' BOSS@example.test ', ''] }),
    );

    expect(entryFor(report, configured._id)?.status).toBe('platform_staff');
    expect(entryFor(report, member._id)?.status).toBe('created');
    expect((await load(configured._id))?.provider).toBe('local');
  });

  it('includes admins only when asked', async () => {
    const admin = await makeUser({ role: 'ADMIN' });
    const report = await migrateUsersToZitadel(
      { db: db(), zitadel: client() },
      options({ includeAdmins: true }),
    );
    expect(entryFor(report, admin._id)?.status).toBe('created');
  });

  it('imports the TOTP secret of a 2FA user when it can be read', async () => {
    const twoFactor = await makeUser({ twoFactorEnabled: true, totpSecret: 'v3:encrypted' });
    const unreadable = await makeUser({ twoFactorEnabled: true, totpSecret: 'broken' });
    const readTotpSecret = jest.fn(async (stored: string) =>
      stored === 'v3:encrypted' ? 'JBSWY3DPEHPK3PXP' : null,
    );

    const report = await migrateUsersToZitadel(
      { db: db(), zitadel: client(), readTotpSecret },
      options(),
    );

    expect(zitadel.users.get(twoFactor._id.toHexString())?.body?.totpSecret).toBe(
      'JBSWY3DPEHPK3PXP',
    );
    expect(entryFor(report, twoFactor._id)).toMatchObject({ twoFactor: true, totpImported: true });
    expect(entryFor(report, unreadable._id)).toMatchObject({ status: 'created', twoFactor: true });
    expect(entryFor(report, unreadable._id)?.totpImported).toBeUndefined();
    expect(report.flags).toMatchObject({ twoFactor: 2, totpImported: 1 });
    expect(JSON.stringify(report)).not.toContain('JBSWY3DPEHPK3PXP');
  });
});

describe('reruns and existing ZITADEL users', () => {
  it('skips users already linked, so a second run creates nothing', async () => {
    await makeUser();
    await makeUser({ tenantId: 'buet' });
    await migrateUsersToZitadel({ db: db(), zitadel: client() }, options({ batchSize: 1 }));
    zitadel.requests.length = 0;

    const again = await migrateUsersToZitadel({ db: db(), zitadel: client() }, options());

    expect(again.counts).toEqual({ already_linked: 2 });
    expect(zitadel.requests).toHaveLength(0);
  });

  it('resumes a user whose ZITADEL account an interrupted run already created', async () => {
    const member = await makeUser();
    const id = member._id.toHexString();
    zitadel.users.set(id, {
      userId: id,
      username: member.email,
      organizationId: DU_ORG,
      email: member.email,
      isVerified: true,
    });

    const report = await migrateUsersToZitadel({ db: db(), zitadel: client() }, options());

    expect(entryFor(report, member._id)).toMatchObject({ status: 'resumed', zitadelUserId: id });
    expect(creates()).toHaveLength(0);
    expect((await load(member._id))?.openidId).toBe(id);
  });

  it('links a ZITADEL user with the same verified email in the same organization', async () => {
    const member = await makeUser();
    zitadel.users.set('zitadel-123', {
      userId: 'zitadel-123',
      username: 'someone',
      organizationId: DU_ORG,
      email: member.email.toUpperCase(),
      isVerified: true,
    });

    const report = await migrateUsersToZitadel({ db: db(), zitadel: client() }, options());

    expect(entryFor(report, member._id)).toMatchObject({
      status: 'linked_existing',
      zitadelUserId: 'zitadel-123',
    });
    expect((await load(member._id))?.openidId).toBe('zitadel-123');
  });

  it.each([
    ['email_unverified_in_zitadel', { isVerified: false, organizationId: DU_ORG }],
    ['email_in_other_organization', { isVerified: true, organizationId: DEFAULT_ORG }],
  ])('reports %s and links nothing', async (reason, over) => {
    const member = await makeUser();
    zitadel.users.set('zitadel-9', {
      userId: 'zitadel-9',
      username: 'x',
      email: member.email,
      ...over,
    });

    const report = await migrateUsersToZitadel({ db: db(), zitadel: client() }, options());

    expect(entryFor(report, member._id)).toMatchObject({ status: 'conflict', reason });
    expect((await load(member._id))?.provider).toBe('local');
  });

  it('reports a username held by someone with another email', async () => {
    const member = await makeUser();
    zitadel.users.set('zitadel-7', {
      userId: 'zitadel-7',
      username: member.email,
      organizationId: DU_ORG,
      email: 'other@example.test',
      isVerified: true,
    });

    const report = await migrateUsersToZitadel({ db: db(), zitadel: client() }, options());

    expect(entryFor(report, member._id)).toMatchObject({
      status: 'conflict',
      reason: 'username_taken',
    });
    expect((await load(member._id))?.provider).toBe('local');
  });

  it('does not link when another Synapse account already holds that identity', async () => {
    const member = await makeUser();
    zitadel.users.set('zitadel-5', {
      userId: 'zitadel-5',
      username: member.email,
      organizationId: DU_ORG,
      email: member.email,
      isVerified: true,
    });
    await makeUser({
      provider: 'openid',
      openidId: 'zitadel-5',
      openidIssuer: ISSUER,
      email: 'sso-twin@example.test',
    });

    const report = await migrateUsersToZitadel({ db: db(), zitadel: client() }, options());

    expect(entryFor(report, member._id)).toMatchObject({
      status: 'conflict',
      reason: 'synapse_account_exists',
    });
  });

  it('records an error without touching the user when ZITADEL fails, and never echoes the token', async () => {
    const member = await makeUser();
    zitadel.state.failing = true;

    const report = await migrateUsersToZitadel({ db: db(), zitadel: client() }, options());

    expect(entryFor(report, member._id)).toMatchObject({ status: 'error' });
    expect(entryFor(report, member._id)?.reason).toMatch(/HTTP 503/);
    expect(JSON.stringify(report)).not.toContain(TOKEN);
    expect((await load(member._id))?.provider).toBe('local');
  });

  it('reports progress after each batch', async () => {
    await Promise.all([makeUser(), makeUser(), makeUser()]);
    const seen: number[] = [];
    await migrateUsersToZitadel(
      { db: db(), zitadel: client() },
      options({ batchSize: 2, onBatch: (report) => void seen.push(report.scanned) }),
    );
    expect(seen).toEqual([2, 3]);
  });
});

describe('unlinkMigratedUser', () => {
  it('turns a migrated account back into a local one that still has its password', async () => {
    const member = await makeUser();
    await migrateUsersToZitadel({ db: db(), zitadel: client() }, options());

    expect(await unlinkMigratedUser(db(), member._id.toHexString())).toBe('unlinked');
    const after = await load(member._id);
    expect(after).toMatchObject({ provider: 'local', password: PASSWORD_HASH });
    expect(after?.openidId).toBeUndefined();
    expect(after?.ssoMigratedAt).toBeUndefined();
    expect(after?.bdrenHoldTenantId).toBeUndefined();
    expect(await unlinkMigratedUser(db(), member._id.toHexString())).toBe('not_migrated');
  });

  it('makes a tenantless individual without a scope standalone, but never staff', async () => {
    const solo = await makeUser({ tenantId: undefined, accountScope: undefined });
    const boss = await makeUser({
      tenantId: undefined,
      accountScope: undefined,
      email: 'boss@example.test',
    });
    const member = await makeUser();
    await migrateUsersToZitadel({ db: db(), zitadel: client() }, options({ includeAdmins: true }));

    for (const user of [solo, boss, member]) {
      expect(
        await unlinkMigratedUser(db(), user._id.toHexString(), {
          staffEmails: ['BOSS@example.test'],
        }),
      ).toBe('unlinked');
    }

    expect((await load(solo._id))?.accountScope).toBe('standalone');
    expect((await load(boss._id))?.accountScope).toBeUndefined();
    expect(await load(member._id)).toMatchObject({
      tenantId: 'dhaka-university',
      accountScope: 'institution',
    });
  });

  it('never touches an account that was not migrated', async () => {
    const sso = await makeUser({ provider: 'openid', openidId: 'x', openidIssuer: ISSUER });
    expect(await unlinkMigratedUser(db(), sso._id.toHexString())).toBe('not_migrated');
    expect((await load(sso._id))?.provider).toBe('openid');
  });
});
