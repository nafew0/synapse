import { Schema } from 'mongoose';
import type { IBrowserExtensionReport } from '~/types';

/** Kept 30 days: long enough to study a failure a user reported, short enough not to become an archive of their work. */
export const BROWSER_EXTENSION_REPORT_TTL_SECONDS: number = 30 * 24 * 60 * 60;

const browserExtensionReportSchema: Schema<IBrowserExtensionReport> =
  new Schema<IBrowserExtensionReport>({
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    tenantId: { type: String },
    extensionVersion: { type: String, required: true },
    build: { type: String },
    llmModel: { type: String },
    status: { type: String, required: true },
    outcome: { type: String },
    reason: { type: String },
    turns: { type: Number, default: 0 },
    inputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    hosts: { type: [String], default: [] },
    comment: { type: String },
    steps: {
      type: [
        new Schema(
          {
            tool: { type: String, required: true },
            args: { type: String, default: '' },
            ok: { type: Boolean, required: true },
            code: { type: String },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    createdAt: { type: Date, required: true, expires: BROWSER_EXTENSION_REPORT_TTL_SECONDS },
  });

browserExtensionReportSchema.index({ user: 1, createdAt: -1 });
browserExtensionReportSchema.index({ tenantId: 1, createdAt: -1 });

export default browserExtensionReportSchema;
