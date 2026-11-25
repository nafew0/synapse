const express = require('express');
const {
  limitsManagedElsewhere,
  requirePackagesEditable,
  createUsageAssignmentHandlers,
} = require('@librechat/api');
const { bdrenConfig } = require('~/server/services/bdrenAllowance');
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
  limitsManagedElsewhere: (user) => limitsManagedElsewhere(user, bdrenConfig),
});

const router = express.Router();
const guard = [requireJwtAuth, requirePlatformSuperadmin];
const institutionGuard = [...guard, requirePackagesEditable(bdrenConfig)];

router.put(
  '/institutions/:tenantId/usage-package',
  institutionGuard,
  handlers.setInstitutionPackage,
);
router.delete(
  '/institutions/:tenantId/usage-package',
  institutionGuard,
  handlers.clearInstitutionPackage,
);
router.put('/users/:userId/usage-package', guard, handlers.setMemberPackage);
router.delete('/users/:userId/usage-package', guard, handlers.clearMemberPackage);

module.exports = router;
