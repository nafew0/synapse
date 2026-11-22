const express = require('express');
const { createKbStorageHandlers } = require('@librechat/api');
const { requireJwtAuth } = require('~/server/middleware');
const requirePlatformSuperadmin = require('~/server/middleware/platformAdmin');
const db = require('~/models');

const handlers = createKbStorageHandlers({ methods: db });

const router = express.Router();
const guard = [requireJwtAuth, requirePlatformSuperadmin];

router.get('/kb/storage', guard, handlers.list);
router.get('/institutions/:tenantId/kb/storage', guard, handlers.institution);

module.exports = router;
