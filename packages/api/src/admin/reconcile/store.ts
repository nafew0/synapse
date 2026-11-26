import mongoose, { Schema } from 'mongoose';
import type { Model } from 'mongoose';
import type { ProviderSpendRecord, ReconcileService, SyncState } from './types';

const spendSchema = new Schema<ProviderSpendRecord>(
  {
    service: { type: String, required: true },
    period: { type: String, required: true },
    kind: { type: String, enum: ['day', 'month'], required: true },
    amount: { type: Number, default: null },
    source: {
      type: String,
      enum: ['openrouter_activity', 'firecrawl_credit_usage', 'manual'],
      required: true,
    },
    requests: Number,
    pages: Number,
    cumulative: Number,
    periodStart: { type: String, default: null },
    byModel: [{ _id: false, model: String, usd: Number, requests: Number }],
    note: String,
    enteredBy: { type: String, default: null },
    fetchedAt: { type: Date, required: true },
  },
  { timestamps: true },
);
spendSchema.index({ service: 1, period: 1 }, { unique: true });

const stateSchema = new Schema<SyncState>({
  service: { type: String, required: true, unique: true },
  lastRunAt: { type: Date, required: true },
  status: { type: String, required: true },
  message: String,
  httpStatus: Number,
});

/** Platform-wide collections: no `tenantId`, so tenant scoping leaves them alone. */
export const getProviderSpendModel = (): Model<ProviderSpendRecord> =>
  (mongoose.models.ProviderSpend as Model<ProviderSpendRecord>) ||
  mongoose.model<ProviderSpendRecord>('ProviderSpend', spendSchema);

export const getSyncStateModel = (): Model<SyncState> =>
  (mongoose.models.ProviderSyncState as Model<SyncState>) ||
  mongoose.model<SyncState>('ProviderSyncState', stateSchema);

export async function saveSpend(record: ProviderSpendRecord): Promise<void> {
  const { service, period, ...fields } = record;
  await getProviderSpendModel().updateOne(
    { service, period },
    { $set: { ...fields, service, period } },
    { upsert: true },
  );
}

export async function saveState(state: SyncState): Promise<void> {
  await getSyncStateModel().updateOne(
    { service: state.service },
    { $set: state },
    { upsert: true },
  );
}

export async function loadSpend(
  service: ReconcileService,
  from: string,
  to: string,
): Promise<ProviderSpendRecord[]> {
  return getProviderSpendModel()
    .find({ service, period: { $gte: from, $lte: to } })
    .sort({ period: 1 })
    .lean<ProviderSpendRecord[]>();
}

export const loadStates = (): Promise<SyncState[]> =>
  getSyncStateModel().find().lean<SyncState[]>();
