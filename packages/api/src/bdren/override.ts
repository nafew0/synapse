import type { BdrenAllowancePayload } from '@librechat/data-schemas';
import { readEntry } from './store';

/** What support sees of bdren.ai's override for a person (scope, kind, package and dates only). */
export interface BdrenOverrideView {
  scope: string;
  kind: string;
  packageName: string | null;
  startsAt: string;
  endsAt: string;
}

/** The override in a cached allowance while it runs at `now`, or `null`. */
export function liveBdrenOverride(
  allowance: Pick<BdrenAllowancePayload, 'override'> | null | undefined,
  now: Date,
): BdrenOverrideView | null {
  const override = allowance?.override;
  if (!override) {
    return null;
  }
  const ends = Date.parse(override.ends_at);
  if (!Number.isFinite(ends) || ends <= now.getTime()) {
    return null;
  }
  return {
    scope: override.scope,
    kind: override.kind,
    packageName: override.package?.name ?? null,
    startsAt: override.starts_at,
    endsAt: override.ends_at,
  };
}

/** bdren.ai's live override for one user, from the cached allowance (no call to bdren.ai). */
export async function readBdrenOverride(
  userId: string,
  now: Date = new Date(),
): Promise<BdrenOverrideView | null> {
  const entry = await readEntry(userId);
  return liveBdrenOverride(entry?.allowance, now);
}
