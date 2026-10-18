const express = require('express');
const { createUsageAssignmentHandlers } = require('@librechat/api');
const { requireJwtAuth } = require('~/server/middleware');
const requirePlatformSuperadmin = require('~/server/middleware/platformAdmin');
const db = require('~/models');

const handlers = createUsageAssignmentHandlers({
  getUsagePackage: db.getUsagePackage,
  getQuotaOwner: db.getQuotaOwner,
  setQuotaOwnerPackage: db.setQuotaOwnerPackage,
  getUserById: db.getUserById,
  updateUser: db.updateUser,
  recordAuditEntry: db.recordAuditEntry,
});

const router = express.Router();
const guard = [requireJwtAuth, requirePlatformSuperadmin];

router.put('/institutions/:tenantId/usage-package', guard, handlers.setInstitutionPackage);
router.delete('/institutions/:tenantId/usage-package', guard, handlers.clearInstitutionPackage);
router.put('/users/:userId/usage-package', guard, handlers.setMemberPackage);
router.delete('/users/:userId/usage-package', guard, handlers.clearMemberPackage);

module.exports = router;
