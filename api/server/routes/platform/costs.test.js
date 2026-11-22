const express = require('express');
const request = require('supertest');

const mockView = jest.fn((_req, res) => res.json({ ok: true }));
const mockRefresh = jest.fn((_req, res) => res.json({ ok: true }));
const mockEnter = jest.fn((_req, res) => res.json({ ok: true }));
const mockSuperadmin = jest.fn();

jest.mock('@librechat/api', () => ({
  createSpendHandlers: () => new Proxy({}, { get: () => (_req, res) => res.json({ spend: true }) }),
  createReconcileHandlers: () => ({
    view: (...args) => mockView(...args),
    refresh: (...args) => mockRefresh(...args),
    enterUnstructured: (...args) => mockEnter(...args),
  }),
}));
jest.mock('~/models', () => ({}));
jest.mock('~/server/middleware', () => ({ requireJwtAuth: (_req, _res, next) => next() }));
jest.mock(
  '~/server/middleware/platformAdmin',
  () =>
    (...args) =>
      mockSuperadmin(...args),
);

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/platform/costs', require('./costs'));
  return app;
};

const ROUTES = [
  ['get', '/api/platform/costs/reconciliation', mockView],
  ['post', '/api/platform/costs/reconciliation/refresh', mockRefresh],
  ['put', '/api/platform/costs/reconciliation/unstructured', mockEnter],
];

describe('reconciliation routes', () => {
  beforeEach(() => jest.clearAllMocks());

  it.each(ROUTES)(
    '%s %s is refused for anyone but a platform superadmin',
    async (method, path, handler) => {
      mockSuperadmin.mockImplementation((_req, res) =>
        res.status(403).json({ error: 'Platform superadmin privileges required' }),
      );
      const response = await request(buildApp())[method](path).send({});
      expect(response.status).toBe(403);
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it.each(ROUTES)('%s %s reaches its handler for a superadmin', async (method, path, handler) => {
    mockSuperadmin.mockImplementation((_req, _res, next) => next());
    const response = await request(buildApp())[method](path).send({});
    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
