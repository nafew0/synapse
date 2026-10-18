const express = require('express');
const { logger } = require('@librechat/data-schemas');
const { quotaAccountFor } = require('@librechat/api');
const { requireJwtAuth } = require('~/server/middleware');
const { getMemberQuota } = require('~/server/services/usageQuota');

const router = express.Router();

/**
 * The signed-in user's own remaining allowance, for the usage indicator and the
 * hard-wall message. Scoped to the caller — never accepts a user id — and reads
 * only the current windows, so it cannot serve usage history.
 */
router.get('/', requireJwtAuth, async (req, res) => {
  const tenantId = quotaAccountFor(req.user);
  if (!tenantId) {
    /** Platform staff have no quota account, so no usage policy applies; the UI shows no allowance
     *  rather than a zeroed one, which would read as "exhausted". */
    return res.sendStatus(204);
  }
  try {
    const quota = await getMemberQuota({
      tenantId,
      userId: req.user.id,
      memberPackage: req.user.usagePackage,
    });
    return quota ? res.status(200).json(quota) : res.sendStatus(204);
  } catch (error) {
    if (error?.details?.code === 'INSTITUTION_NOT_FOUND') {
      return res.sendStatus(204);
    }
    logger.error('[quota] failed to read member quota', error);
    return res.status(500).json({ error: 'Failed to load usage quota' });
  }
});

module.exports = router;
