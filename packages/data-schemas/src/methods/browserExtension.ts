import type { Model, Types } from 'mongoose';
import type {
  BrowserExtensionCredentialKind,
  BrowserExtensionUsageFields,
  IBrowserExtensionCredential,
  IBrowserExtensionUsage,
} from '~/types';
import { hashToken } from '~/crypto';

export interface BrowserExtensionMethods {
  /** Stores the hash of `secret`; the caller keeps the value to hand to the user. */
  createBrowserExtensionCredential: (fields: {
    user: Types.ObjectId | string;
    tenantId?: string;
    kind: BrowserExtensionCredentialKind;
    secret: string;
    expiresAt: Date;
  }) => Promise<IBrowserExtensionCredential>;
  /** The unexpired credential of that kind for `secret`, or null. */
  findBrowserExtensionCredential: (
    secret: string,
    kind: BrowserExtensionCredentialKind,
  ) => Promise<IBrowserExtensionCredential | null>;
  deleteBrowserExtensionCredential: (id: Types.ObjectId | string) => Promise<void>;
  /** Signs a user out of every extension. */
  deleteBrowserExtensionTokens: (user: Types.ObjectId | string) => Promise<number>;
  touchBrowserExtensionCredential: (id: Types.ObjectId | string) => Promise<void>;
  recordBrowserExtensionUsage: (fields: BrowserExtensionUsageFields) => Promise<void>;
  /** Input plus output tokens a user spent through the extension since `since`. */
  sumBrowserExtensionTokens: (user: Types.ObjectId | string, since: Date) => Promise<number>;
}

export function createBrowserExtensionMethods(
  mongoose: typeof import('mongoose'),
): BrowserExtensionMethods {
  const credentials = (): Model<IBrowserExtensionCredential> =>
    mongoose.models.BrowserExtensionCredential as Model<IBrowserExtensionCredential>;
  const usage = (): Model<IBrowserExtensionUsage> =>
    mongoose.models.BrowserExtensionUsage as Model<IBrowserExtensionUsage>;

  async function createBrowserExtensionCredential(fields: {
    user: Types.ObjectId | string;
    tenantId?: string;
    kind: BrowserExtensionCredentialKind;
    secret: string;
    expiresAt: Date;
  }): Promise<IBrowserExtensionCredential> {
    const { secret, ...rest } = fields;
    return credentials().create({ ...rest, hash: await hashToken(secret) });
  }

  async function findBrowserExtensionCredential(
    secret: string,
    kind: BrowserExtensionCredentialKind,
  ): Promise<IBrowserExtensionCredential | null> {
    return credentials()
      .findOne({ hash: await hashToken(secret), kind, expiresAt: { $gt: new Date() } })
      .lean<IBrowserExtensionCredential>();
  }

  async function deleteBrowserExtensionCredential(id: Types.ObjectId | string): Promise<void> {
    await credentials().deleteOne({ _id: id });
  }

  async function deleteBrowserExtensionTokens(user: Types.ObjectId | string): Promise<number> {
    const result = await credentials().deleteMany({ user, kind: 'token' });
    return result.deletedCount;
  }

  async function touchBrowserExtensionCredential(id: Types.ObjectId | string): Promise<void> {
    await credentials().updateOne({ _id: id }, { $set: { lastUsedAt: new Date() } });
  }

  async function recordBrowserExtensionUsage(fields: BrowserExtensionUsageFields): Promise<void> {
    await usage().create(fields);
  }

  async function sumBrowserExtensionTokens(
    user: Types.ObjectId | string,
    since: Date,
  ): Promise<number> {
    const [row] = await usage().aggregate<{ total: number }>([
      { $match: { user: new mongoose.Types.ObjectId(String(user)), at: { $gte: since } } },
      { $group: { _id: null, total: { $sum: { $add: ['$inputTokens', '$outputTokens'] } } } },
    ]);
    return row?.total ?? 0;
  }

  return {
    createBrowserExtensionCredential,
    findBrowserExtensionCredential,
    deleteBrowserExtensionCredential,
    deleteBrowserExtensionTokens,
    touchBrowserExtensionCredential,
    recordBrowserExtensionUsage,
    sumBrowserExtensionTokens,
  };
}
