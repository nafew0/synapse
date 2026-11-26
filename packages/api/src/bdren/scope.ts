import mongoose from 'mongoose';
import { SystemRoles } from 'librechat-data-provider';
import { runAsSystem } from '@librechat/data-schemas';
import type { IUser } from '@librechat/data-schemas';
import type { Model } from 'mongoose';

export const PLATFORM_ROLES: ReadonlySet<string> = new Set<string>([
  SystemRoles.ADMIN,
  'PLATFORM_SUPERADMIN',
]);

/** A user as the scope rules read them; `_id` is absent for one not created yet. */
export type ScopedUser = Partial<Pick<IUser, 'tenantId' | 'accountScope' | 'role' | 'email'>> & {
  _id?: { toString(): string } | string;
};

const users = (): Model<IUser> => mongoose.models.User as Model<IUser>;

const normalizeEmail = (email?: string | null): string => (email ?? '').trim().toLowerCase();

/** Superadmins named only by configuration (`PLATFORM_SUPERADMIN_EMAILS`), read on each call. */
export function configuredSuperadminEmails(): Set<string> {
  return new Set(
    (process.env.PLATFORM_SUPERADMIN_EMAILS ?? '').split(',').map(normalizeEmail).filter(Boolean),
  );
}

/**
 * Whether a user is platform staff: a platform role, an email in `PLATFORM_SUPERADMIN_EMAILS`, or
 * an active `PlatformAdmin` row by id or email. Staff register without an institution like
 * individuals do, but are never moved or metered.
 */
export async function isPlatformStaff(
  userId?: string | null,
  role?: string | null,
  email?: string | null,
): Promise<boolean> {
  if (role && PLATFORM_ROLES.has(role)) {
    return true;
  }
  const address = normalizeEmail(email);
  if (address && configuredSuperadminEmails().has(address)) {
    return true;
  }
  const match = [...(userId ? [{ userId }] : []), ...(address ? [{ email: address }] : [])];
  if (match.length === 0) {
    return false;
  }
  const admin = await runAsSystem(() =>
    mongoose.models.PlatformAdmin?.exists({ active: true, $or: match }).exec(),
  );
  return admin != null;
}

/**
 * Whether a user belongs to no institution and has no account scope while not being platform
 * staff: an individual the meter would otherwise treat as staff (never metered).
 */
export async function needsStandaloneScope(user?: ScopedUser | null): Promise<boolean> {
  if (!user || user.tenantId || user.accountScope) {
    return false;
  }
  return !(await isPlatformStaff(user._id?.toString(), user.role, user.email));
}

/**
 * Marks a tenantless, non-staff user without an account scope `standalone`, so they are metered
 * under the individuals account. Resolves to whether they are now standalone by this rule (also
 * when a concurrent call wrote it first). Never touches a user who has a tenant or another scope by
 * the time of the write.
 */
export async function ensureStandaloneScope(user?: ScopedUser | null): Promise<boolean> {
  const userId = user?._id?.toString();
  if (!userId || !(await needsStandaloneScope(user))) {
    return false;
  }
  const written = await runAsSystem(() =>
    users()
      .updateOne(
        { _id: userId, tenantId: { $in: [null, ''] }, accountScope: { $in: [null, 'standalone'] } },
        { $set: { accountScope: 'standalone' } },
      )
      .exec(),
  );
  return written.matchedCount === 1;
}
