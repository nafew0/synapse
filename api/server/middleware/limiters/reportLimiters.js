const rateLimit = require('express-rate-limit');
const { logger } = require('@librechat/data-schemas');
const { PublicErrorCodes } = require('librechat-data-provider');
const { limiterCache } = require('@librechat/api');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const getEnvironmentVariables = () => ({
  reportHourMax: parseInt(process.env.ISSUE_REPORT_HOUR_MAX) || 5,
  reportDayMax: parseInt(process.env.ISSUE_REPORT_DAY_MAX) || 20,
});

/**
 * Over-limit reports are logged, not recorded as violations: a user pressing
 * "Report an issue" too often should not move them toward a ban.
 */
const createReportHandler = (window, max) => (req, res) => {
  logger.warn(`[reportLimiter] user ${req.user?.id} exceeded ${max} issue reports per ${window}`);
  res.status(429).json({ code: PublicErrorCodes.SERVICE_BUSY });
};

const userKey = (req) => req.user?.id;

const createReportLimiters = () => {
  const { reportHourMax, reportDayMax } = getEnvironmentVariables();

  const reportHourLimiter = rateLimit({
    windowMs: HOUR_MS,
    max: reportHourMax,
    handler: createReportHandler('hour', reportHourMax),
    keyGenerator: userKey,
    store: limiterCache('report_hour_limiter'),
  });
  const reportDayLimiter = rateLimit({
    windowMs: DAY_MS,
    max: reportDayMax,
    handler: createReportHandler('day', reportDayMax),
    keyGenerator: userKey,
    store: limiterCache('report_day_limiter'),
  });

  return { reportHourLimiter, reportDayLimiter };
};

module.exports = { createReportLimiters };
