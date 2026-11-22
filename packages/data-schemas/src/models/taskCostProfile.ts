import type { Model } from 'mongoose';
import type { ITaskCostProfile } from '~/types';
import taskCostProfileSchema from '~/schema/taskCostProfile';

export function createTaskCostProfileModel(
  mongoose: typeof import('mongoose'),
): Model<ITaskCostProfile> {
  return (
    mongoose.models.TaskCostProfile ||
    mongoose.model<ITaskCostProfile>('TaskCostProfile', taskCostProfileSchema)
  );
}
