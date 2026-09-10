const { buildModelLabelIndex } = require('@librechat/api');
const { runAsSystem } = require('@librechat/data-schemas');
const { getAppConfig } = require('~/server/services/Config');
const { Agent } = require('~/db/models');

/**
 * Model specs name either a model or an agent; usage is only ever recorded
 * against the underlying model, so agent-backed specs need the agent's model
 * before their label can match a ledger row.
 */
async function getAgentModels(modelSpecs) {
  const agentIds = (modelSpecs?.list ?? []).map((spec) => spec?.preset?.agent_id).filter(Boolean);

  if (agentIds.length === 0) {
    return null;
  }

  const agents = await runAsSystem(() =>
    Agent.find({ id: { $in: agentIds } })
      .select('id model')
      .lean()
      .exec(),
  );

  return new Map(agents.map((agent) => [agent.id, agent.model]));
}

/**
 * Resolves the label index for a tenant, plus whether this caller may see the
 * unlabeled rows. Institution admins see the report their members' UI shows;
 * platform superadmins keep the raw, unfiltered view for billing.
 */
async function resolveUsageLabels(req) {
  const appConfig = await getAppConfig({ tenantId: req.adminTenantId });
  const modelSpecs = appConfig?.modelSpecs;
  const agentModels = await getAgentModels(modelSpecs);

  return {
    index: buildModelLabelIndex({ modelSpecs, agentModels }),
    restrictToLabeled: req.isPlatformSuperadmin !== true,
  };
}

module.exports = { resolveUsageLabels };
