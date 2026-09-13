const express = require('express');
const { logger, SystemCapabilities } = require('@librechat/data-schemas');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { requireJwtAuth } = require('~/server/middleware');
const { getBanner } = require('~/models');

const router = express.Router();

/** Admin-panel announcements are only readable by users who can open the admin panel. */
router.get(
  '/',
  requireJwtAuth,
  requireCapability(SystemCapabilities.ACCESS_ADMIN),
  async (req, res) => {
    try {
      res.status(200).json(await getBanner(req.user, 'admin'));
    } catch (error) {
      logger.error('[getAdminBanner] Error getting banner', error);
      res.status(500).json({ message: 'Error getting banner' });
    }
  },
);

module.exports = router;
