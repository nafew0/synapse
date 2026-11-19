import type { TEphemeralAgent, TModelSpec } from 'librechat-data-provider';

/** Tool switches a request may only turn on through the model spec once the spec hides the badge row. */
const SPEC_LOCKED_TOGGLES = [
  'mcp',
  'web_search',
  'file_search',
  'execute_code',
  'memory',
  'ask_user_question',
] as const satisfies ReadonlyArray<keyof TEphemeralAgent>;

type SpecLockedToggle = (typeof SPEC_LOCKED_TOGGLES)[number];

/**
 * Removes the tool switches a request is not allowed to set for the selected model spec.
 *
 * The code sandbox is decided by the spec alone whenever a spec is selected: a request that sets
 * `execute_code` on a spec without `executeCode` must not reach the sandbox. When the spec also
 * hides the badge row, the user has no control over any tool, so every switch comes from the spec.
 * Without a spec the request's switches stand, as before.
 */
export function scopeEphemeralAgent<T extends Partial<Record<SpecLockedToggle, unknown>>>(
  ephemeralAgent: T | null | undefined,
  modelSpec: TModelSpec | null | undefined,
): T | undefined {
  if (!ephemeralAgent) {
    return undefined;
  }
  if (!modelSpec) {
    return ephemeralAgent;
  }
  const locked: ReadonlyArray<SpecLockedToggle> =
    modelSpec.hideBadgeRow === true ? SPEC_LOCKED_TOGGLES : ['execute_code'];
  const scoped = { ...ephemeralAgent };
  for (const key of locked) {
    delete scoped[key];
  }
  return scoped;
}
