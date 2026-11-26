const express = require('express');
const request = require('supertest');

const mockList = jest.fn((_req, res) => res.json({ list: true }));
const mockInstitution = jest.fn((req, res) => res.json({ tenantId: req.params.tenantId }));
const mockSuperadmin = jest.fn();

jest.mock('@librechat/api', () => ({
  createKbStorageHandlers: () => ({
    list: (...args) => mockList(...args),
    institution: (...args) => mockInstitution(...args),
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
  app.use('/api/platform', require('./kb'));
  return app;
};

const ROUTES = [
  ['/api/platform/kb/storage?days=30', mockList],
  ['/api/platform/institutions/uni-a/kb/storage', mockInstitution],
];

describe('knowledge base storage routes', () => {
  beforeEach(() => jest.clearAllMocks());

  it.each(ROUTES)(
    'GET %s is refused for anyone but a platform superadmin',
    async (path, handler) => {
      mockSuperadmin.mockImplementation((_req, res) =>
        res.status(403).json({ error: 'Platform superadmin privileges required' }),
      );
      const response = await request(buildApp()).get(path);
      expect(response.status).toBe(403);
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it.each(ROUTES)('GET %s reaches its handler for a superadmin', async (path, handler) => {
    mockSuperadmin.mockImplementation((_req, _res, next) => next());
    const response = await request(buildApp()).get(path);
    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
