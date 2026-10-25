const express = require('express');
const { SystemCapabilities } = require('@librechat/data-schemas');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { requireJwtAuth } = require('~/server/middleware');
const {
  HttpError,
  exportMemberUsageCsv,
  exportUsageCsv,
  getUsageSummary,
  getUsageTimeseries,
  listUsageByMember,
  listUsageByModel,
} = require('~/server/services/institutionUsage');
const { resolveUsageLabels } = require('~/server/services/usageLabels');

const router = express.Router();

const requireAdminAccess = requireCapability(SystemCapabilities.ACCESS_ADMIN);
const requireReadUsage = requireCapability(SystemCapabilities.READ_USAGE);

const { resolveAdminTenant, requireTenant } = require('~/server/middleware/adminTenant');

function handleError(res, error, fallback) {
  if (error instanceof HttpError) {
    return res.status(error.statusCode).json({ error: error.message });
  }
  return res.status(500).json({ error: fallback });
}

router.use(requireJwtAuth, requireAdminAccess, requireReadUsage, resolveAdminTenant);

router.get('/summary', async (req, res) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) {
    return;
  }

  try {
    const result = await getUsageSummary({
      tenantId,
      start: req.query.start,
      end: req.query.end,
      labels: await resolveUsageLabels(req),
    });
    return res.status(200).json(result);
  } catch (error) {
    return handleError(res, error, 'Failed to load usage summary');
  }
});

router.get('/members', async (req, res) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) {
    return;
  }

  try {
    const result = await listUsageByMember({
      tenantId,
      start: req.query.start,
      end: req.query.end,
      limit: req.query.limit,
      offset: req.query.offset,
      query: req.query.q,
      labels: await resolveUsageLabels(req),
    });
    return res.status(200).json(result);
  } catch (error) {
    return handleError(res, error, 'Failed to load member usage');
  }
});

router.get('/models', async (req, res) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) {
    return;
  }

  try {
    const result = await listUsageByModel({
      tenantId,
      start: req.query.start,
      end: req.query.end,
      limit: req.query.limit,
      offset: req.query.offset,
      query: req.query.q,
      labels: await resolveUsageLabels(req),
    });
    return res.status(200).json(result);
  } catch (error) {
    return handleError(res, error, 'Failed to load model usage');
  }
});

router.get('/timeseries', async (req, res) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) {
    return;
  }

  try {
    const result = await getUsageTimeseries({
      tenantId,
      start: req.query.start,
      end: req.query.end,
    });
    return res.status(200).json(result);
  } catch (error) {
    return handleError(res, error, 'Failed to load usage timeseries');
  }
});

router.get('/export.csv', async (req, res) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) {
    return;
  }

  /** Superadmins keep the full transaction ledger; institution admins get one row per member. */
  const isPlatformSuperadmin = req.isPlatformSuperadmin === true;
  const exportCsv = isPlatformSuperadmin ? exportUsageCsv : exportMemberUsageCsv;
  const prefix = isPlatformSuperadmin ? 'usage' : 'member-usage';

  try {
    const { csv } = await exportCsv({
      tenantId,
      start: req.query.start,
      end: req.query.end,
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${prefix}-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    res.status(200).send(csv);
  } catch (error) {
    return handleError(res, error, 'Failed to export usage CSV');
  }
});

module.exports = router;
