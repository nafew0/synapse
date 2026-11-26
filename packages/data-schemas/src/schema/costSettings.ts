import { Schema } from 'mongoose';
import type { ICostSettings } from '~/types';

/** One platform-wide row (`key: 'default'`). `tenantId` is not a field here, so no tenant scoping applies. */
const costSettingsSchema: Schema<ICostSettings> = new Schema(
  {
    key: { type: String, required: true, default: 'default', immutable: true, unique: true },
    fixedCosts: {
      type: [
        {
          _id: false,
          id: { type: String, required: true },
          label: { type: String, required: true },
          amount: { type: Number, required: true, min: 0 },
          currency: { type: String, enum: ['USD', 'BDT'], required: true },
        },
      ],
      default: [],
    },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

export default costSettingsSchema;
