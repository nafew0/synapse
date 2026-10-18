const { createUsageCatalog } = require('@librechat/api');
const models = require('~/db/models');

/**
 * One cache per process. Package writes here drop it; other processes pick changes up within
 * the TTL. Reads the models directly, as the quota engine does, so loading it stays light.
 */
module.exports = createUsageCatalog({
  listUsagePackages: ({ includeArchived = false } = {}) =>
    models.UsagePackage.find(includeArchived ? {} : { active: true })
      .sort({ sortOrder: 1, createdAt: 1 })
      .lean()
      .exec(),
  getUsagePricing: () => models.UsagePricing.findOne({ key: 'default' }).lean().exec(),
});
