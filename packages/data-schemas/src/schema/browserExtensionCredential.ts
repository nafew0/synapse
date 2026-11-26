import { Schema } from 'mongoose';
import type { IBrowserExtensionCredential } from '~/types';

const browserExtensionCredentialSchema: Schema<IBrowserExtensionCredential> =
  new Schema<IBrowserExtensionCredential>(
    {
      user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
      tenantId: { type: String },
      kind: { type: String, enum: ['code', 'token'], required: true },
      hash: { type: String, required: true, unique: true },
      expiresAt: { type: Date, required: true },
      lastUsedAt: { type: Date },
    },
    { timestamps: { createdAt: true, updatedAt: false } },
  );

/** MongoDB removes a code or token once it expires. */
browserExtensionCredentialSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default browserExtensionCredentialSchema;
