import { Schema } from 'mongoose';
import type { IGroup } from '~/types';
import { MANAGED_GROUP_KINDS } from '~/types';

const groupSchema: Schema<IGroup> = new Schema<IGroup>(
  {
    name: {
      type: String,
      required: true,
      index: true,
    },
    description: {
      type: String,
      required: false,
    },
    email: {
      type: String,
      required: false,
      index: true,
    },
    avatar: {
      type: String,
      required: false,
    },
    memberIds: [
      {
        type: String,
        required: false,
      },
    ],
    source: {
      type: String,
      enum: ['local', 'entra'],
      default: 'local',
    },
    /** External ID (e.g., Entra ID) */
    idOnTheSource: {
      type: String,
      sparse: true,
      index: true,
      required: function (this: IGroup) {
        return this.source !== 'local';
      },
    },
    tenantId: {
      type: String,
      index: true,
    },
    managedKind: {
      type: String,
      enum: MANAGED_GROUP_KINDS,
      required: false,
    },
  },
  { timestamps: true },
);

groupSchema.index(
  { idOnTheSource: 1, source: 1, tenantId: 1 },
  {
    unique: true,
    partialFilterExpression: { idOnTheSource: { $exists: true } },
  },
);
groupSchema.index({ memberIds: 1, tenantId: 1 });
groupSchema.index(
  { tenantId: 1, managedKind: 1 },
  {
    unique: true,
    partialFilterExpression: { managedKind: 'tenant_all_active_members' },
  },
);

export default groupSchema;
