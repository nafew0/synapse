const express = require('express');
const { createUsagePackageHandlers, requirePackagesEditable } = require('@librechat/api');
const { bdrenConfig } = require('~/server/services/bdrenAllowance');
const { requireJwtAuth } = require('~/server/middleware');
const requirePlatformSuperadmin = require('~/server/middleware/platformAdmin');
const usageCatalog = require('~/server/services/usageCatalog');
const db = require('~/models');

const handlers = createUsagePackageHandlers({
  listUsagePackages: db.listUsagePackages,
  getUsagePackage: db.getUsagePackage,
  createUsagePackage: db.createUsagePackage,
  updateUsagePackage: db.updateUsagePackage,
  getUsagePricing: db.getUsagePricing,
  saveUsagePricing: db.saveUsagePricing,
  recordAuditEntry: db.recordAuditEntry,
  onChange: usageCatalog.invalidate,
});

const router = express.Router();
router.use(requireJwtAuth, requirePlatformSuperadmin, requirePackagesEditable(bdrenConfig));

router.get('/pricing', handlers.getPricing);
router.put('/pricing', handlers.updatePricing);
router.get('/', handlers.listPackages);
router.post('/', handlers.createPackage);
router.patch('/:key', handlers.updatePackage);
router.post('/:key/archive', handlers.archivePackage);

module.exports = router;
