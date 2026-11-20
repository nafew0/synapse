import mongoose from 'mongoose';
import { runAsSystem } from '@librechat/data-schemas';
import type { IUser, IUsageDaily } from '@librechat/data-schemas';
import type { Model, Types } from 'mongoose';
import type { Response } from 'express';
import type { AdminRequest } from './types';
import { CREDITS_PER_USD } from '~/usage/packages';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 93;
const MAX_ROWS = 20000;

const dayNumber = (day: string): number => Date.parse(`${day}T00:00:00Z`) / 86_400_000;

interface Row {
  _id: { day: string; user: Types.ObjectId | null; service: string; taskType: string | null };
  requests: number;
  units: number;
  credits: number;
}

/**
 * Per member per day per service/task: requests, units and credits used (the allowance's unit, not
 * BdREN's provider cost). The tenant is `req.bdren.tenantId`; the range is capped at 93 days.
 */
export interface UsageHandlers {
  daily: (req: AdminRequest, res: Response) => Promise<void>;
}

export function createUsageHandlers(): UsageHandlers {
  async function daily(req: AdminRequest, res: Response): Promise<void> {
    const { tenantId } = req.bdren!;
    const start = String(req.query.start ?? '');
    const end = String(req.query.end ?? '');
    const span = dayNumber(end) - dayNumber(start);
    if (
      !DAY.test(start) ||
      !DAY.test(end) ||
      !Number.isFinite(span) ||
      span < 0 ||
      span >= MAX_DAYS
    ) {
      res
        .status(400)
        .json({ error: `start and end must be YYYY-MM-DD, at most ${MAX_DAYS} days apart` });
      return;
    }
    const rows = await runAsSystem(() =>
      (mongoose.models.UsageDaily as Model<IUsageDaily>).aggregate<Row>([
        { $match: { tenantId, day: { $gte: start, $lte: end }, billable: true } },
        {
          $group: {
            _id: { day: '$day', user: '$user', service: '$service', taskType: '$taskType' },
            requests: { $sum: '$requests' },
            units: { $sum: '$units' },
            credits: { $sum: { $multiply: ['$costUsd', CREDITS_PER_USD] } },
          },
        },
        { $sort: { '_id.day': 1, '_id.user': 1, '_id.service': 1 } },
        { $limit: MAX_ROWS + 1 },
      ]),
    );
    const truncated = rows.length > MAX_ROWS;
    const shown = rows.slice(0, MAX_ROWS);
    const userIds = [...new Set(shown.map((r) => r._id.user?.toString()).filter(Boolean))];
    const users = userIds.length
      ? await runAsSystem(() =>
          (mongoose.models.User as Model<IUser>)
            .find({ tenantId, _id: { $in: userIds } })
            .select('openidId name email')
            .lean<(Pick<IUser, 'openidId' | 'name' | 'email'> & { _id: Types.ObjectId })[]>()
            .exec(),
        )
      : [];
    const byId = new Map(users.map((u) => [u._id.toString(), u]));
    res.json({
      start,
      end,
      truncated,
      rows: shown.map((r) => {
        const user = r._id.user ? byId.get(r._id.user.toString()) : undefined;
        return {
          day: r._id.day,
          member: user
            ? {
                userId: String(user._id),
                subject: user.openidId ?? null,
                name: user.name,
                email: user.email,
              }
            : null,
          service: r._id.service,
          taskType: r._id.taskType ?? null,
          requests: r.requests,
          units: r.units,
          credits: Math.round(r.credits),
        };
      }),
    });
  }
  return { daily };
}
