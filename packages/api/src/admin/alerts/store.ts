import mongoose, { Schema } from 'mongoose';
import type { Model } from 'mongoose';
import type { AlertFinding, AlertKind, PlatformAlertRecord } from './types';

const RESOLVED_VISIBLE_DAYS = 14;
const LIST_LIMIT = 100;

type AlertDocument = Omit<PlatformAlertRecord, '_id'>;

const alertSchema = new Schema<AlertDocument>(
  {
    key: { type: String, required: true, unique: true },
    kind: { type: String, required: true, index: true },
    severity: { type: String, enum: ['critical', 'warning'], required: true },
    title: { type: String, required: true },
    detail: { type: String, default: '' },
    status: { type: String, enum: ['open', 'resolved'], default: 'open', index: true },
    firstSeenAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true },
    resolvedAt: { type: Date, default: null },
    seenAt: { type: Date, default: null },
    seenBy: { type: String, default: null },
  },
  { timestamps: true },
);

/** Platform-wide, so the collection carries no `tenantId` and the tenant filter leaves it alone. */
export const getAlertModel = (): Model<AlertDocument> =>
  (mongoose.models.PlatformAlert as Model<AlertDocument>) ||
  mongoose.model<AlertDocument>('PlatformAlert', alertSchema);

export interface SyncResult {
  raised: number;
  resolved: number;
}

/**
 * Brings the stored alerts in line with a check's findings. A new condition opens an alert, a repeat
 * refreshes it, a worse severity shows it again even if it was marked seen, and a kind that was checked
 * and came back healthy resolves. Kinds the check could not evaluate are left as they were.
 */
export async function syncAlerts(
  findings: AlertFinding[],
  checkedKinds: AlertKind[],
  now: Date = new Date(),
): Promise<SyncResult> {
  const Alert = getAlertModel();
  const keys = findings.map((finding) => finding.key);
  const existing = new Map(
    (await Alert.find({ key: { $in: keys } }).lean()).map((alert) => [alert.key, alert]),
  );

  const writes = findings.map((finding) => {
    const current = existing.get(finding.key);
    const { key, ...fields } = finding;
    const reopened = current?.status === 'resolved';
    const escalated = current?.severity === 'warning' && finding.severity === 'critical';
    const fresh = !current || reopened;
    return {
      updateOne: {
        filter: { key },
        upsert: true,
        update: {
          $set: {
            ...fields,
            status: 'open' as const,
            lastSeenAt: now,
            resolvedAt: null,
            ...(fresh ? { firstSeenAt: now } : {}),
            ...(fresh || escalated ? { seenAt: null, seenBy: null } : {}),
          },
          $setOnInsert: { key },
        },
      },
    };
  });
  const raised = findings.filter((finding) => existing.get(finding.key)?.status !== 'open').length;

  const resolvedFilter = {
    kind: { $in: checkedKinds },
    status: 'open' as const,
    key: { $nin: keys },
  };
  const [, resolution] = await Promise.all([
    writes.length ? Alert.bulkWrite(writes) : Promise.resolve(null),
    checkedKinds.length
      ? Alert.updateMany(resolvedFilter, { $set: { status: 'resolved', resolvedAt: now } })
      : Promise.resolve({ modifiedCount: 0 }),
  ]);
  return { raised, resolved: resolution.modifiedCount };
}

/** Resolves the open alert with this key, if any; returns whether one was open. */
export async function resolveAlert(key: string, now: Date = new Date()): Promise<boolean> {
  const result = await getAlertModel().updateOne(
    { key, status: 'open' },
    { $set: { status: 'resolved', resolvedAt: now } },
  );
  return result.modifiedCount > 0;
}

/** Open alerts first, then recently resolved ones, newest first. */
export async function listAlerts(now: Date = new Date()): Promise<PlatformAlertRecord[]> {
  const since = new Date(now.getTime() - RESOLVED_VISIBLE_DAYS * 86_400_000);
  const alerts = await getAlertModel()
    .find({ $or: [{ status: 'open' }, { resolvedAt: { $gte: since } }] })
    .sort({ status: 1, severity: 1, lastSeenAt: -1 })
    .limit(LIST_LIMIT)
    .lean();
  return alerts as unknown as PlatformAlertRecord[];
}

/** Marks one alert, or every open one, as seen by a superadmin. Returns how many changed. */
export async function markSeen(
  userId: string,
  alertId?: string,
  now: Date = new Date(),
): Promise<number> {
  const filter = alertId
    ? { _id: alertId, seenAt: null }
    : { status: 'open' as const, seenAt: null };
  const result = await getAlertModel().updateMany(filter, {
    $set: { seenAt: now, seenBy: userId },
  });
  return result.modifiedCount;
}
