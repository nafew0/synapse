const { logger } = require('@librechat/data-schemas');
const { getRequestAllowance } = require('./bdrenAllowance');
const { canAffordCredits, recordAuxiliaryCredits, resolveQuotaAccount } = require('./usageQuota');

/**
 * The meter a paid service (Firecrawl, OCR) is checked against and charged to, for one user.
 * `null` for users nothing is metered for (platform staff). A failed check lets the service run
 * and is logged, as a failed reservation does for chat; a failed charge is logged and never
 * fails the request. A charge is idempotent on its key.
 */
async function createServiceMeter(user) {
  const tenantId = user ? await resolveQuotaAccount(user) : null;
  if (!tenantId) {
    return null;
  }
  const userId = user.id ?? user._id?.toString();
  const memberPackage = user.usagePackage;
  const allowance = await getRequestAllowance(user, memberPackage);
  return {
    async canAfford(credits) {
      try {
        return await canAffordCredits({ tenantId, userId, memberPackage, allowance, credits });
      } catch (error) {
        logger.error('[serviceMeter] allowance check failed', error);
        return true;
      }
    },
    async charge(key, credits, label) {
      try {
        await recordAuxiliaryCredits({
          tenantId,
          userId,
          memberPackage,
          allowance,
          reservationKey: key,
          credits,
          metadata: { service: label },
        });
      } catch (error) {
        logger.error('[serviceMeter] allowance charge failed', error);
      }
    },
  };
}

module.exports = { createServiceMeter };
