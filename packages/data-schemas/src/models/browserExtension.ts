import { Model } from 'mongoose';
import type {
  IBrowserExtensionCredential,
  IBrowserExtensionReport,
  IBrowserExtensionUsage,
} from '~/types';
import browserExtensionCredentialSchema from '~/schema/browserExtensionCredential';
import browserExtensionUsageSchema from '~/schema/browserExtensionUsage';
import browserExtensionReportSchema from '~/schema/browserExtensionReport';

/** Not tenant-isolated: a token is looked up before its tenant is known, and every record carries its tenantId. */
export function createBrowserExtensionCredentialModel(
  mongoose: typeof import('mongoose'),
): Model<IBrowserExtensionCredential> {
  return (
    mongoose.models.BrowserExtensionCredential ||
    mongoose.model<IBrowserExtensionCredential>(
      'BrowserExtensionCredential',
      browserExtensionCredentialSchema,
    )
  );
}

export function createBrowserExtensionUsageModel(
  mongoose: typeof import('mongoose'),
): Model<IBrowserExtensionUsage> {
  return (
    mongoose.models.BrowserExtensionUsage ||
    mongoose.model<IBrowserExtensionUsage>('BrowserExtensionUsage', browserExtensionUsageSchema)
  );
}

export function createBrowserExtensionReportModel(
  mongoose: typeof import('mongoose'),
): Model<IBrowserExtensionReport> {
  return (
    mongoose.models.BrowserExtensionReport ||
    mongoose.model<IBrowserExtensionReport>('BrowserExtensionReport', browserExtensionReportSchema)
  );
}
