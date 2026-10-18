import type { EndpointTokenConfig } from '~/types';

/** A configured endpoint and the models it offers. */
export interface PricedEndpoint {
  name: string;
  models: string[];
  tokenConfig?: EndpointTokenConfig;
}

export interface UnpricedModel {
  endpoint: string;
  model: string;
  /** The rate key the model fell back to, or `null` when nothing matched. */
  matchedKey: string | null;
}

type GetValueKey = (model: string, endpoint?: string) => string | undefined;

/** A key names the model itself when only a date or version suffix is left over, e.g. `deepseek-v4-flash` for `deepseek-v4-flash-0731`. */
const SUFFIX = /^-\d{4,8}$/;

function baseModelName(model: string): string {
  const slash = model.lastIndexOf('/');
  return (slash >= 0 ? model.slice(slash + 1) : model).toLowerCase();
}

function namesModel(model: string, key: string): boolean {
  const name = baseModelName(model);
  const normalizedKey = key.toLowerCase();
  if (name === normalizedKey) {
    return true;
  }
  return name.startsWith(normalizedKey) && SUFFIX.test(name.slice(normalizedKey.length));
}

/**
 * Served models whose price would come from a family fallback (`claude-`, `gemini-3`) instead of
 * their own rate. Usage credits are charged at these rates, so every served model needs either a
 * `tokenConfig` entry on its endpoint or a rate key that names it exactly.
 */
export function findUnpricedModels(
  endpoints: PricedEndpoint[],
  getValueKey: GetValueKey,
): UnpricedModel[] {
  return endpoints.flatMap(({ name, models, tokenConfig }) =>
    models
      .filter((model) => tokenConfig?.[model] == null)
      .map((model) => ({ endpoint: name, model, matchedKey: getValueKey(model, name) ?? null }))
      .filter(({ model, matchedKey }) => matchedKey == null || !namesModel(model, matchedKey)),
  );
}
