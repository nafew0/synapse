const express = require('express');
const {
  createPriceHandlers,
  priceModels,
  priceStore,
  collectModelsInUse,
} = require('@librechat/api');
const { requireJwtAuth } = require('~/server/middleware');
const requirePlatformSuperadmin = require('~/server/middleware/platformAdmin');
const { getAppConfig } = require('~/server/services/Config');
const db = require('~/models');

const handlers = createPriceHandlers({
  models: priceModels,
  store: priceStore,
  syncDeps: () => ({
    collectModels: async () => collectModelsInUse(await getAppConfig({ baseOnly: true })),
  }),
  recordAuditEntry: db.recordAuditEntry,
});

const router = express.Router();
router.use(requireJwtAuth, requirePlatformSuperadmin);

/** Model ids contain a slash, so clients send them percent-encoded (`anthropic%2Fclaude-haiku-5.5`). */
router.get('/', handlers.list);
router.get('/changes', handlers.changes);
router.post('/changes/:id/seen', handlers.markSeen);
router.post('/sync', handlers.sync);
router.get('/:modelId/diff', handlers.diff);
router.put('/:modelId/override', handlers.setOverride);
router.delete('/:modelId/override', handlers.clearOverride);
router.get('/:modelId', handlers.detail);

module.exports = router;
