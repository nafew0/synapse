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
  createReportHandler,
  createExtensionEnabledCheck,
  getStorageSource,
} = require('@librechat/api');
const { requireJwtAuth, configMiddleware } = require('~/server/middleware');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const db = require('~/models');

const streamToBuffer = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

/** A file the user uploaded in Synapse, for a task handed over to the extension. */
const files = {
  find: async ({ user, fileId }) => {
    /** An empty projection, because `getFiles` leaves the extracted text out by default. */
    const found = await db.getFiles({ user, file_id: fileId }, null, {});
    return found?.[0] ?? null;
  },
  read: async (req, file) => {
    const { getDownloadStream } = getStrategyFunctions(getStorageSource(file));
    if (!getDownloadStream) {
      return null;
    }
    return streamToBuffer(await getDownloadStream(req, file.filepath));
  },
};

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
  files,
});
const model = createModelHandlers({ config: getExtensionConfig, store: db });
const report = createReportHandler({ store: db });

/** Sign-in, settings and documents: Synapse's own pages call the first two, the extension the rest. */
const ext = express.Router();
ext.use(configured);
ext.post('/codes', codeLimiter, requireJwtAuth, handlers.createCode);
ext.delete('/tokens', requireJwtAuth, handlers.signOutEverywhere);
ext.post('/token', exchangeLimiter, handlers.exchange);
ext.delete('/token', auth, handlers.signOut);
ext.get('/settings', auth, handlers.settings);
ext.post('/extract', auth, enabled, documentLimiter, upload.single('file'), handlers.extract);
/** A file already uploaded in Synapse, named by a task handed over from the composer. */
/** `configMiddleware`, because reading the original from storage needs the app's upload paths. */
ext.post(
  '/attachment',
  auth,
  enabled,
  documentLimiter,
  configMiddleware,
  express.json(),
  handlers.attachment,
);

/** A run the user chose to send when it went wrong: steps and outcomes only, kept 30 days. */
ext.post('/report', auth, enabled, documentLimiter, express.json({ limit: '256kb' }), report);

/** The model endpoint. Mounted before the app's JSON parser: requests carry screenshots past its 3 MB limit. */
const llm = express.Router();
llm.use(configured, auth, enabled);
llm.get('/models', model.listModels);
llm.post('/chat/completions', modelLimiter, express.json({ limit: '30mb' }), model.chatCompletions);

module.exports = { ext, llm };
