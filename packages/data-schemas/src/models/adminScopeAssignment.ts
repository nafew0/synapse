import type { Model } from 'mongoose';
import type { IAdminScopeAssignment } from '~/types';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import adminScopeAssignmentSchema from '~/schema/adminScopeAssignment';

export function createAdminScopeAssignmentModel(
  mongoose: typeof import('mongoose'),
): Model<IAdminScopeAssignment> {
  applyTenantIsolation(adminScopeAssignmentSchema);
  return (
    mongoose.models.AdminScopeAssignment ||
    mongoose.model<IAdminScopeAssignment>('AdminScopeAssignment', adminScopeAssignmentSchema)
  );
}
