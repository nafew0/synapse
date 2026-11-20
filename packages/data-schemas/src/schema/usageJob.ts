import { Schema } from 'mongoose';
import type { IUsageJob } from '~/types';

/** Watermark and lease for the usage jobs. One document per job name. */
const usageJobSchema: Schema<IUsageJob> = new Schema(
  {
    name: { type: String, required: true, unique: true },
    /** Last ledger row the rollup has read. */
    watermark: { type: Schema.Types.ObjectId },
    lockedUntil: { type: Date },
    lastRunAt: { type: Date },
    /** Asia/Dhaka day of the last nightly profile. */
    lastDay: { type: String },
    /** Why the last run stopped early, cleared by the next clean run. */
    lastError: { type: String },
  },
  { timestamps: true },
);

export default usageJobSchema;
