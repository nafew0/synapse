import express from 'express';
import multer from 'multer';
import request from 'supertest';
import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels, createMethods, runAsSystem } from '@librechat/data-schemas';
import type { AllMethods } from '@librechat/data-schemas';
import type { Request, Response, NextFunction } from 'express';
import type { PhoneUploadSessions } from './session';
import type { PhoneUploadStore } from './store';
import {
  PHONE_UPLOAD_TTL_MS,
  PHONE_UPLOAD_SEEN_MS,
  PHONE_UPLOAD_MAX_FILES,
  createPhoneUploadSessions,
} from './session';
import { createPhoneUploadHandlers, phoneLinkHeaders } from './handlers';
import { createPhoneUploadStore } from './store';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { error: jest.fn(), warn: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));

let mongoServer: MongoMemoryServer;
let methods: AllMethods;
let store: PhoneUploadStore;
let sessions: PhoneUploadSessions;
let clock = Date.now();

const desktopUser = new Types.ObjectId().toString();
const otherUser = new Types.ObjectId().toString();

/** Mirrors the /api wiring: public phone routes plus desktop routes with a signed-in user. */
const buildApp = (userId: string) => {
  const handlers = createPhoneUploadHandlers({ sessions, store });
  const upload = multer({ storage: handlers.storage, limits: { fileSize: 1024, files: 1 } });
  const signIn = (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: { id: string } }).user = { id: userId };
    next();
  };
  const app = express();
  app.use(express.json());
  app.use('/u', phoneLinkHeaders);
  app.get('/u/:token', handlers.resolveLink, handlers.status);
  app.post(
    '/u/:token',
    handlers.resolveLink,
    handlers.checkRoom,
    upload.single('file'),
    handlers.received,
  );
  app.post('/sessions', signIn, handlers.createSession);
  app.get('/sessions/:sessionId', signIn, handlers.getSession);
  app.delete('/sessions/:sessionId', signIn, handlers.closeSession);
  app.get('/sessions/:sessionId/files/:fileId', signIn, handlers.downloadFile);
  app.use((error: Error & { code?: string }, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 500).json({ error: error.message });
  });
  return app;
};

const sendFile = (app: express.Express, token: string, name: string, body = 'hello') =>
  request(app)
    .post(`/u/${token}`)
    .attach('file', Buffer.from(body), {
      filename: encodeURIComponent(name),
      contentType: 'image/png',
    });

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  methods = createMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  const db = mongoose.connection.db!;
  await Promise.all(
    ['tokens', 'phoneuploads.files', 'phoneuploads.chunks'].map((name) =>
      db.collection(name).deleteMany({}),
    ),
  );
  clock = Date.now();
  store = createPhoneUploadStore(mongoose.connection.db!);
  sessions = createPhoneUploadSessions({
    store,
    createToken: methods.createToken,
    findToken: methods.findToken,
    updateToken: methods.updateToken,
    deleteTokens: methods.deleteTokens,
    runAsSystem,
    now: () => clock,
  });
});

describe('phone upload', () => {
  it('carries files from the phone link to the desktop session that opened it', async () => {
    const desktop = buildApp(desktopUser);
    const created = await request(desktop)
      .post('/sessions')
      .send({ endpoint: 'agents' })
      .expect(201);
    const { sessionId, token } = created.body as { sessionId: string; token: string };

    const status = await request(desktop).get(`/u/${token}`).expect(200);
    expect(status.body).toMatchObject({ received: 0, maxFiles: PHONE_UPLOAD_MAX_FILES });

    await sendFile(desktop, token, 'রসিদ photo.png', 'first').expect(201);
    await sendFile(desktop, token, 'second.png', 'second').expect(201);

    const session = await request(desktop).get(`/sessions/${sessionId}`).expect(200);
    expect(session.body.files.map((f: { filename: string }) => f.filename)).toEqual([
      'রসিদ_photo.png',
      'second.png',
    ]);

    const [first] = session.body.files as Array<{ fileId: string; mimeType: string }>;
    expect(first.mimeType).toBe('image/png');
    const download = await request(desktop)
      .get(`/sessions/${sessionId}/files/${first.fileId}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect((download.body as Buffer).toString()).toBe('first');

    const again = await request(desktop).get(`/sessions/${sessionId}`).expect(200);
    expect(again.body.files).toHaveLength(2);
    const phone = await request(desktop).get(`/u/${token}`).expect(200);
    expect(phone.body.received).toBe(2);
  });

  it('shows the phone as connected while its page keeps checking in', async () => {
    const app = buildApp(desktopUser);
    const created = await sessions.create(desktopUser, { endpoint: 'agents' });
    expect((await sessions.get(desktopUser, created.sessionId))?.phoneConnected).toBe(false);

    await request(app).get(`/u/${created.token}`).expect(200);
    const session = await request(app).get(`/sessions/${created.sessionId}`).expect(200);
    expect(session.body.phoneConnected).toBe(true);
    expect((await sessions.resolve(created.token))?.endpoint).toBe('agents');

    clock += PHONE_UPLOAD_SEEN_MS + 1000;
    expect((await sessions.get(desktopUser, created.sessionId))?.phoneConnected).toBe(false);
  });

  it('tells browsers not to cache the link or pass it on', async () => {
    const created = await sessions.create(desktopUser, {});
    const res = await request(buildApp(desktopUser)).get(`/u/${created.token}`).expect(200);
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cache-control']).toBe('no-store');
    const missing = await request(buildApp(desktopUser)).get('/u/unknown').expect(404);
    expect(missing.headers['referrer-policy']).toBe('no-referrer');
  });

  it('stores only a hash of the link token', async () => {
    const created = await sessions.create(desktopUser, {});
    const raw = await methods.findToken({ identifier: created.sessionId });
    expect(raw?.token).toBeDefined();
    expect(raw?.token).not.toBe(created.token);
  });

  it('rejects an unknown link without asking the phone to sign in', async () => {
    const app = buildApp(desktopUser);
    const res = await sendFile(app, 'not-a-real-token', 'a.png').expect(404);
    expect(res.body.error).toMatch(/expired/);
  });

  it('keeps one user out of another user’s session and files', async () => {
    const created = await sessions.create(desktopUser, {});
    await sendFile(buildApp(desktopUser), created.token, 'private.png').expect(201);
    const [file] = (await sessions.get(desktopUser, created.sessionId))!.files;

    const intruder = buildApp(otherUser);
    await request(intruder).get(`/sessions/${created.sessionId}`).expect(410);
    await request(intruder).get(`/sessions/${created.sessionId}/files/${file.fileId}`).expect(404);
    await request(intruder).delete(`/sessions/${created.sessionId}`).expect(204);
    expect(await store.count({ sessionId: created.sessionId, userId: desktopUser })).toBe(1);
  });

  it('stops taking files once the session is full', async () => {
    const created = await sessions.create(desktopUser, {});
    const owner = { sessionId: created.sessionId, userId: desktopUser };
    const { Readable } = await import('stream');
    for (let i = 0; i < PHONE_UPLOAD_MAX_FILES; i++) {
      await store.save(owner, {
        filename: `${i}.png`,
        mimeType: 'image/png',
        stream: Readable.from([Buffer.from('x')]),
      });
    }
    const res = await sendFile(buildApp(desktopUser), created.token, 'extra.png').expect(409);
    expect(res.body.error).toMatch(String(PHONE_UPLOAD_MAX_FILES));
  });

  it('removes a file that goes over the size limit', async () => {
    const created = await sessions.create(desktopUser, {});
    await sendFile(buildApp(desktopUser), created.token, 'big.png', 'x'.repeat(2048)).expect(413);
    expect(await store.count({ sessionId: created.sessionId, userId: desktopUser })).toBe(0);
  });

  it('ends the link after its time and when the desktop closes it', async () => {
    const created = await sessions.create(desktopUser, {});
    await sendFile(buildApp(desktopUser), created.token, 'a.png').expect(201);

    clock += PHONE_UPLOAD_TTL_MS + 1000;
    expect(await sessions.resolve(created.token)).toBeNull();
    expect(await sessions.get(desktopUser, created.sessionId)).toBeNull();

    await sessions.close(desktopUser, created.sessionId);
    expect(await store.count({ sessionId: created.sessionId, userId: desktopUser })).toBe(0);
    expect(await mongoose.models.Token.countDocuments()).toBe(0);
  });

  it('sweeps files left by sessions nobody closed', async () => {
    const created = await sessions.create(desktopUser, {});
    await sendFile(buildApp(desktopUser), created.token, 'left.png').expect(201);
    clock += PHONE_UPLOAD_TTL_MS * 2;
    await sessions.create(desktopUser, {});
    expect(await store.count({ sessionId: created.sessionId, userId: desktopUser })).toBe(0);
  });
});
