const { buildModelLabelIndex } = require('@librechat/api');
const { runAsSystem } = require('@librechat/data-schemas');
const { getAppConfig } = require('~/server/services/Config');
const { canonicalizeModel } = require('./usageQuota');
const { Agent } = require('~/db/models');

/**
 * Model specs name either a model or an agent; usage is only ever recorded
 * against the underlying model, so agent-backed specs need the agent's model
 * before their label can match a ledger row or a quota bucket.
 */
async function getSpecAgents(modelSpecs) {
  const agentIds = (modelSpecs?.list ?? []).map((spec) => spec?.preset?.agent_id).filter(Boolean);

  if (agentIds.length === 0) {
    return new Map();
  }

  const agents = await runAsSystem(() =>
    Agent.find({ id: { $in: agentIds } })
      .select('id model provider')
      .lean()
      .exec(),
  );

  return new Map(agents.map((agent) => [agent.id, agent]));
}

async function getModelCatalog(tenantId) {
  const appConfig = await getAppConfig({ tenantId });
  const modelSpecs = appConfig?.modelSpecs;
  const agents = await getSpecAgents(modelSpecs);
  return { modelSpecs, agents };
}

/**
 * Resolves the label index for a tenant, plus whether this caller may see the
 * unlabeled rows. Institution admins see the report their members' UI shows;
 * platform superadmins keep the raw, unfiltered view for billing.
 */
async function resolveUsageLabels(req) {
  const { modelSpecs, agents } = await getModelCatalog(req.adminTenantId);
  const agentModels = new Map(Array.from(agents, ([id, agent]) => [id, agent.model]));

  return {
    index: buildModelLabelIndex({ modelSpecs, agentModels }),
    restrictToLabeled: req.isPlatformSuperadmin !== true,
  };
}

/**
 * The models a tenant's members can pick today, keyed exactly as the quota
 * engine keys a reservation — through `canonicalizeModel` — so each one lines
 * up with its bucket. An agent-backed spec reserves against its agent's model.
 */
async function getQuotaModelSources(tenantId) {
  const { modelSpecs, agents } = await getModelCatalog(tenantId);

  return (modelSpecs?.list ?? []).flatMap((spec) => {
    if (!spec?.label || !spec.preset) {
      return [];
    }

    const agent = spec.preset.agent_id ? agents.get(spec.preset.agent_id) : undefined;
    const model = agent?.model ?? spec.preset.model;
    if (!model) {
      return [];
    }

    const provider = agent?.provider ?? spec.preset.endpointType ?? spec.preset.endpoint;
    const { modelKey } = canonicalizeModel({ provider, model });
    return modelKey ? [{ modelKey, modelId: model, label: spec.label }] : [];
  });
}

module.exports = { getQuotaModelSources, resolveUsageLabels };
