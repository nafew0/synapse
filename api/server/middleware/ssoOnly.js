const { logger } = require('@librechat/data-schemas');
const {
  SsoRefusals,
  readSsoOnly,
  mayHoldSession,
  sendSsoRefusal,
  refuseWhenSsoOnly,
} = require('@librechat/api');
const { isPlatformSuperadmin } = require('~/server/services/platformAdmin');
const { getUserById } = require('~/models');

const TEMP_USER_FIELDS = '_id email tenantId provider openidId openidIssuer';

const refuseAdmin = (res) => sendSsoRefusal(res, SsoRefusals.adminLogin);

/**
 * synapse-admin while SSO-only is on is for platform superadmins only. `refuse` answers everyone
 * else (JSON by default; the OpenID callback redirects back to the admin panel instead).
 */
function superadminOnlyWhenSsoOnly(refuse = refuseAdmin) {
  return async (req, res, next) => {
    if (!readSsoOnly().enabled) {
      return next();
    }
    try {
      if (req.user && (await isPlatformSuperadmin(req.user))) {
        return next();
      }
      logger.warn('[ssoOnly] refused synapse-admin access for a non-superadmin', {
        userId: req.user?._id?.toString?.() ?? req.user?.id,
        path: req.originalUrl?.split('?')[0],
      });
      return refuse(res);
    } catch (error) {
      logger.error('[ssoOnly] superadmin check failed', error);
      return refuse(res);
    }
  };
}

/** Admin password login and `/api/admin/verify` while SSO-only is on. Runs after authentication. */
const requireSuperadminWhenSsoOnly = superadminOnlyWhenSsoOnly();

/**
 * 2FA completion while SSO-only is on: the temporary token must belong to an SSO account or a
 * platform superadmin, so no other password login can be finished into a session.
 */
async function requireTempUserAllowed(req, res, next) {
  const userId = req.user?.id ?? req.user?._id?.toString?.();
  if (!readSsoOnly().enabled || !userId) {
    return next();
  }
  try {
    const user = await getUserById(userId, TEMP_USER_FIELDS);
    if (!user || (await mayHoldSession(user, isPlatformSuperadmin))) {
      return next();
    }
    return sendSsoRefusal(res, SsoRefusals.adminLogin);
  } catch (error) {
    logger.error('[ssoOnly] 2FA user check failed', error);
    return sendSsoRefusal(res, SsoRefusals.adminLogin);
  }
}

module.exports = {
  superadminOnlyWhenSsoOnly,
  requireSuperadminWhenSsoOnly,
  requireTempUserAllowed,
  refuseLogin: refuseWhenSsoOnly(SsoRefusals.login),
  refuseRegistration: refuseWhenSsoOnly(SsoRefusals.registration),
  refusePasswordReset: refuseWhenSsoOnly(SsoRefusals.passwordReset),
  refuseEmailVerification: refuseWhenSsoOnly(SsoRefusals.emailVerification),
  refuseInvitation: refuseWhenSsoOnly(SsoRefusals.invitation),
  refuseManaged: refuseWhenSsoOnly(SsoRefusals.managed),
};
