import express from 'express';
import request from 'supertest';
import { Types } from 'mongoose';
import type { RequestHandler } from 'express';
import type { IUser } from '@librechat/data-schemas';
import { createRequireApiKeyAuth } from './middleware';

const ISSUER = 'https://auth.bdren.test';
const KEY = 'sk-test-key';

function appFor(user: Partial<IUser>) {
  const userId = new Types.ObjectId();
  /** The factory types `req.user` as a full IUser, which Express's augmented Request does not match. */
  const auth = createRequireApiKeyAuth({
    validateAgentApiKey: async (key) =>
      key === KEY ? { userId, keyId: new Types.ObjectId() } : null,
    findUser: async () => ({ _id: userId, ...user }) as IUser,
  });
  const app = express();
  app.get('/api/agents/v1/models', auth as unknown as RequestHandler, (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

const ssoUser = { provider: 'openid', openidId: 'sub-1', openidIssuer: ISSUER };
const localUser = { provider: 'local' };
const listModels = (user: Partial<IUser>) =>
  request(appFor(user)).get('/api/agents/v1/models').set('Authorization', `Bearer ${KEY}`);

describe('API key auth with SSO-only sign-in', () => {
  afterEach(() => {
    delete process.env.BDREN_SSO_ONLY;
    delete process.env.BDREN_ISSUER;
  });

  it('refuses a key whose account does not sign in through bdren.ai while on', async () => {
    process.env.BDREN_SSO_ONLY = 'true';
    process.env.BDREN_ISSUER = ISSUER;

    const res = await listModels(localUser);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({ code: 'SSO_REQUIRED', type: 'invalid_request_error' });
  });

  it("accepts an SSO user's key while on", async () => {
    process.env.BDREN_SSO_ONLY = 'true';
    process.env.BDREN_ISSUER = ISSUER;

    expect((await listModels(ssoUser)).status).toBe(200);
  });

  it('accepts any valid key while off', async () => {
    process.env.BDREN_SSO_ONLY = 'false';

    expect((await listModels(localUser)).status).toBe(200);
  });
});
