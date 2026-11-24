import http from 'http';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { generateKeyPairSync } from 'crypto';
import type { AddressInfo } from 'net';
import type { OpenIdEndedSession } from '@librechat/data-schemas';
import type { BackchannelLogoutDeps, LogoutTokenVerification } from './backchannel';
import {
  verifyLogoutToken,
  isOpenIdSessionEnded,
  BACKCHANNEL_LOGOUT_EVENT,
  createJwksSigningKeyResolver,
  createBackchannelLogoutHandler,
} from './backchannel';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const ISSUER = 'https://auth.bdren.test';
const CLIENT_ID = 'synapse-client';
const KID = 'key-1';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();

const verification: LogoutTokenVerification = {
  issuer: ISSUER,
  clientId: CLIENT_ID,
  getSigningKey: async () => publicPem,
};

type Claims = Record<string, unknown>;

const baseClaims = (): Claims => ({
  iss: ISSUER,
  aud: [CLIENT_ID],
  sub: 'user-sub',
  sid: 'session-1',
  jti: `jti-${Math.random()}`,
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 900,
  events: { [BACKCHANNEL_LOGOUT_EVENT]: {} },
});

const sign = (claims: Claims, privateKey = keys.privateKey) =>
  jwt.sign(claims, privateKey, { algorithm: 'RS256', keyid: KID });

describe('verifyLogoutToken', () => {
  it('accepts a well-formed logout token', async () => {
    const claims = await verifyLogoutToken(sign(baseClaims()), verification);
    expect(claims).toEqual(expect.objectContaining({ sub: 'user-sub', sid: 'session-1' }));
  });

  it('accepts the issuer with a trailing slash', async () => {
    const token = sign({ ...baseClaims(), iss: `${ISSUER}/` });
    await expect(verifyLogoutToken(token, verification)).resolves.toBeDefined();
  });

  it.each<[string, Claims]>([
    ['another audience', { aud: ['another-app'] }],
    ['another issuer', { iss: 'https://evil.test' }],
    ['no logout event', { events: { 'urn:other': {} } }],
    ['a non-object logout event', { events: { [BACKCHANNEL_LOGOUT_EVENT]: true } }],
    ['a nonce', { nonce: 'abc' }],
    ['no jti', { jti: undefined }],
    ['neither sub nor sid', { sub: undefined, sid: undefined }],
    ['an expiry in the past', { exp: Math.floor(Date.now() / 1000) - 600 }],
    ['an iat older than 30 minutes', { iat: Math.floor(Date.now() / 1000) - 3600, exp: undefined }],
  ])('rejects a token with %s', async (_label, overrides) => {
    const claims = { ...baseClaims(), ...overrides };
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) {
        delete claims[key];
      }
    }
    await expect(verifyLogoutToken(sign(claims), verification)).rejects.toThrow();
  });

  it('rejects a token signed by another key', async () => {
    const token = sign(baseClaims(), otherKeys.privateKey);
    await expect(verifyLogoutToken(token, verification)).rejects.toThrow();
  });

  it('rejects an unsigned token', async () => {
    const token = jwt.sign(baseClaims(), '', { algorithm: 'none' });
    await expect(verifyLogoutToken(token, verification)).rejects.toThrow();
  });
});

describe('createJwksSigningKeyResolver', () => {
  let server: http.Server;
  let jwksUri: string;

  beforeAll(async () => {
    const jwk = keys.publicKey.export({ format: 'jwk' });
    const app = express();
    app.get('/jwks', (_req, res) => {
      res.json({ keys: [{ ...jwk, kid: KID, use: 'sig', alg: 'RS256' }] });
    });
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    jwksUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/jwks`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('verifies a logout token with the key fetched from the JWKS', async () => {
    const claims = await verifyLogoutToken(sign(baseClaims()), {
      ...verification,
      getSigningKey: createJwksSigningKeyResolver(jwksUri),
    });
    expect(claims.sid).toBe('session-1');
  });

  it('rejects a token whose kid is not in the JWKS', async () => {
    const token = jwt.sign(baseClaims(), keys.privateKey, { algorithm: 'RS256', keyid: 'unknown' });
    await expect(
      verifyLogoutToken(token, {
        ...verification,
        getSigningKey: createJwksSigningKeyResolver(jwksUri),
      }),
    ).rejects.toThrow();
  });
});

describe('isOpenIdSessionEnded', () => {
  const at = (iso: string) => new Date(iso);
  const seconds = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

  it('is false without ended sessions or claims', () => {
    expect(isOpenIdSessionEnded(undefined, { sid: 's1' })).toBe(false);
    expect(isOpenIdSessionEnded([], { sid: 's1' })).toBe(false);
    expect(isOpenIdSessionEnded([{ sid: 's1', endedAt: new Date() }], null)).toBe(false);
  });

  it('matches only the ended session id', () => {
    const ended: OpenIdEndedSession[] = [{ sid: 's1', endedAt: at('2026-11-24T10:00:00Z') }];
    expect(isOpenIdSessionEnded(ended, { sid: 's1' })).toBe(true);
    expect(isOpenIdSessionEnded(ended, { sid: 's2' })).toBe(false);
    expect(isOpenIdSessionEnded(ended, {})).toBe(false);
  });

  it('ends every session signed in before a session-less logout', () => {
    const ended: OpenIdEndedSession[] = [{ endedAt: at('2026-11-24T10:00:00Z') }];
    expect(isOpenIdSessionEnded(ended, { auth_time: seconds('2026-11-24T09:00:00Z') })).toBe(true);
    expect(isOpenIdSessionEnded(ended, { auth_time: seconds('2026-11-24T11:00:00Z') })).toBe(false);
  });

  it('uses the sign-in time, so a refreshed token from an ended sign-in stays ended', () => {
    const ended: OpenIdEndedSession[] = [{ endedAt: at('2026-11-24T10:00:00Z') }];
    const refreshed = {
      auth_time: seconds('2026-11-24T09:00:00Z'),
      iat: seconds('2026-11-24T12:00:00Z'),
    };
    expect(isOpenIdSessionEnded(ended, refreshed)).toBe(true);
  });

  it('falls back to iat without auth_time', () => {
    const ended: OpenIdEndedSession[] = [{ endedAt: at('2026-11-24T10:00:00Z') }];
    expect(isOpenIdSessionEnded(ended, { iat: seconds('2026-11-24T09:59:00Z') })).toBe(true);
  });
});

describe('createBackchannelLogoutHandler', () => {
  function setup(overrides: Partial<BackchannelLogoutDeps> = {}) {
    const ended = new Map<string, OpenIdEndedSession[]>();
    const deps: BackchannelLogoutDeps = {
      getVerification: () => verification,
      findUserId: async (subject, issuer) =>
        subject === 'user-sub' && issuer === ISSUER ? 'user-1' : null,
      endSession: async (userId, entry) => {
        const list = ended.get(userId) ?? [];
        if (entry.sid && list.some((e) => e.sid === entry.sid)) {
          return false;
        }
        ended.set(userId, [...list, entry]);
        return true;
      },
      ...overrides,
    };
    const spies = {
      findUserId: jest.spyOn(deps, 'findUserId'),
      endSession: jest.spyOn(deps, 'endSession'),
    };
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.post('/logout', createBackchannelLogoutHandler(deps));
    const post = (token?: string) =>
      request(app)
        .post('/logout')
        .type('form')
        .send(token === undefined ? {} : { logout_token: token });
    return { post, ended, spies };
  }

  it('records the ended session and answers 200 with no-store', async () => {
    const { post, ended } = setup();
    const res = await post(sign(baseClaims()));
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(ended.get('user-1')).toEqual([{ sid: 'session-1', endedAt: expect.any(Date) }]);
  });

  it('is idempotent for a repeated logout of the same session', async () => {
    const { post, ended } = setup();
    await post(sign(baseClaims()));
    const res = await post(sign(baseClaims()));
    expect(res.status).toBe(200);
    expect(ended.get('user-1')).toHaveLength(1);
  });

  it('records a cutoff when the token has no sid', async () => {
    const { post, ended } = setup();
    const claims = baseClaims();
    delete claims.sid;
    await post(sign(claims));
    expect(ended.get('user-1')).toEqual([{ endedAt: expect.any(Date) }]);
  });

  it('answers 200 without recording when no user matches', async () => {
    const { post, spies } = setup();
    const res = await post(sign({ ...baseClaims(), sub: 'someone-else' }));
    expect(res.status).toBe(200);
    expect(spies.endSession).not.toHaveBeenCalled();
  });

  it('runs the after-session hook once the session is recorded', async () => {
    const afterSessionEnded = jest.fn().mockResolvedValue(undefined);
    const { post } = setup({ afterSessionEnded });
    await post(sign(baseClaims()));
    expect(afterSessionEnded).toHaveBeenCalledWith('user-1');
  });

  it('answers 400 without a token', async () => {
    const { post, spies } = setup();
    const res = await post();
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(spies.findUserId).not.toHaveBeenCalled();
  });

  it('answers 400 for a forged token and records nothing', async () => {
    const { post, spies } = setup();
    const res = await post(sign(baseClaims(), otherKeys.privateKey));
    expect(res.status).toBe(400);
    expect(spies.endSession).not.toHaveBeenCalled();
  });

  it('answers 400 for a sid-only token it cannot match to a user', async () => {
    const { post, spies } = setup();
    const claims = baseClaims();
    delete claims.sub;
    const res = await post(sign(claims));
    expect(res.status).toBe(400);
    expect(spies.findUserId).not.toHaveBeenCalled();
  });

  it('answers 501 while OpenID is not configured', async () => {
    const { post } = setup({ getVerification: () => null });
    expect((await post(sign(baseClaims()))).status).toBe(501);
  });

  it('answers 500 so the IdP retries when recording fails', async () => {
    const { post } = setup({
      endSession: async () => {
        throw new Error('database down');
      },
    });
    expect((await post(sign(baseClaims()))).status).toBe(500);
  });
});
