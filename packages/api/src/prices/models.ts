/** The parts of a loaded `librechat.yaml` / app config that name a model Synapse bills by token. */
export interface PriceConfigSource {
  endpoints?: {
    custom?: Array<{
      name?: string;
      titleModel?: string;
      models?: { default?: string[] };
      tokenConfig?: Record<string, unknown>;
    }>;
  };
  modelSpecs?: { list?: Array<{ name?: string; preset?: { model?: string } }> };
  memory?: { agent?: { model?: string } };
  summarization?: { model?: string };
}

/**
 * Ids priced outside OpenRouter's model list (image and voice models billed per image or per second).
 * They keep their yaml `tokenConfig` price and raise no "not listed" notice. Add one only with a reason.
 */
export const UNLISTED_OK: Readonly<Record<string, string>> = {
  'x-ai/grok-imagine-image-2.0':
    'image model priced per image in tokenConfig; not in /api/v1/models',
};

export type ModelUses = Map<string, Set<string>>;

const add = (uses: ModelUses, model: string | undefined, use: string): void => {
  if (!model || typeof model !== 'string') {
    return;
  }
  const id = model.trim();
  if (!id) {
    return;
  }
  const set = uses.get(id) ?? new Set<string>();
  set.add(use);
  uses.set(id, set);
};

/** Every model id the loaded config names, with where it is used. Voice and OCR models are priced per second or page, not here. */
export function collectConfiguredModels(config: PriceConfigSource | undefined | null): ModelUses {
  const uses: ModelUses = new Map();
  for (const endpoint of config?.endpoints?.custom ?? []) {
    const label = endpoint.name ?? 'custom';
    for (const model of endpoint.models?.default ?? []) {
      add(uses, model, `endpoint:${label}`);
    }
    add(uses, endpoint.titleModel, 'title');
  }
  for (const spec of config?.modelSpecs?.list ?? []) {
    add(uses, spec.preset?.model, `spec:${spec.name ?? 'unnamed'}`);
  }
  add(uses, config?.memory?.agent?.model, 'memory');
  add(uses, config?.summarization?.model, 'summarization');
  return uses;
}

/** Merges more models (agents, ledger) into a use map; only slash ids, which is how OpenRouter names models. */
export function addUsedModels(
  uses: ModelUses,
  models: Array<string | null | undefined>,
  use: string,
): void {
  for (const model of models) {
    if (model && model.includes('/')) {
      add(uses, model, use);
    }
  }
}
