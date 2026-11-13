const express = require('express');
const multer = require('multer');
const { createAdminKbHandlers } = require('@librechat/api');
const { KbLimits, SystemCapabilities } = require('@librechat/data-schemas');
const { resolveAdminTenant, requireTenant } = require('~/server/middleware/adminTenant');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { store, index } = require('~/server/services/kb');
const { requireJwtAuth } = require('~/server/middleware');
const db = require('~/models');

const router = express.Router();

const handlers = createAdminKbHandlers({
  methods: db,
  store,
  index,
  resolveTenant: requireTenant,
});

const singleFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: KbLimits.maxFileBytes, files: 1 },
}).single('file');

/** Turns multer's size error into the same 413 the handlers send. */
const acceptFile = (req, res, next) =>
  singleFile(req, res, (error) => {
    if (error?.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'Files can be at most 50 MB' });
    }
    if (error) {
      return res.status(400).json({ error: error.message });
    }
    return next();
  });

const canRead = requireCapability(SystemCapabilities.READ_KB);
const canManage = requireCapability(SystemCapabilities.MANAGE_KB);

router.use(requireJwtAuth, requireCapability(SystemCapabilities.ACCESS_ADMIN), resolveAdminTenant);

router.get('/documents', canRead, handlers.list);
router.post('/documents', canManage, acceptFile, resolveAdminTenant, handlers.upload);
router.get('/documents/:documentId/versions', canRead, handlers.versions);
router.post(
  '/documents/:documentId/versions',
  canManage,
  acceptFile,
  resolveAdminTenant,
  handlers.replace,
);
router.patch('/documents/:documentId', canManage, handlers.update);
router.delete('/documents/:documentId', canManage, handlers.remove);

module.exports = router;
