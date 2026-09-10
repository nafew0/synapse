const express = require('express');
const { logger } = require('@librechat/data-schemas');
const optionalJwtAuth = require('~/server/middleware/optionalJwtAuth');
const { requireJwtAuth } = require('~/server/middleware');
const { getBanner, markBannerSeen, dismissBanner } = require('~/models');

const router = express.Router();

const MAX_BANNER_ID_LENGTH = 128;

router.get('/', optionalJwtAuth, async (req, res) => {
  try {
    res.status(200).json(await getBanner(req.user));
  } catch (error) {
    logger.error('[getBanner] Error getting banner', error);
    res.status(500).json({ message: 'Error getting banner' });
  }
});

/**
 * @param {string} action
 * @param {(userId: string, bannerId: string) => Promise<void>} record
 */
const recordBannerView = (action, record) => async (req, res) => {
  const { bannerId } = req.params;
  if (!bannerId || bannerId.length > MAX_BANNER_ID_LENGTH) {
    return res.status(400).json({ message: 'Invalid banner id' });
  }
  try {
    await record(req.user.id, bannerId);
    res.status(204).end();
  } catch (error) {
    logger.error(`[banner:${action}] Error recording banner view`, error);
    res.status(500).json({ message: 'Error updating banner' });
  }
};

router.post('/:bannerId/seen', requireJwtAuth, recordBannerView('seen', markBannerSeen));
router.post('/:bannerId/dismiss', requireJwtAuth, recordBannerView('dismiss', dismissBanner));

module.exports = router;
