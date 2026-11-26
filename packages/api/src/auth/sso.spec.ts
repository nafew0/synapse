import express from 'express';
import request from 'supertest';
import {
  isSsoUser,
  readSsoOnly,
  isStaffPath,
  SsoRefusals,
  isBdrenIssuer,
  mayHoldSession,
  needsSsoSession,
  refuseWhenSsoOnly,
  ssoOnlyStartupFields,
  refuseOtherProvidersWhenSsoOnly,
} from './sso';

const ISSUER = 'https://auth.bdren.test';
const configured = {
  BDREN_ISSUER: `${ISSUER}/`,
  OPENID_CLIENT_ID: 'synapse',
  OPENID_ISSUER: ISSUER,
};
const on = { enabled: true, issuer: ISSUER };
const off = { enabled: false, issuer: ISSUER };
const ssoUser = { provider: 'openid', openidId: 'sub-1', openidIssuer: ISSUER };
const localUser = { provider: 'local' };

describe('readSsoOnly', () => {
  it('is on by default when the BDREN issuer and the OpenID client are configured', () => {
    expect(readSsoOnly(configured)).toEqual({ enabled: true, issuer: ISSUER });
  });

  it('is off by default without the BDREN issuer or the OpenID client', () => {
    expect(readSsoOnly({ OPENID_CLIENT_ID: 'synapse', OPENID_ISSUER: ISSUER }).enabled).toBe(false);
    expect(readSsoOnly({ BDREN_ISSUER: ISSUER }).enabled).toBe(false);
  });

  it('follows BDREN_SSO_ONLY when it is set', () => {
    expect(readSsoOnly({ ...configured, BDREN_SSO_ONLY: 'false' }).enabled).toBe(false);
    expect(readSsoOnly({ BDREN_SSO_ONLY: 'true' }).enabled).toBe(true);
    expect(readSsoOnly({ ...configured, BDREN_SSO_ONLY: ' Off ' }).enabled).toBe(false);
  });
});

describe('issuer and user checks', () => {
  it('accepts only the BDREN issuer, ignoring a trailing slash or discovery path', () => {
    expect(isBdrenIssuer(`${ISSUER}/`, on)).toBe(true);
    expect(isBdrenIssuer(`${ISSUER}/.well-known/openid-configuration`, on)).toBe(true);
    expect(isBdrenIssuer('https://login.example.com', on)).toBe(false);
    expect(isBdrenIssuer(undefined, on)).toBe(false);
  });

  it('treats only OpenID accounts from the BDREN issuer as SSO users', () => {
    expect(isSsoUser(ssoUser, on)).toBe(true);
    expect(isSsoUser({ ...ssoUser, openidIssuer: 'https://other.test' }, on)).toBe(false);
    expect(isSsoUser(localUser, on)).toBe(false);
    expect(isSsoUser(null, on)).toBe(false);
  });

  it('lets a non-SSO session reach only the admin areas', () => {
    expect(isStaffPath('/api/admin/verify')).toBe(true);
    expect(isStaffPath('/api/platform/institutions?x=1')).toBe(true);
    expect(isStaffPath('/api/auth/logout')).toBe(true);
    expect(isStaffPath('/api/adminx')).toBe(false);
    expect(isStaffPath('/api/convos')).toBe(false);
    expect(needsSsoSession(localUser, '/api/convos', on)).toBe(true);
    expect(needsSsoSession(localUser, '/api/platform/users', on)).toBe(false);
    expect(needsSsoSession(ssoUser, '/api/convos', on)).toBe(false);
    expect(needsSsoSession(localUser, '/api/convos', off)).toBe(false);
  });

  it('allows a session without SSO only for superadmins while on', async () => {
    const superadmin = jest.fn().mockResolvedValue(true);
    const nobody = jest.fn().mockResolvedValue(false);
    await expect(mayHoldSession(localUser, nobody, off)).resolves.toBe(true);
    await expect(mayHoldSession(ssoUser, nobody, on)).resolves.toBe(true);
    await expect(mayHoldSession(localUser, nobody, on)).resolves.toBe(false);
    await expect(mayHoldSession(localUser, superadmin, on)).resolves.toBe(true);
    expect(nobody).toHaveBeenCalledTimes(1);
  });
});

describe('route guards', () => {
  function app(enabled: boolean) {
    const read = () => (enabled ? on : off);
    const server = express();
    server.post('/login', refuseWhenSsoOnly(SsoRefusals.login, read), (_req, res) => {
      res.sendStatus(200);
    });
    const oauth = express.Router();
    oauth.use(refuseOtherProvidersWhenSsoOnly(read));
    oauth.get('/:provider', (_req, res) => {
      res.sendStatus(200);
    });
    oauth.get('/:provider/callback', (_req, res) => {
      res.sendStatus(200);
    });
    oauth.post('/:provider/backchannel-logout', (_req, res) => {
      res.sendStatus(200);
    });
    server.use('/oauth', oauth);
    return server;
  }

  it('refuses with the refusal status and code while on', async () => {
    const res = await request(app(true)).post('/login');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      code: 'SSO_ONLY',
      message: SsoRefusals.login.message,
      error: SsoRefusals.login.message,
    });
  });

  it('passes through while off', async () => {
    expect((await request(app(false)).post('/login')).status).toBe(200);
    expect((await request(app(false)).get('/oauth/google')).status).toBe(200);
  });

  it('keeps only the OpenID provider on the OAuth router while on', async () => {
    const statuses = await Promise.all(
      [
        '/oauth/openid',
        '/oauth/openid/callback',
        '/oauth/google',
        '/oauth/github/callback',
        '/oauth/saml',
      ].map(async (path) => (await request(app(true)).get(path)).status),
    );
    expect(statuses).toEqual([200, 200, 403, 403, 403]);
  });

  it("keeps the IdP's back-channel logout open while on", async () => {
    const res = await request(app(true)).post('/oauth/openid/backchannel-logout');
    expect(res.status).toBe(200);
  });
});

describe('ssoOnlyStartupFields', () => {
  it('leaves only the BDREN sign-in, with auto-redirect', () => {
    expect(ssoOnlyStartupFields(on)).toEqual(
      expect.objectContaining({
        ssoOnly: true,
        emailLoginEnabled: false,
        registrationEnabled: false,
        passwordResetEnabled: false,
        socialLoginEnabled: true,
        socialLogins: ['openid'],
        openidAutoRedirect: true,
        googleLoginEnabled: false,
        samlLoginEnabled: false,
      }),
    );
  });

  it('changes nothing while off', () => {
    expect(ssoOnlyStartupFields(off)).toBeNull();
  });
});
