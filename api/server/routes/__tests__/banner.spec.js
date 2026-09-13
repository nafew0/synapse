const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const attachUser = (req) => {
  const userId = req.headers['x-test-user'];
  if (userId) {
    req.user = { id: userId, _id: new mongoose.Types.ObjectId(userId) };
  }
};

jest.mock('~/server/middleware/optionalJwtAuth', () => (req, res, next) => {
  attachUser(req);
  next();
});

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, res, next) => {
    attachUser(req);
    if (!req.user) {
      return res.status(401).end();
    }
    next();
  },
}));

jest.mock('~/server/middleware/roles/capabilities', () => ({
  requireCapability: () => (req, res, next) =>
    req.headers['x-test-admin'] === 'true' ? next() : res.status(403).end(),
}));

describe('Banner routes', () => {
  let app;
  let mongoServer;
  let Banner;

  const userId = new mongoose.Types.ObjectId().toString();

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    ({ Banner } = require('@librechat/data-schemas').createModels(mongoose));
    await mongoose.models.BannerView.syncIndexes();

    app = express();
    app.use(express.json());
    app.use('/api/banner', require('../banner'));
    app.use('/api/admin/banner', require('../admin/banner'));
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await Promise.all([Banner.deleteMany({}), mongoose.models.BannerView.deleteMany({})]);
  });

  const createBanner = (display, overrides = {}) =>
    Banner.create({
      bannerId: 'gemini-38',
      title: 'Gemini 3.8 Flash is here',
      message: 'Faster answers at a lower cost.',
      category: 'feature',
      display,
      displayFrom: new Date(Date.now() - 60_000),
      ...overrides,
    });

  it('shows a once banner on the first load and hides it after /seen', async () => {
    await createBanner('once');

    const first = await request(app).get('/api/banner').set('x-test-user', userId);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      bannerId: 'gemini-38',
      display: 'once',
      category: 'feature',
    });

    const seen = await request(app).post('/api/banner/gemini-38/seen').set('x-test-user', userId);
    expect(seen.status).toBe(204);

    const second = await request(app).get('/api/banner').set('x-test-user', userId);
    expect(second.status).toBe(200);
    expect(second.body).toBeNull();
  });

  it('hides an until_dismissed banner only after /dismiss', async () => {
    await createBanner('until_dismissed');

    await request(app).post('/api/banner/gemini-38/seen').set('x-test-user', userId);
    const afterSeen = await request(app).get('/api/banner').set('x-test-user', userId);
    expect(afterSeen.body).toMatchObject({ bannerId: 'gemini-38' });

    await request(app).post('/api/banner/gemini-38/dismiss').set('x-test-user', userId);
    const afterDismiss = await request(app).get('/api/banner').set('x-test-user', userId);
    expect(afterDismiss.body).toBeNull();
  });

  it('requires authentication to record a view', async () => {
    const response = await request(app).post('/api/banner/gemini-38/seen');
    expect(response.status).toBe(401);
  });

  it('rejects oversized banner ids', async () => {
    const response = await request(app)
      .post(`/api/banner/${'x'.repeat(129)}/dismiss`)
      .set('x-test-user', userId);
    expect(response.status).toBe(400);
  });

  describe('admin panel banners', () => {
    const adminGet = () =>
      request(app).get('/api/admin/banner').set('x-test-user', userId).set('x-test-admin', 'true');

    it('are served only on the admin route, and chat banners only on the chat route', async () => {
      await createBanner('once', { bannerId: 'chat-news' });
      await createBanner('once', { bannerId: 'admin-news', app: 'admin' });

      const chat = await request(app).get('/api/banner').set('x-test-user', userId);
      expect(chat.body).toMatchObject({ bannerId: 'chat-news', app: 'chat' });

      const admin = await adminGet();
      expect(admin.status).toBe(200);
      expect(admin.body).toMatchObject({ bannerId: 'admin-news', app: 'admin' });
    });

    it('never leak through the public chat route', async () => {
      await createBanner('once', { bannerId: 'admin-only', app: 'admin', isPublic: true });

      const chat = await request(app).get('/api/banner').set('x-test-user', userId);
      expect(chat.body).toBeNull();
      const anonymous = await request(app).get('/api/banner');
      expect(anonymous.body).toBeNull();
    });

    it('require admin access', async () => {
      await createBanner('once', { bannerId: 'admin-news', app: 'admin' });

      const signedOut = await request(app).get('/api/admin/banner');
      expect(signedOut.status).toBe(401);

      const regularUser = await request(app).get('/api/admin/banner').set('x-test-user', userId);
      expect(regularUser.status).toBe(403);
    });
  });
});
