import mongoose from 'mongoose';
import { runAsSystem } from '@librechat/data-schemas';
import type { IBdrenAllowance, BdrenAllowancePayload } from '@librechat/data-schemas';
import type { Model } from 'mongoose';
import type { AllowanceSubject } from './types';

type Entry = Pick<
  IBdrenAllowance,
  | 'userId'
  | 'tenantId'
  | 'issuer'
  | 'subject'
  | 'etag'
  | 'allowance'
  | 'fetchedAt'
  | 'verifiedAt'
  | 'invalidatedAt'
  | 'previousWindows'
>;

const model = (): Model<IBdrenAllowance> =>
  mongoose.models.BdrenAllowance as Model<IBdrenAllowance>;

/** The cached answer of one user, or `null`. Always looked up by the user's own id. */
export function readEntry(userId: string): Promise<Entry | null> {
  return runAsSystem(() => model().findOne({ userId }).lean<Entry>().exec());
}

export function saveEntry(
  who: AllowanceSubject,
  payload: BdrenAllowancePayload,
  now: Date,
  previousWindows: Entry['previousWindows'] = null,
): Promise<unknown> {
  return runAsSystem(() =>
    model()
      .updateOne(
        { userId: who.userId },
        {
          $set: {
            tenantId: who.account,
            issuer: who.issuer,
            subject: who.subject,
            etag: payload.etag,
            allowance: payload,
            fetchedAt: now,
            verifiedAt: now,
            invalidatedAt: null,
            previousWindows,
          },
        },
        { upsert: true },
      )
      .exec(),
  );
}

/** The old windows have been used for an upgrade; forget them so a later event cannot reuse them. */
export function clearPreviousWindows(userId: string): Promise<unknown> {
  return runAsSystem(() =>
    model()
      .updateOne({ userId }, { $set: { previousWindows: null } })
      .exec(),
  );
}

/** bdren.ai confirmed the cached answer is still current (a 304). */
export function touchEntry(userId: string, now: Date): Promise<unknown> {
  return runAsSystem(() =>
    model()
      .updateOne({ userId }, { $set: { verifiedAt: now, invalidatedAt: null } })
      .exec(),
  );
}

/** Marks entries for refetching without deleting them: an upgrade still needs the old windows. */
export async function invalidateSubject(
  issuer: string,
  subject: string,
  now: Date,
): Promise<number> {
  const result = await runAsSystem(() =>
    model()
      .updateMany({ issuer, subject }, { $set: { invalidatedAt: now } })
      .exec(),
  );
  return result.modifiedCount;
}

/** Every member of an institution: those cached under its seat, and those metered under its tenant. */
export async function invalidateOrganization(
  organizationId: string,
  tenantId: string | null,
  now: Date,
): Promise<number> {
  const clauses: Array<Record<string, string>> = [{ 'allowance.institution.id': organizationId }];
  if (tenantId) {
    clauses.push({ tenantId });
  }
  const result = await runAsSystem(() =>
    model()
      .updateMany({ $or: clauses }, { $set: { invalidatedAt: now } })
      .exec(),
  );
  return result.modifiedCount;
}
