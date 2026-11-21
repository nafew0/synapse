const express = require('express');
const passport = require('passport');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

/** The real OpenID client needs a live issuer; the admin callback only needs it to exist. */
jest.mock('~/strategies', () => ({
  ...jest.requireActual('~/strategies'),
  getOpenIdConfig: () => ({}),
}));

jest.mock('~/server/services/Config', () => ({
  ...jest.requireActual('~/server/services/Config'),
  getAppConfig: jest.fn(async () => ({})),
}));

Object.assign(process.env, {
  LOGIN_MAX: '1000',
  REGISTER_MAX: '1000',
  RESET_PASSWORD_MAX: '1000',
  VERIFY_EMAIL_MAX: '1000',
  TWO_FACTOR_TEMP_MAX: '1000',
  BAN_VIOLATIONS: 'false',
});

const ISSUER = 'https://auth.bdren.test';
const PASSWORD = 'correct horse battery';
const SUPERADMIN_EMAIL = 'root@bdren.test';

/**
 * End-to-end check of SSO-only mode on the real routers, strategies and database: every route that
 * could sign someone in or create users, institutions or invitations without bdren.ai is refused
 * while it is on, and works as before while it is off.
 */
describe('SSO-only sign-in through bdren.ai', () => {
  let app;
  let mongoServer;
  let User;
  let Institution;
  const users = {};

  const tokenFor = (user) => jwt.sign({ id: user._id.toString() }, process.env.JWT_SECRET);
  const bearer = (user) => ({ Authorization: `Bearer ${tokenFor(user)}` });
  const setSsoOnly = (enabled) => {
    process.env.BDREN_SSO_ONLY = enabled ? 'true' : 'false';
  };
  const refreshCookie = (res) =>
    (res.headers['set-cookie'] ?? []).find((cookie) => cookie.startsWith('refreshToken='));

  beforeAll(async () => {
    process.env.JWT_REFRESH_SECRET = 'test-refresh';
    process.env.BDREN_ISSUER = ISSUER;
    process.env.PLATFORM_SUPERADMIN_EMAILS = SUPERADMIN_EMAIL;
    process.env.ALLOW_EMAIL_LOGIN = 'true';
    process.env.ALLOW_REGISTRATION = 'true';
    process.env.ALLOW_PASSWORD_RESET = 'true';
    process.env.ALLOW_UNVERIFIED_EMAIL_LOGIN = 'true';

    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    ({ User, Institution } = require('~/db/models'));
    await require('~/models').seedDatabase();

    const { jwtLogin, passportLogin } = require('~/strategies');
    passport.use(jwtLogin());
    passport.use(passportLogin());

    app = express();
    app.use(express.json());
    app.use(passport.initialize());
    app.use('/oauth', require('../oauth'));
    app.use('/api/auth', require('../auth'));
    app.use('/api/user', require('../user'));
    app.use('/api/admin', require('../admin/auth'));
    app.use('/api/admin/users', require('../admin/users'));
    app.use('/api/platform/institutions', require('../platform/institutions'));
    app.use('/api/platform/users', require('../platform/users'));
    app.get('/api/share/viewer', require('~/server/middleware/optionalJwtAuth'), (req, res) =>
      res.json({ signedIn: req.user != null }),
    );
    const { requireRemoteAgentAuth } = require('../agents/middleware');
    app.get('/api/agents/v1/models', requireRemoteAgentAuth, (_req, res) => res.json({ ok: true }));
    app.use((err, _req, res, _next) => res.status(500).json({ message: err.message }));

    const password = await bcrypt.hash(PASSWORD, 10);
    const make = (fields) =>
      User.create({ emailVerified: true, role: 'USER', provider: 'local', ...fields });
    users.superadmin = await make({ email: SUPERADMIN_EMAIL, username: 'root', password });
    users.member = await make({ email: 'member@uni.test', username: 'member', password });
    users.staff = await make({
      email: 'staff@uni.test',
      username: 'staff',
      password,
      role: 'ADMIN',
    });
    users.sso = await make({
      email: 'sso@uni.test',
      username: 'sso',
      provider: 'openid',
      openidId: 'zitadel-sub-1',
      openidIssuer: ISSUER,
    });
    users.ssoInstitutionAdmin = await make({
      email: 'head@uni.test',
      username: 'head',
      role: 'ADMIN',
      provider: 'openid',
      openidId: 'zitadel-sub-2',
      openidIssuer: ISSUER,
    });
    users.ssoSuperadmin = await make({
      email: 'ops@bdren.test',
      username: 'ops',
      provider: 'openid',
      openidId: 'zitadel-sub-3',
      openidIssuer: ISSUER,
    });
    await require('~/models').upsertPlatformAdmin({
      userId: users.ssoSuperadmin._id.toString(),
      email: 'ops@bdren.test',
      role: require('@librechat/data-schemas').PlatformRoles.SUPERADMIN,
      active: true,
    });
    users.otherIssuer = await make({
      email: 'other@uni.test',
      username: 'other',
      provider: 'openid',
      openidId: 'other-sub-1',
      openidIssuer: 'https://login.example.com',
    });
    await Institution.create({ tenantId: 'uni', name: 'Uni', slug: 'uni', status: 'active' });
  }, 120000);

  afterAll(async () => {
    for (const key of [
      'BDREN_SSO_ONLY',
      'BDREN_ISSUER',
      'PLATFORM_SUPERADMIN_EMAILS',
      'JWT_REFRESH_SECRET',
    ]) {
      delete process.env[key];
    }
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  const refusedRoutes = [
    [
      'post',
      '/api/auth/login',
      403,
      'SSO_ONLY',
      () => ({ body: { email: 'member@uni.test', password: PASSWORD } }),
    ],
    ['post', '/api/auth/register', 403, 'SSO_ONLY', () => ({ body: { email: 'new@uni.test' } })],
    [
      'post',
      '/api/auth/requestPasswordReset',
      403,
      'SSO_ONLY',
      () => ({ body: { email: 'member@uni.test' } }),
    ],
    ['post', '/api/auth/resetPassword', 403, 'SSO_ONLY', () => ({ body: {} })],
    ['get', '/api/auth/invite/some-token', 410, 'SSO_ONLY', () => ({})],
    [
      'post',
      '/api/user/verify/resend',
      403,
      'SSO_ONLY',
      () => ({ body: { email: 'member@uni.test' } }),
    ],
    ['get', '/oauth/google', 403, 'SSO_ONLY', () => ({})],
    ['get', '/oauth/github/callback', 403, 'SSO_ONLY', () => ({})],
    ['get', '/oauth/saml', 403, 'SSO_ONLY', () => ({})],
    [
      'post',
      '/api/platform/institutions',
      410,
      'MANAGED_IN_BDREN',
      () => ({
        auth: users.superadmin,
        body: { tenantId: 'new', name: 'New', adminEmail: 'a@new.test' },
      }),
    ],
    [
      'post',
      '/api/platform/institutions/uni/admins',
      410,
      'MANAGED_IN_BDREN',
      () => ({ auth: users.superadmin, body: { email: 'a@uni.test' } }),
    ],
    [
      'post',
      '/api/platform/users/standalone/invites',
      410,
      'MANAGED_IN_BDREN',
      () => ({ auth: users.superadmin, body: { email: 'x@ind.test' } }),
    ],
    [
      'post',
      '/api/platform/users/standalone/invites/abc/resend',
      410,
      'MANAGED_IN_BDREN',
      () => ({ auth: users.superadmin }),
    ],
    [
      'post',
      '/api/platform/users/invites/resend-bulk',
      410,
      'MANAGED_IN_BDREN',
      () => ({ auth: users.superadmin }),
    ],
    [
      'post',
      '/api/platform/users/invites/abc/resend',
      410,
      'MANAGED_IN_BDREN',
      () => ({ auth: users.superadmin }),
    ],
    [
      'post',
      '/api/platform/users/abc/resend-verification',
      410,
      'MANAGED_IN_BDREN',
      () => ({ auth: users.superadmin }),
    ],
    [
      'post',
      '/api/admin/users/invite',
      410,
      'MANAGED_IN_BDREN',
      () => ({ auth: users.superadmin, body: { email: 'y@uni.test', tenantId: 'uni' } }),
    ],
    [
      'post',
      '/api/admin/users/invites/import/dry-run',
      410,
      'MANAGED_IN_BDREN',
      () => ({ auth: users.superadmin, body: { tenantId: 'uni' } }),
    ],
    [
      'post',
      '/api/admin/users/invites/import',
      410,
      'MANAGED_IN_BDREN',
      () => ({ auth: users.superadmin, body: { tenantId: 'uni' } }),
    ],
    [
      'post',
      '/api/admin/users/invites/resend-bulk',
      410,
      'MANAGED_IN_BDREN',
      () => ({ auth: users.superadmin, body: { tenantId: 'uni' } }),
    ],
    [
      'post',
      '/api/admin/users/invites/abc/resend',
      410,
      'MANAGED_IN_BDREN',
      () => ({ auth: users.superadmin, body: { tenantId: 'uni' } }),
    ],
  ];

  const send = (method, path, { auth, body } = {}) => {
    const call = request(app)[method](path);
    if (auth) {
      call.set(bearer(auth));
    }
    return body ? call.send(body) : call;
  };

  describe.each(refusedRoutes)('%s %s', (method, path, status, code, options) => {
    it(`answers ${status} ${code} while SSO-only is on`, async () => {
      setSsoOnly(true);
      const res = await send(method, path, options());
      expect(res.status).toBe(status);
      expect(res.body.code).toBe(code);
    });

    it('is not refused while SSO-only is off', async () => {
      setSsoOnly(false);
      const res = await send(method, path, options());
      expect(res.body?.code).not.toBe(code);
    });
  });

  describe('password login while off (control)', () => {
    it('signs a member in with their password', async () => {
      setSsoOnly(false);
      const res = await send('post', '/api/auth/login', {
        body: { email: 'member@uni.test', password: PASSWORD },
      });
      expect(res.status).toBe(200);
      expect(res.body.token).toEqual(expect.any(String));
    });
  });

  describe('what stays open for superadmins', () => {
    it('lists institutions and suspends/reactivates one', async () => {
      setSsoOnly(true);
      const list = await send('get', '/api/platform/institutions', { auth: users.superadmin });
      expect(list.status).toBe(200);
      const suspend = await send('post', '/api/platform/institutions/uni/suspend', {
        auth: users.superadmin,
        body: {},
      });
      expect(suspend.status).toBe(200);
      const reactivate = await send('post', '/api/platform/institutions/uni/reactivate', {
        auth: users.superadmin,
        body: {},
      });
      expect(reactivate.status).toBe(200);
    });
  });

  describe('admin password login (synapse-admin)', () => {
    const adminLogin = (email) =>
      send('post', '/api/admin/login/local', { body: { email, password: PASSWORD } });

    it('signs in a platform superadmin while on', async () => {
      setSsoOnly(true);
      const res = await adminLogin(SUPERADMIN_EMAIL);
      expect(res.status).toBe(200);
      expect(res.body.token).toEqual(expect.any(String));
    });

    it('refuses an admin who is not a platform superadmin while on, and lets them in while off', async () => {
      setSsoOnly(true);
      const refused = await adminLogin('staff@uni.test');
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('SUPERADMIN_ONLY');

      setSsoOnly(false);
      const allowed = await adminLogin('staff@uni.test');
      expect(allowed.status).toBe(200);
    });

    it('refuses a normal user while on', async () => {
      setSsoOnly(true);
      const res = await adminLogin('member@uni.test');
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('SUPERADMIN_ONLY');
    });

    it('refuses to finish a 2FA login for anyone but a superadmin or SSO user while on', async () => {
      const tempToken = jwt.sign({ userId: users.member._id.toString() }, process.env.JWT_SECRET, {
        expiresIn: '5m',
      });
      setSsoOnly(true);
      const refused = await send('post', '/api/auth/2fa/verify-temp', {
        body: { tempToken, token: '123456' },
      });
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('SUPERADMIN_ONLY');

      setSsoOnly(false);
      const passedOn = await send('post', '/api/auth/2fa/verify-temp', {
        body: { tempToken, token: '123456' },
      });
      expect(passedOn.status).toBe(400);
    });
  });

  describe('synapse-admin through BDREN SSO', () => {
    /** Stands in for the ZITADEL round trip: the callback signs in whoever the test names. */
    let ssoAdminUser;
    beforeAll(() => {
      const { Strategy } = require('passport-strategy');
      class FakeOpenIdAdmin extends Strategy {
        authenticate() {
          this.success(ssoAdminUser);
        }
      }
      passport.use('openidAdmin', new FakeOpenIdAdmin());
    });

    const callback = async (user) => {
      ssoAdminUser = { ...user.toObject(), id: user._id.toString() };
      return request(app).get('/api/admin/oauth/openid/callback');
    };

    it('switches the admin panel OpenID sign-in off while on, so synapse-admin keeps its own login', async () => {
      setSsoOnly(true);
      for (const path of [
        '/api/admin/oauth/openid/check',
        '/api/admin/oauth/openid',
        '/api/admin/oauth/openid/callback',
      ]) {
        const res = await request(app).get(path);
        expect(res.status).toBe(404);
        expect(res.body.error_code).toBe('OPENID_NOT_CONFIGURED');
      }
      ssoAdminUser = { ...users.ssoSuperadmin.toObject(), id: users.ssoSuperadmin._id.toString() };
      const viaCallback = await request(app).get('/api/admin/oauth/openid/callback');
      expect(viaCallback.headers['set-cookie']).toBeUndefined();
    });

    it('lets an institution admin through the admin OpenID callback while off', async () => {
      setSsoOnly(false);
      const res = await callback(users.ssoInstitutionAdmin);
      expect(res.headers.location).not.toContain('superadmin_only');
    });

    it('answers /api/admin/verify only for superadmins while on, ending other admin sessions', async () => {
      setSsoOnly(true);
      for (const user of [users.ssoInstitutionAdmin, users.staff]) {
        const res = await send('get', '/api/admin/verify', { auth: user });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('SUPERADMIN_ONLY');
      }
      expect((await send('get', '/api/admin/verify', { auth: users.ssoSuperadmin })).status).toBe(
        200,
      );

      setSsoOnly(false);
      expect((await send('get', '/api/admin/verify', { auth: users.staff })).status).toBe(200);
    });
  });

  describe('optional sign-in on shared links', () => {
    it('treats a session that did not come through BDREN as anonymous while on', async () => {
      setSsoOnly(true);
      const local = await send('get', '/api/share/viewer', { auth: users.member });
      expect(local.body.signedIn).toBe(false);
      const sso = await send('get', '/api/share/viewer', { auth: users.sso });
      expect(sso.body.signedIn).toBe(true);

      setSsoOnly(false);
      const off = await send('get', '/api/share/viewer', { auth: users.member });
      expect(off.body.signedIn).toBe(true);
    });
  });

  describe('agent API keys', () => {
    const keyFor = async (user) =>
      (await require('~/models').createAgentApiKey({ userId: user._id, name: 'old key' })).key;
    const listModels = (key) =>
      request(app).get('/api/agents/v1/models').set('Authorization', `Bearer ${key}`);

    it('refuses a key of an account that does not sign in through BDREN while on', async () => {
      const key = await keyFor(users.member);
      setSsoOnly(true);
      const refused = await listModels(key);
      expect(refused.status).toBe(401);
      expect(refused.body.error.code).toBe('SSO_REQUIRED');

      setSsoOnly(false);
      expect((await listModels(key)).status).toBe(200);
    });

    it("accepts an SSO user's key while on", async () => {
      const key = await keyFor(users.sso);
      setSsoOnly(true);
      expect((await listModels(key)).status).toBe(200);
    });
  });

  describe('sessions', () => {
    it('keeps the chat app to sessions that came through BDREN SSO', async () => {
      setSsoOnly(true);
      const sso = await send('get', '/api/user', { auth: users.sso });
      expect(sso.status).toBe(200);

      for (const user of [users.member, users.superadmin, users.otherIssuer]) {
        const res = await send('get', '/api/user', { auth: user });
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('SSO_REQUIRED');
      }

      setSsoOnly(false);
      expect((await send('get', '/api/user', { auth: users.member })).status).toBe(200);
    });

    it("lets a superadmin's admin session reach the admin API only", async () => {
      setSsoOnly(true);
      const verify = await send('get', '/api/admin/verify', { auth: users.superadmin });
      expect(verify.status).toBe(200);
      expect(verify.body.user.isPlatformSuperadmin).toBe(true);
    });

    it('refuses to refresh a password session made before the switch, but refreshes a superadmin', async () => {
      setSsoOnly(false);
      const login = await send('post', '/api/auth/login', {
        body: { email: 'member@uni.test', password: PASSWORD },
      });
      const memberCookie = refreshCookie(login);
      expect(memberCookie).toBeDefined();

      setSsoOnly(true);
      const refused = await request(app).post('/api/auth/refresh').set('Cookie', memberCookie);
      expect(refused.status).toBe(401);
      expect(refused.body.code).toBe('SSO_REQUIRED');

      const adminLogin = await send('post', '/api/admin/login/local', {
        body: { email: SUPERADMIN_EMAIL, password: PASSWORD },
      });
      const adminCookie = refreshCookie(adminLogin);
      const refreshed = await request(app).post('/api/auth/refresh').set('Cookie', adminCookie);
      expect(refreshed.status).toBe(200);
      expect(refreshed.body.token).toEqual(expect.any(String));
    });

    it('logs an SSO user out', async () => {
      setSsoOnly(true);
      const res = await send('post', '/api/auth/logout', { auth: users.sso });
      expect(res.status).toBe(200);
    });
  });
});
