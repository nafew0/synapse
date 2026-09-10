import type { TModelSpec, TSpecsConfig } from 'librechat-data-provider';

export interface ModelLabelIndex {
  labelBySpecName: Map<string, string>;
  labelByModelId: Map<string, string>;
  modelIds: string[];
}

export interface BuildModelLabelIndexParams {
  modelSpecs?: Pick<TSpecsConfig, 'list'> | null;
  /** `agent_id` -> the model that agent runs on, for specs that name an agent
   *  instead of a model. Usage is recorded against the underlying model, so
   *  without this an agent-backed spec never matches a ledger row. */
  agentModels?: Map<string, string> | null;
}

export interface ResolveModelLabelParams {
  specName?: string | null;
  modelId?: string | null;
}

function normalize(value?: string | null): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function resolveSpecModelId(spec: TModelSpec, agentModels?: Map<string, string> | null): string {
  const declared = normalize(spec.preset?.model);
  if (declared) {
    return declared;
  }

  const agentId = spec.preset?.agent_id;
  if (!agentId || !agentModels) {
    return '';
  }

  return normalize(agentModels.get(agentId));
}

/**
 * Indexes the labels the chat UI shows, keyed both by spec name (the exact
 * choice, recorded on the conversation) and by model id (the fallback, when the
 * conversation is gone). Specs are read in list order and the first to claim a
 * model id keeps it, so two specs sharing one model resolve deterministically.
 */
export function buildModelLabelIndex({
  modelSpecs,
  agentModels,
}: BuildModelLabelIndexParams): ModelLabelIndex {
  const labelBySpecName = new Map<string, string>();
  const labelByModelId = new Map<string, string>();
  const list = modelSpecs?.list ?? [];

  for (const spec of list) {
    if (!spec?.name || !spec.label) {
      continue;
    }

    if (!labelBySpecName.has(spec.name)) {
      labelBySpecName.set(spec.name, spec.label);
    }

    const modelId = resolveSpecModelId(spec, agentModels);
    if (!modelId || labelByModelId.has(modelId)) {
      continue;
    }

    labelByModelId.set(modelId, spec.label);
  }

  return {
    labelBySpecName,
    labelByModelId,
    modelIds: Array.from(labelByModelId.keys()),
  };
}

export function resolveModelLabel(
  index: ModelLabelIndex,
  { specName, modelId }: ResolveModelLabelParams,
): string | undefined {
  if (specName) {
    const bySpec = index.labelBySpecName.get(specName);
    if (bySpec) {
      return bySpec;
    }
  }

  return index.labelByModelId.get(normalize(modelId));
}
