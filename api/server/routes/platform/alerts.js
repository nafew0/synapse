const express = require('express');
const { createAlertHandlers } = require('@librechat/api');
const { requireJwtAuth } = require('~/server/middleware');
const requirePlatformSuperadmin = require('~/server/middleware/platformAdmin');

const handlers = createAlertHandlers();

const router = express.Router();
router.use(requireJwtAuth, requirePlatformSuperadmin);

router.get('/', handlers.list);
router.post('/check', handlers.check);
router.post('/seen', handlers.seen);
router.post('/:id/seen', handlers.seen);

module.exports = router;
