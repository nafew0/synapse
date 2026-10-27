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

/**
 * The model id without its provider prefix, so `openai/gpt-5.6-luna` and
 * `gpt-5.6-luna` (the same model reached through different routes) match.
 */
export function bareModelId(value?: string | null): string {
  const id = normalize(value);
  return id.slice(id.lastIndexOf('/') + 1);
}

/**
 * Specs and models since replaced in `librechat.yaml`, mapped to the spec that
 * took their place, so past usage keeps the name members chose it by. Keys are
 * retired spec names and bare model ids; values are current spec names. Taken
 * from the file's history; an entry whose successor is gone is ignored.
 */
const RETIRED_SPEC_SUCCESSORS = new Map<string, string>([
  ['gpt-5.6-luna', 'gpt-6-luna'],
  ['anthropic/claude-haiku-4.5', 'anthropic/claude-haiku-5.5'],
  ['claude-haiku-4.5', 'anthropic/claude-haiku-5.5'],
  ['claude-haiku-4-5', 'anthropic/claude-haiku-5.5'],
  ['google/gemini-3.1-flash-image', 'google/gemini-3.1-flash-lite-image'],
  ['gemini-3.1-flash-image', 'google/gemini-3.1-flash-lite-image'],
]);

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
    if (!modelId) {
      continue;
    }

    for (const key of [modelId, bareModelId(modelId)]) {
      if (!labelByModelId.has(key)) {
        labelByModelId.set(key, spec.label);
      }
    }
  }

  return {
    labelBySpecName,
    labelByModelId,
    modelIds: Array.from(labelByModelId.keys()),
  };
}

function successorLabel(index: ModelLabelIndex, key: string): string | undefined {
  const successor = RETIRED_SPEC_SUCCESSORS.get(key);
  return successor ? index.labelBySpecName.get(successor) : undefined;
}

/**
 * The label the chat UI shows for a ledger row: the recorded spec, then the spec
 * that replaced it, then the model id with or without its provider prefix, then
 * the spec that replaced that model. `undefined` means a retired model.
 */
export function resolveModelLabel(
  index: ModelLabelIndex,
  { specName, modelId }: ResolveModelLabelParams,
): string | undefined {
  if (specName) {
    const bySpec = index.labelBySpecName.get(specName) ?? successorLabel(index, specName);
    if (bySpec) {
      return bySpec;
    }
  }

  const bare = bareModelId(modelId);
  return (
    index.labelByModelId.get(normalize(modelId)) ??
    index.labelByModelId.get(bare) ??
    successorLabel(index, bare)
  );
}
