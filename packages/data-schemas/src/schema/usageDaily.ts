import { Schema } from 'mongoose';
import type { IUsageDaily } from '~/types';

/**
 * One row per Asia/Dhaka day and slice of the ledger. Dashboards read this instead of scanning
 * `Transaction`. The rollup job rebuilds a day from the ledger, so a row is never incremented.
 * Platform-wide collection: `tenantId` is a field, not an isolation scope (it holds every tenant).
 */
const usageDailySchema: Schema<IUsageDaily> = new Schema(
  {
    /** Deterministic bucket id, so a rebuild replaces the row instead of duplicating it. */
    key: { type: String, required: true, unique: true },
    day: { type: String, required: true, index: true },
    tenantId: { type: String, index: true },
    user: { type: Schema.Types.ObjectId, index: true },
    service: { type: String, required: true },
    modelKey: { type: String },
    usageKind: { type: String },
    taskType: { type: String },
    billable: { type: Boolean, required: true },
    /** Model calls and service charges, one each. */
    requests: { type: Number, default: 0 },
    /** Provider units: tokens, seconds, credits, operations, images. */
    units: { type: Number, default: 0 },
    inputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    pages: { type: Number, default: 0 },
    costUsd: { type: Number, default: 0 },
    /** Ledger rows rolled into this bucket; the reconciliation check sums it. */
    rows: { type: Number, default: 0 },
  },
  { timestamps: true },
);

usageDailySchema.index({ day: 1, tenantId: 1 });
usageDailySchema.index({ day: 1, taskType: 1 });

export default usageDailySchema;
