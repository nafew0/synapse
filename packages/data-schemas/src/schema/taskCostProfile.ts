import { Schema } from 'mongoose';
import type { ITaskCostProfile } from '~/types';

/** What one kind of task cost over the 30 days to `day`, rebuilt nightly. One row per day and task type. */
const taskCostProfileSchema: Schema<ITaskCostProfile> = new Schema(
  {
    day: { type: String, required: true },
    taskType: { type: String, required: true },
    windowDays: { type: Number, required: true },
    requests: { type: Number, required: true },
    medianUsd: { type: Number, required: true },
    p90Usd: { type: Number, required: true },
    meanUsd: { type: Number, required: true },
    /** Cost per scanned page, for task types that read pages. */
    perPageUsd: { type: Number },
    avgPages: { type: Number, default: 0 },
    avgWebCredits: { type: Number, default: 0 },
    avgImages: { type: Number, default: 0 },
    /** False below the minimum request count; readers then keep their own estimate. */
    sufficient: { type: Boolean, required: true },
  },
  { timestamps: true },
);

taskCostProfileSchema.index({ day: 1, taskType: 1 }, { unique: true });

export default taskCostProfileSchema;
