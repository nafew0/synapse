import mongoose from 'mongoose';
import { logger, runAsSystem, InstitutionMembershipStatuses } from '@librechat/data-schemas';
import type { IInstitution, IUser } from '@librechat/data-schemas';
import type { Model } from 'mongoose';

/** What giving a move's seat back did: `drift` means the counter was already at zero. */
export type SeatRelease = 'released' | 'already' | 'drift';

/** Seat operations remembered per institution; older ones can no longer be retried anyway. */
const SEAT_OPS_KEPT = 500;

const institutions = (): Model<IInstitution> => mongoose.models.Institution as Model<IInstitution>;
const users = (): Model<IUser> => mongoose.models.User as Model<IUser>;

const remember = (op: string) => ({ $push: { seatOps: { $each: [op], $slice: -SEAT_OPS_KEPT } } });

/** Fills a missing counter from the active members, as the member service does. */
async function ensureCounter(tenantId: string): Promise<void> {
  const institution = await institutions()
    .findOne({ tenantId })
    .select('stats')
    .lean<IInstitution>()
    .exec();
  if (!institution || typeof institution.stats?.activeMembers === 'number') {
    return;
  }
  const active = await users()
    .countDocuments({
      tenantId,
      membershipStatus: { $in: [InstitutionMembershipStatuses.ACTIVE, null] },
    })
    .exec();
  await institutions()
    .updateOne(
      { tenantId, 'stats.activeMembers': { $not: { $type: 'number' } } },
      { $set: { 'stats.activeMembers': active } },
    )
    .exec();
}

const applied = (tenantId: string, op: string) =>
  institutions().exists({ tenantId, seatOps: op }).exec();

/**
 * Takes a seat for one move, once: a retried move finds its operation recorded and does not take a
 * second seat. `false` when the institution is full.
 */
export async function reserveMoveSeat(tenantId: string, moveId: string): Promise<boolean> {
  return runAsSystem(async () => {
    await ensureCounter(tenantId);
    const op = `reserve:${moveId}`;
    const taken = await institutions()
      .updateOne(
        {
          tenantId,
          seatOps: { $ne: op },
          $or: [
            { 'limits.maxActiveMembers': null },
            {
              $expr: {
                $lt: [{ $ifNull: ['$stats.activeMembers', 0] }, '$limits.maxActiveMembers'],
              },
            },
          ],
        },
        { $inc: { 'stats.activeMembers': 1 }, ...remember(op) },
      )
      .exec();
    return taken.modifiedCount === 1 || (await applied(tenantId, op)) != null;
  });
}

/**
 * Gives one move's seat back, once. A counter already at zero is not quietly accepted: it is
 * recorded as applied (so the move can finish) and reported as `drift` for a person to look at.
 */
export async function releaseMoveSeat(tenantId: string, moveId: string): Promise<SeatRelease> {
  return runAsSystem(async () => {
    await ensureCounter(tenantId);
    const op = `release:${moveId}`;
    const released = await institutions()
      .updateOne(
        { tenantId, seatOps: { $ne: op }, 'stats.activeMembers': { $gt: 0 } },
        { $inc: { 'stats.activeMembers': -1 }, ...remember(op) },
      )
      .exec();
    if (released.modifiedCount === 1) {
      return 'released';
    }
    if ((await applied(tenantId, op)) != null) {
      return 'already';
    }
    await institutions().updateOne({ tenantId }, remember(op)).exec();
    logger.error(
      `[bdren] seat counter drift: ${tenantId} had no active seat to give back for move ${moveId}`,
    );
    return 'drift';
  });
}
