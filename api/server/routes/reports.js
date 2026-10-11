const express = require('express');
const { runAsSystem } = require('@librechat/data-schemas');
const { createIssueReportHandlers } = require('@librechat/api');
const { createReportLimiters } = require('~/server/middleware/limiters');
const { requireJwtAuth } = require('~/server/middleware');
const sendEmail = require('~/server/utils/sendEmail');
const db = require('~/models');

const router = express.Router();

const { reportHourLimiter, reportDayLimiter } = createReportLimiters();

const handlers = createIssueReportHandlers({
  sendEmail,
  getInstitutionName: async (tenantId) => {
    const institution = await runAsSystem(() => db.getInstitutionByTenantId(tenantId, 'name'));
    return institution?.name;
  },
});

router.post('/', requireJwtAuth, reportHourLimiter, reportDayLimiter, handlers.createReport);

module.exports = router;
