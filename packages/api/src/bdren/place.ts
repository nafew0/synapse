import mongoose from 'mongoose';
import { logger, runAsSystem, InstitutionMembershipStatuses } from '@librechat/data-schemas';
import type { IUser } from '@librechat/data-schemas';
import type { Model } from 'mongoose';
import { userOwnsData } from './ownership';

/** A user as the login carries on with it after placement. */
export type MemberRecord = Record<string, unknown> & { tenantId?: string };

export type Placement =
  | { status: 'placed'; user: MemberRecord }
  /** The person already has an account in the target tenant; the one just created was removed. */
  | { status: 'duplicate'; existing: MemberRecord }
  | { status: 'refused' };

export interface PlacerDeps {
  /** The member service's activation: claims a seat and makes the member active, or throws. */
  activate: (args: { userId: string; tenantId: string }) => Promise<MemberRecord>;
}

export interface PlaceOptions {
  /** The account was created by this very login: when its identity already exists in the tenant, delete it. */
  replaceDuplicate?: boolean;
}

export type MemberPlacer = (
  userId: string,
  tenantId: string,
  options?: PlaceOptions,
) => Promise<Placement>;

const DUPLICATE_KEY = 11000;
const REFUSED: Placement = { status: 'refused' };

const users = (): Model<IUser> => mongoose.models.User as Model<IUser>;

/**
 * Puts a user who has no tenant into one as an active member. Every failure leaves them as they
 * were. The user is claimed first (tenant set, suspended) so a second login cannot also move
 * them; their own data is then re-checked, because a chat may have started in between.
 */
export function createMemberPlacer({ activate }: PlacerDeps): MemberPlacer {
  /** Back to no tenant, with the account scope the user had before the claim. */
  const rollback = (userId: string, tenantId: string, scope: IUser['accountScope']) =>
    runAsSystem(() =>
      users()
        .updateOne(
          { _id: userId, tenantId, membershipStatus: InstitutionMembershipStatuses.SUSPENDED },
          scope
            ? { $set: { accountScope: scope }, $unset: { tenantId: 1, membershipStatus: 1 } }
            : { $unset: { tenantId: 1, membershipStatus: 1, accountScope: 1 } },
        )
        .exec(),
    );

  async function resolveDuplicate(userId: string, replace: boolean): Promise<Placement> {
    if (!replace) {
      return REFUSED;
    }
    const mine = await runAsSystem(() => users().findById(userId).lean<IUser>().exec());
    if (!mine?.openidId) {
      return REFUSED;
    }
    const existing = await runAsSystem(() =>
      users()
        .findOne({ openidId: mine.openidId, openidIssuer: mine.openidIssuer, _id: { $ne: userId } })
        .lean<IUser>()
        .exec(),
    );
    if (!existing) {
      return REFUSED;
    }
    await runAsSystem(async () => {
      await mongoose.models.Balance?.deleteOne({ user: userId }).exec();
      await users().deleteOne({ _id: userId, tenantId: null }).exec();
    });
    logger.warn(`[bdren] removed duplicate account ${userId}; continuing as ${existing._id}`);
    return { status: 'duplicate', existing: existing as unknown as MemberRecord };
  }

  return async (userId, tenantId, options = {}) => {
    let scope: IUser['accountScope'];
    try {
      const before = await runAsSystem(() =>
        users()
          .findOneAndUpdate(
            { _id: userId, tenantId: null },
            {
              $set: {
                tenantId,
                accountScope: 'institution',
                membershipStatus: InstitutionMembershipStatuses.SUSPENDED,
              },
            },
            { new: false, projection: { accountScope: 1 } },
          )
          .lean<Pick<IUser, 'accountScope'>>()
          .exec(),
      );
      if (!before) {
        return REFUSED;
      }
      scope = before.accountScope;
    } catch (error) {
      if ((error as { code?: number })?.code === DUPLICATE_KEY) {
        return resolveDuplicate(userId, options.replaceDuplicate === true);
      }
      logger.error(`[bdren] claiming ${userId} for ${tenantId} failed`, error);
      return REFUSED;
    }
    try {
      if (await userOwnsData(userId)) {
        await rollback(userId, tenantId, scope);
        return REFUSED;
      }
      return { status: 'placed', user: await activate({ userId, tenantId }) };
    } catch (error) {
      logger.error(
        `[bdren] activating ${userId} in ${tenantId} failed; left without a tenant`,
        error,
      );
      await rollback(userId, tenantId, scope);
      return REFUSED;
    }
  };
}
