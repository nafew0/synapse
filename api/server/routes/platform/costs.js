const express = require('express');
const { createSpendHandlers, createReconcileHandlers } = require('@librechat/api');
const { requireJwtAuth } = require('~/server/middleware');
const requirePlatformSuperadmin = require('~/server/middleware/platformAdmin');
const db = require('~/models');

const handlers = createSpendHandlers({
  getUsagePricing: db.getUsagePricing,
  saveUsagePricing: db.saveUsagePricing,
  recordAuditEntry: db.recordAuditEntry,
});

const reconcile = createReconcileHandlers({ recordAuditEntry: db.recordAuditEntry });

const router = express.Router();
router.use(requireJwtAuth, requirePlatformSuperadmin);

router.get('/summary', handlers.summary);
router.get('/institutions', handlers.institutions);
router.get('/institutions/:tenantId', handlers.institution);
router.get('/services', handlers.services);
router.get('/timeseries', handlers.timeseries);
router.get('/members', handlers.members);
router.get('/requests', handlers.requests);
router.get('/reconciliation', reconcile.view);
router.post('/reconciliation/refresh', reconcile.refresh);
router.put('/reconciliation/unstructured', reconcile.enterUnstructured);
router.get('/export.csv', handlers.exportCsv);
router.get('/settings', handlers.getSettings);
router.put('/settings', handlers.updateSettings);

module.exports = router;
