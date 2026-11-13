import { writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMethods, createModels, getTenantId } from '@librechat/data-schemas';
import type { AllMethods, IUser } from '@librechat/data-schemas';
import type { NextFunction, RequestHandler, Response } from 'express';
import type { ExtensionConfig } from './config';
import type { ExtensionRequest } from './auth';
import { createExtensionAuth, createExtensionEnabledCheck } from './auth';
import { createExtensionHandlers } from './handlers';
import { createModelHandlers, prepareBody, usageFromStream } from './model';
import type { FetchLike } from './model';
import { normaliseCode } from './credentials';

const config: ExtensionConfig = {
  model: 'openai/gpt-6-luna',
  apiKey: 'server-key',
  baseUrl: 'https://provider.test/api/v1',
  dailyTokens: 1_000,
  maxOutputTokens: 4_096,
  maxSteps: 50,
};

let mongo: MongoMemoryServer;
let db: AllMethods;
let user: IUser;
let otherUser: IUser;

const stream = (chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });

type Handler = (req: ExtensionRequest, res: Response, next: NextFunction) => unknown;

/** Express types its own requests; the handlers take Synapse's. */
const route =
  (handler: Handler): RequestHandler =>
  (req, res, next) =>
    void handler(req as ExtensionRequest, res, next);

function app(fetchImpl: FetchLike, parse?: Parameters<typeof createExtensionHandlers>[0]['parse']) {
  const server = express();
  server.use(express.json());
  const signedIn = (req: ExtensionRequest, _res: Response, next: NextFunction) => {
    const id = req.headers['x-test-user'] === 'other' ? otherUser : user;
    req.user = Object.assign(id, { id: String(id._id) });
    next();
  };
  const auth = createExtensionAuth({ store: db, findUser: db.findUser });
  const enabled = createExtensionEnabledCheck({
    getInstitutionByTenantId: db.getInstitutionByTenantId,
  });
  const handlers = createExtensionHandlers({
    config: () => config,
    store: db,
    getInstitutionByTenantId: db.getInstitutionByTenantId,
    parse,
  });
  const model = createModelHandlers({ config: () => config, store: db, fetch: fetchImpl });
  server.post('/codes', route(signedIn), route(handlers.createCode));
  server.delete('/tokens', route(signedIn), route(handlers.signOutEverywhere));
  server.post('/token', route(handlers.exchange));
  server.delete('/token', route(auth), route(handlers.signOut));
  server.get('/settings', route(auth), route(handlers.settings));
  const attach: Handler = (req, _res, next) => {
    req.file = (req.body as { file?: Express.Multer.File }).file;
    next();
  };
  server.post('/extract', route(auth), route(enabled), route(attach), route(handlers.extract));
  server.get(
    '/tenant',
    route(auth),
    route((_req, res) => res.json({ tenantId: getTenantId() })),
  );
  server.post('/chat', route(auth), route(enabled), route(model.chatCompletions));
  return server;
}

async function signIn(server: express.Express, who = 'me'): Promise<string> {
  const { body } = await request(server).post('/codes').set('x-test-user', who);
  const exchanged = await request(server).post('/token').send({ code: body.code });
  return exchanged.body.token;
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  createModels(mongoose);
  db = createMethods(mongoose) as AllMethods;
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
  await mongoose.models.Institution.create({
    tenantId: 'pilot',
    name: 'Pilot',
    browserControl: { extensionEnabled: true, blockedDomains: ['bank.example'] },
  });
  await mongoose.models.Institution.create({ tenantId: 'other', name: 'Other' });
  user = (
    await mongoose.models.User.create({
      email: 'a@pilot.test',
      tenantId: 'pilot',
      provider: 'local',
    })
  ).toObject();
  otherUser = (
    await mongoose.models.User.create({
      email: 'b@other.test',
      tenantId: 'other',
      provider: 'local',
    })
  ).toObject();
});

const noFetch: FetchLike = async () => {
  throw new Error('no provider call expected');
};

describe('sign-in', () => {
  it('turns a code into a token once, and the token signs requests in', async () => {
    const server = app(noFetch);
    const { body } = await request(server).post('/codes');
    expect(body.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const typed = body.code.toLowerCase().replace('-', ' ');
    const first = await request(server).post('/token').send({ code: typed });
    expect(first.body.token).toMatch(/^sbx_/);
    const again = await request(server).post('/token').send({ code: body.code });
    expect(again.status).toBe(400);
    const settings = await request(server)
      .get('/settings')
      .set('Authorization', `Bearer ${first.body.token}`);
    expect(settings.body).toEqual({
      enabled: true,
      blockedDomains: ['bank.example'],
      maxSteps: 50,
    });
  });

  it('stores only hashes', async () => {
    const server = app(noFetch);
    const token = await signIn(server);
    const stored = await mongoose.models.BrowserExtensionCredential.find().lean();
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  it('refuses a missing, wrong or signed-out token', async () => {
    const server = app(noFetch);
    expect((await request(server).get('/settings')).status).toBe(401);
    expect(
      (await request(server).get('/settings').set('Authorization', 'Bearer sbx_nope')).status,
    ).toBe(401);
    const token = await signIn(server);
    expect(
      (await request(server).delete('/token').set('Authorization', `Bearer ${token}`)).status,
    ).toBe(204);
    expect(
      (await request(server).get('/settings').set('Authorization', `Bearer ${token}`)).status,
    ).toBe(401);
  });

  it('signing out everywhere ends only that user’s tokens', async () => {
    const server = app(noFetch);
    const mine = await signIn(server);
    const theirs = await signIn(server, 'other');
    await request(server).delete('/tokens');
    expect(
      (await request(server).get('/settings').set('Authorization', `Bearer ${mine}`)).status,
    ).toBe(401);
    expect(
      (await request(server).get('/settings').set('Authorization', `Bearer ${theirs}`)).status,
    ).toBe(200);
  });

  it('runs the request in the user’s own tenant', async () => {
    const server = app(noFetch);
    const token = await signIn(server, 'other');
    const { body } = await request(server).get('/tenant').set('Authorization', `Bearer ${token}`);
    expect(body.tenantId).toBe('other');
  });

  it('normalises a typed code', () => {
    expect(normaliseCode(' abcd efgh ')).toBe('ABCD-EFGH');
  });
});

describe('the model endpoint', () => {
  it('refuses an institution that is not switched on', async () => {
    const server = app(noFetch);
    const token = await signIn(server, 'other');
    const res = await request(server)
      .post('/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ messages: [] });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('extension_disabled');
  });

  it('uses Synapse’s model and key, caps the output, streams the answer and records the usage', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fake: FetchLike = async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(
        stream([
          'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
          'data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":30,"cost":0.002,"prompt_tokens_details":{"cached_tokens":100}}}\n\n',
          'data: [DONE]\n\n',
        ]),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    };
    const server = app(fake);
    const token = await signIn(server);
    const res = await request(server)
      .post('/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({
        model: 'gpt-anything',
        stream: true,
        max_tokens: 99_999,
        messages: [{ role: 'user', content: 'x' }],
      });
    expect(res.status).toBe(200);
    expect(res.text).toContain('"content":"hi"');
    const sent = JSON.parse(String(calls[0].init.body));
    expect(calls[0].url).toBe('https://provider.test/api/v1/chat/completions');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
      'Bearer server-key',
    );
    expect(sent.model).toBe('openai/gpt-6-luna');
    expect(sent.max_tokens).toBe(4_096);
    expect(sent.stream_options).toEqual({ include_usage: true });
    const [usage] = await mongoose.models.BrowserExtensionUsage.find().lean();
    expect(usage).toMatchObject({
      llmModel: 'openai/gpt-6-luna',
      inputTokens: 120,
      outputTokens: 30,
      cachedTokens: 100,
      costUsd: 0.002,
      tenantId: 'pilot',
    });
  });

  it('stops a user at the daily limit', async () => {
    const server = app(noFetch);
    const token = await signIn(server);
    await db.recordBrowserExtensionUsage({
      user: user._id,
      tenantId: 'pilot',
      llmModel: config.model,
      inputTokens: 900,
      outputTokens: 100,
      cachedTokens: 0,
      costUsd: 0,
      at: new Date(),
    });
    const res = await request(server)
      .post('/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ messages: [] });
    expect(res.status).toBe(429);
  });

  it('passes a provider error through with its status', async () => {
    const fake: FetchLike = async () =>
      new Response('{"error":{"message":"overloaded"}}', { status: 503 });
    const server = app(fake);
    const token = await signIn(server);
    const res = await request(server)
      .post('/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ messages: [] });
    expect(res.status).toBe(503);
    expect(await mongoose.models.BrowserExtensionUsage.countDocuments()).toBe(0);
  });

  it('keeps max_completion_tokens when the extension sends it', () => {
    expect(prepareBody({ max_completion_tokens: 10 }, config)).toMatchObject({
      max_completion_tokens: 10,
    });
    expect(prepareBody({}, config)).toMatchObject({ max_tokens: 4_096 });
  });

  it('reads the last usage report in a stream tail', () => {
    expect(usageFromStream('data: {"usage":{"prompt_tokens":1}}\n\ndata: [DONE]\n')).toEqual({
      prompt_tokens: 1,
    });
    expect(usageFromStream('data: [DONE]\n')).toBeNull();
  });
});

describe('document reading', () => {
  it('reads a PDF with Synapse’s extraction and deletes the uploaded file', async () => {
    const path = join(tmpdir(), `extract-${Date.now()}.pdf`);
    await writeFile(path, 'x');
    const parse = jest.fn(async () => ({ text: 'VAT return 2026', bytes: 15, source: 'test' }));
    const server = app(noFetch, parse);
    const token = await signIn(server);
    const res = await request(server)
      .post('/extract')
      .set('Authorization', `Bearer ${token}`)
      .send({ file: { originalname: 'return.pdf', path, mimetype: 'application/pdf' } });
    expect(res.body).toEqual({ name: 'return.pdf', text: 'VAT return 2026', truncated: false });
    expect(parse).toHaveBeenCalledTimes(1);
    expect(existsSync(path)).toBe(false);
  });

  it('refuses a type it does not read, and still deletes the file', async () => {
    const path = join(tmpdir(), `extract-${Date.now()}.exe`);
    await writeFile(path, 'x');
    const server = app(noFetch, jest.fn());
    const token = await signIn(server);
    const res = await request(server)
      .post('/extract')
      .set('Authorization', `Bearer ${token}`)
      .send({ file: { originalname: 'setup.exe', path } });
    expect(res.status).toBe(415);
    expect(existsSync(path)).toBe(false);
  });
});
