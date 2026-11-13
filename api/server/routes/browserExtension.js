const os = require('os');
const express = require('express');
const multer = require('multer');
const { rateLimit } = require('express-rate-limit');
const {
  getExtensionConfig,
  createModelHandlers,
  createExtensionAuth,
  isExtensionConfigured,
  createExtensionHandlers,
  createExtensionEnabledCheck,
} = require('@librechat/api');
const { requireJwtAuth } = require('~/server/middleware');
const db = require('~/models');

const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

const upload = multer({ dest: os.tmpdir(), limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1 } });
const limiter = (limit, windowMs, keyed) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    ...(keyed ? { keyGenerator: (req) => String(req.extensionCredentialId ?? req.ip) } : {}),
  });

/** A sign-in code is short, so guessing is slowed down per address. */
const exchangeLimiter = limiter(10, 60_000);
/** One sign-in cannot ask for codes, model calls or documents without end. */
const codeLimiter = limiter(10, 60_000);
const modelLimiter = limiter(120, 60_000, true);
const documentLimiter = limiter(20, 60_000, true);

const configured = (_req, res, next) =>
  isExtensionConfigured()
    ? next()
    : res
        .status(404)
        .json({ error: { code: 'off', message: 'Browser tasks are off on this server.' } });

const auth = createExtensionAuth({ store: db, findUser: db.findUser });
const enabled = createExtensionEnabledCheck({
  getInstitutionByTenantId: db.getInstitutionByTenantId,
});
const handlers = createExtensionHandlers({
  config: getExtensionConfig,
  store: db,
  getInstitutionByTenantId: db.getInstitutionByTenantId,
});
const model = createModelHandlers({ config: getExtensionConfig, store: db });

/** Sign-in, settings and documents: Synapse's own pages call the first two, the extension the rest. */
const ext = express.Router();
ext.use(configured);
ext.post('/codes', codeLimiter, requireJwtAuth, handlers.createCode);
ext.delete('/tokens', requireJwtAuth, handlers.signOutEverywhere);
ext.post('/token', exchangeLimiter, handlers.exchange);
ext.delete('/token', auth, handlers.signOut);
ext.get('/settings', auth, handlers.settings);
ext.post('/extract', auth, enabled, documentLimiter, upload.single('file'), handlers.extract);

/** The model endpoint. Mounted before the app's JSON parser: requests carry screenshots past its 3 MB limit. */
const llm = express.Router();
llm.use(configured, auth, enabled);
llm.get('/models', model.listModels);
llm.post('/chat/completions', modelLimiter, express.json({ limit: '30mb' }), model.chatCompletions);

module.exports = { ext, llm };
