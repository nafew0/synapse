import mongoose from 'mongoose';
import { runAsSystem } from '@librechat/data-schemas';
import type {
  IUsageBucket,
  IUsageReservation,
  BdrenAllowancePayload,
} from '@librechat/data-schemas';
import type { Model } from 'mongoose';
import type { AllowanceSubject, AllowanceWindow } from './types';
import { bucketRanges } from './windows';

const reservation = (): Model<IUsageReservation> =>
  mongoose.models.UsageReservation as Model<IUsageReservation>;
const bucket = (): Model<IUsageBucket> => mongoose.models.UsageBucket as Model<IUsageBucket>;

function windowOf(payload: BdrenAllowancePayload, name: 'month' | 'week'): AllowanceWindow | null {
  const range = (key: 'month' | 'week'): AllowanceWindow | null => {
    const raw = payload.windows[key];
    if (!raw) {
      return null;
    }
    const start = new Date(raw.start);
    const end = raw.end ? new Date(raw.end) : new Date('9999-12-31T00:00:00.000Z');
    return Number.isNaN(start.getTime()) ? null : { start, end };
  };
  const month = range('month');
  const week = range('week');
  if (name === 'month' || !month || !week) {
    return name === 'month' ? month : week;
  }
  return bucketRanges(month, week).week;
}

const DUPLICATE_KEY = 11000;
const RESERVATION_TTL_MS = 15 * 60 * 1000;

/**
 * Credits the member used in the old window, seeded once into the new one. The seed is a settled
 * reservation as well as a bucket increment, because the reconciliation job rebuilds buckets from
 * reservations and would otherwise erase it. The reservation key makes a replay a no-op.
 */
async function seed(
  who: AllowanceSubject,
  from: AllowanceWindow,
  to: AllowanceWindow,
  key: string,
  window: 'month' | 'week',
): Promise<number> {
  const scope = { tenantId: who.account, scopeType: 'member_credits', scopeKey: who.userId };
  const previous = await runAsSystem(() =>
    bucket()
      .findOne({ ...scope, periodStart: from.start })
      .lean<IUsageBucket>()
      .exec(),
  );
  const used = previous?.usedTokens ?? 0;
  if (used <= 0) {
    return 0;
  }
  const policyVersion = previous?.policyVersion ?? 1;
  const query = { ...scope, periodStart: to.start };
  const now = new Date();
  try {
    await runAsSystem(() =>
      reservation().create({
        tenantId: who.account,
        reservationKey: `bdren-carryover:${key}`,
        userId: who.userId,
        providerKey: 'bdren',
        modelKey: 'carry-over',
        policyVersion,
        periodStart: to.start,
        periodEnd: to.end,
        estimatedInputTokens: 0,
        outputTokenCap: 0,
        reservedTokens: 0,
        actualTokens: used,
        weight: 1,
        unit: 'credits',
        scopes: [
          {
            scopeType: 'member_credits',
            scopeKey: who.userId,
            periodStart: to.start,
            periodEnd: to.end,
            limit: null,
            window,
          },
        ],
        status: 'settled',
        settledAt: now,
        expiresAt: new Date(now.getTime() + RESERVATION_TTL_MS),
        metadata: { carryOver: true, fromPeriodStart: from.start },
      }),
    );
  } catch (error) {
    if ((error as { code?: number })?.code === DUPLICATE_KEY) {
      return 0;
    }
    throw error;
  }
  await runAsSystem(() =>
    bucket()
      .updateOne(
        query,
        {
          $setOnInsert: {
            ...query,
            periodEnd: to.end,
            policyVersion,
            reservedTokens: 0,
          },
          $inc: { usedTokens: used },
        },
        { upsert: true },
      )
      .exec(),
  );
  return used;
}

/**
 * Upgrade carry-over (D8): the credits already used in the old month and week count in the new
 * period's first month and week. Only windows that actually moved are seeded, only the member's own
 * bucket, and a replay of the same event adds nothing.
 */
export async function carryOverUsage(
  who: AllowanceSubject,
  before: BdrenAllowancePayload,
  after: BdrenAllowancePayload,
  eventId: string,
): Promise<{ month: number; week: number }> {
  const result = { month: 0, week: 0 };
  for (const name of ['month', 'week'] as const) {
    const from = windowOf(before, name);
    const to = windowOf(after, name);
    if (from && to && from.start.getTime() !== to.start.getTime()) {
      result[name] = await seed(who, from, to, `${eventId}:${name}`, name);
    }
  }
  return result;
}
