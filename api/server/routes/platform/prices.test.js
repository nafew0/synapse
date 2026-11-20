const express = require('express');
const request = require('supertest');

const mockHandlers = {};
const NAMES = [
  'list',
  'changes',
  'detail',
  'diff',
  'markSeen',
  'sync',
  'setOverride',
  'clearOverride',
];
for (const name of NAMES) {
  mockHandlers[name] = jest.fn((req, res) => res.json({ handler: name, params: req.params }));
}
const mockSuperadmin = jest.fn();
const mockJwt = jest.fn((_req, _res, next) => next());

jest.mock('@librechat/api', () => ({
  createPriceHandlers: () => mockHandlers,
  priceModels: jest.fn(),
  priceStore: jest.fn(),
  collectModelsInUse: jest.fn(),
}));
jest.mock('~/models', () => ({}));
jest.mock('~/server/services/Config', () => ({ getAppConfig: jest.fn() }));
jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (...args) => mockJwt(...args),
}));
jest.mock(
  '~/server/middleware/platformAdmin',
  () =>
    (...args) =>
      mockSuperadmin(...args),
);

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/platform/prices', require('./prices'));
  return app;
};

const ENC = encodeURIComponent('anthropic/claude-haiku-5.5');
const BASE = '/api/platform/prices';

const ROUTES = [
  ['get', BASE, 'list'],
  ['get', `${BASE}/changes`, 'changes'],
  ['post', `${BASE}/changes/abc123/seen`, 'markSeen'],
  ['post', `${BASE}/sync`, 'sync'],
  ['get', `${BASE}/${ENC}/diff?from=1&to=2`, 'diff'],
  ['put', `${BASE}/${ENC}/override`, 'setOverride'],
  ['delete', `${BASE}/${ENC}/override`, 'clearOverride'],
  ['get', `${BASE}/${ENC}`, 'detail'],
];

describe('price routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockJwt.mockImplementation((_req, _res, next) => next());
  });

  it.each(ROUTES)(
    '%s %s is refused for anyone but a platform superadmin',
    async (method, path, name) => {
      mockSuperadmin.mockImplementation((_req, res) =>
        res.status(403).json({ error: 'Platform superadmin privileges required' }),
      );
      const response = await request(buildApp())[method](path).send({});
      expect(response.status).toBe(403);
      for (const handler of Object.values(mockHandlers)) {
        expect(handler).not.toHaveBeenCalled();
      }
      expect(name).toBeDefined();
    },
  );

  it.each(ROUTES)(
    '%s %s reaches only its own handler for a superadmin',
    async (method, path, name) => {
      mockSuperadmin.mockImplementation((_req, _res, next) => next());
      const response = await request(buildApp())[method](path).send({});
      expect(response.status).toBe(200);
      expect(response.body.handler).toBe(name);
      for (const [other, handler] of Object.entries(mockHandlers)) {
        expect(handler).toHaveBeenCalledTimes(other === name ? 1 : 0);
      }
    },
  );

  it('runs authentication before the superadmin check', async () => {
    const order = [];
    mockJwt.mockImplementation((_req, _res, next) => {
      order.push('jwt');
      next();
    });
    mockSuperadmin.mockImplementation((_req, _res, next) => {
      order.push('superadmin');
      next();
    });
    await request(buildApp()).get(BASE);
    expect(order).toEqual(['jwt', 'superadmin']);
  });

  it('does not run the superadmin check when authentication fails', async () => {
    mockJwt.mockImplementation((_req, res) => res.status(401).json({ error: 'no' }));
    const response = await request(buildApp()).get(BASE);
    expect(response.status).toBe(401);
    expect(mockSuperadmin).not.toHaveBeenCalled();
  });

  it('decodes an encoded model id into the :modelId param', async () => {
    mockSuperadmin.mockImplementation((_req, _res, next) => next());
    const response = await request(buildApp()).get(`${BASE}/${ENC}`);
    expect(response.body.params).toEqual({ modelId: 'anthropic/claude-haiku-5.5' });
  });

  it('routes /changes and /sync to their handlers, not to /:modelId', async () => {
    mockSuperadmin.mockImplementation((_req, _res, next) => next());
    const changes = await request(buildApp()).get(`${BASE}/changes`);
    expect(changes.body.handler).toBe('changes');
    expect(mockHandlers.detail).not.toHaveBeenCalled();
    const sync = await request(buildApp()).post(`${BASE}/sync`);
    expect(sync.body.handler).toBe('sync');
  });
});
