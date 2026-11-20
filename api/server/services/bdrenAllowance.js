const mongoose = require('mongoose');
const { logger, runAsSystem } = require('@librechat/data-schemas');
const {
  overrideActive,
  readBdrenConfig,
  allowanceSubjectFor,
  fallbackAllowance,
  createAllowanceClient,
  createAllowanceService,
  createWebhookHandler,
  normalizeOpenIdIssuer,
  quotaAccountFor,
} = require('@librechat/api');

const config = readBdrenConfig();
const service = createAllowanceService({ config, client: createAllowanceClient(config) });

/** The Synapse user behind a bdren.ai identity, as the meter knows them. */
async function findSubject(issuer, subject) {
  const user = await runAsSystem(() =>
    mongoose.models.User.findOne({ openidId: subject, openidIssuer: normalizeOpenIdIssuer(issuer) })
      .select('tenantId accountScope openidId openidIssuer')
      .lean()
      .exec(),
  );
  return allowanceSubjectFor(user, config);
}

/**
 * The allowance a request is metered against, or `null` when bdren.ai does not manage this user
 * (the link is off, they did not sign in through bdren.ai, or a support override is in force).
 * A failure reading it yields the Free fallback, never "no limit".
 */
async function getRequestAllowance(user, memberPackage = user?.usagePackage) {
  if (!config.enabled || overrideActive(memberPackage)) {
    return null;
  }
  const who = allowanceSubjectFor(user, config);
  if (!who) {
    return null;
  }
  try {
    return await service.getAllowance(who);
  } catch (error) {
    logger.error('[bdren] allowance lookup failed; using the Free fallback', error);
    return fallbackAllowance(config, new Date());
  }
}

const webhookHandler = createWebhookHandler({ config, service, findSubject });

module.exports = {
  bdrenConfig: config,
  bdrenAllowance: service,
  getRequestAllowance,
  webhookHandler,
  quotaAccountFor,
};
