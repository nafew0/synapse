import mongoose from 'mongoose';
import { runAsSystem } from '@librechat/data-schemas';
import type { SpendRow } from './types';

const CREDITS_PER_USD = 1_000_000;
const DAY_MS = 86_400_000;
export const ROLLUP_TIMEZONE = 'Asia/Dhaka';

interface SpendGroup {
  _id: { id: unknown; day: string };
  credits: number;
}

/** Calendar day (`YYYY-MM-DD`) of an instant in the rollup timezone. */
export function dayInRollupZone(instant: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ROLLUP_TIMEZONE }).format(instant);
}

function perDay(scope: SpendRow['scope'], since: Date, field: 'tenantId' | 'user') {
  return [
    { $match: { createdAt: { $gte: since }, tokenValue: { $lt: 0 }, [field]: { $ne: null } } },
    {
      $group: {
        _id: {
          id: `$${field}`,
          day: {
            $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: ROLLUP_TIMEZONE },
          },
        },
        credits: { $sum: { $multiply: ['$tokenValue', -1] } },
      },
    },
    { $project: { _id: 1, credits: 1, scope: { $literal: scope } } },
  ];
}

const toRows = (scope: SpendRow['scope'], groups: SpendGroup[]): SpendRow[] =>
  groups.map((group) => ({
    scope,
    id: String(group._id.id),
    day: group._id.day,
    usd: group.credits / CREDITS_PER_USD,
  }));

/**
 * Spend per institution and per user for each day since `since`, read from the ledger. The ledger holds
 * every paid service, so this is the whole platform bill, not only OpenRouter.
 */
export async function loadSpend(since: Date): Promise<SpendRow[]> {
  const { Transaction } = mongoose.models;
  const [institutions, users] = await runAsSystem(() =>
    Promise.all([
      Transaction.aggregate<SpendGroup>(perDay('institution', since, 'tenantId')),
      Transaction.aggregate<SpendGroup>(perDay('user', since, 'user')),
    ]),
  );
  return [...toRows('institution', institutions), ...toRows('user', users)];
}

/** Average spend per day over the `days` before today, across the whole platform. */
export function averageDailyUsd(rows: SpendRow[], today: string, days: number): number {
  const total = rows
    .filter((row) => row.scope === 'institution' && row.day !== today)
    .reduce((sum, row) => sum + row.usd, 0);
  return days > 0 ? total / days : 0;
}

export const windowStart = (now: Date, days: number): Date =>
  new Date(now.getTime() - (days + 1) * DAY_MS);

interface Labelled {
  _id: unknown;
  name?: string;
  email?: string;
}

/** Names for the scopes that spiked, so an alert reads "Dhaka University" rather than a tenant id. */
export async function loadLabels(scopeKeys: string[]): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  const tenantIds = scopeKeys
    .filter((key) => key.startsWith('institution:'))
    .map((key) => key.slice(12));
  const userIds = scopeKeys.filter((key) => key.startsWith('user:')).map((key) => key.slice(5));
  const { Institution, User } = mongoose.models;
  const [institutions, users] = await runAsSystem(() =>
    Promise.all([
      tenantIds.length
        ? Institution.find({ tenantId: { $in: tenantIds } })
            .select('tenantId name')
            .lean()
        : [],
      userIds.length
        ? User.find({ _id: { $in: userIds } })
            .select('name email')
            .lean()
        : [],
    ]),
  );
  for (const institution of institutions as Array<Labelled & { tenantId?: string }>) {
    if (institution.name) labels.set(`institution:${institution.tenantId}`, institution.name);
  }
  for (const user of users as Labelled[]) {
    const label = user.name || user.email;
    if (label) labels.set(`user:${String(user._id)}`, label);
  }
  return labels;
}
