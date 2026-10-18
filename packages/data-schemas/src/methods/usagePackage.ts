import type { Model, Types } from 'mongoose';
import { USAGE_ACCOUNT_NAMES } from '~/types/usagePackage';
import type {
  IInstitution,
  IUsageAccount,
  IUsagePackage,
  IUsagePricing,
  UsagePackageFields,
  UsagePricingFields,
  InstitutionUsagePackage,
} from '~/types';

type ActorId = Types.ObjectId | string | null | undefined;

const PRICING_KEY = 'default';

export type UsagePackageUpdate = Partial<Omit<UsagePackageFields, 'key'>>;

/** Whoever a quota key's packages belong to: an institution, or an account that is not one. */
export type QuotaOwner = Pick<IInstitution | IUsageAccount, 'tenantId' | 'name' | 'usagePackage'>;

export interface UsagePackageMethods {
  listUsagePackages: (options?: { includeArchived?: boolean }) => Promise<IUsagePackage[]>;
  getUsagePackage: (key: string) => Promise<IUsagePackage | null>;
  createUsagePackage: (fields: UsagePackageFields, actorId?: ActorId) => Promise<IUsagePackage>;
  updateUsagePackage: (
    key: string,
    updates: UsagePackageUpdate,
    actorId?: ActorId,
  ) => Promise<IUsagePackage | null>;
  getUsagePricing: () => Promise<IUsagePricing | null>;
  saveUsagePricing: (fields: UsagePricingFields, actorId?: ActorId) => Promise<IUsagePricing>;
  /** The institution, or the account, a quota key names; an unconfigured account reads as empty. */
  getQuotaOwner: (tenantId: string) => Promise<QuotaOwner | null>;
  /** Sets a quota owner's packages, creating the account on its first write. */
  setQuotaOwnerPackage: (
    tenantId: string,
    usagePackage: InstitutionUsagePackage | null,
  ) => Promise<QuotaOwner | null>;
}

/** Packages and pricing are platform-wide rows with no `tenantId`. */
export function createUsagePackageMethods(
  mongoose: typeof import('mongoose'),
): UsagePackageMethods {
  const getModels = () => ({
    UsagePackage: mongoose.models.UsagePackage as Model<IUsagePackage>,
    UsagePricing: mongoose.models.UsagePricing as Model<IUsagePricing>,
    UsageAccount: mongoose.models.UsageAccount as Model<IUsageAccount>,
    Institution: mongoose.models.Institution as Model<IInstitution>,
  });

  const isAccount = (tenantId: string) => tenantId in USAGE_ACCOUNT_NAMES;

  async function getQuotaOwner(tenantId: string): Promise<QuotaOwner | null> {
    const { UsageAccount, Institution } = getModels();
    if (!isAccount(tenantId)) {
      return Institution.findOne({ tenantId }).lean<IInstitution>();
    }
    const account = await UsageAccount.findOne({ tenantId }).lean<IUsageAccount>();
    return account ?? { tenantId, name: USAGE_ACCOUNT_NAMES[tenantId], usagePackage: null };
  }

  async function setQuotaOwnerPackage(
    tenantId: string,
    usagePackage: InstitutionUsagePackage | null,
  ): Promise<QuotaOwner | null> {
    const { UsageAccount, Institution } = getModels();
    if (!isAccount(tenantId)) {
      return Institution.findOneAndUpdate(
        { tenantId },
        { $set: { usagePackage } },
        { new: true },
      ).lean<IInstitution>();
    }
    return UsageAccount.findOneAndUpdate(
      { tenantId },
      { $set: { usagePackage }, $setOnInsert: { name: USAGE_ACCOUNT_NAMES[tenantId] } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    ).lean<IUsageAccount>();
  }

  async function listUsagePackages({ includeArchived = false } = {}): Promise<IUsagePackage[]> {
    const filter = includeArchived ? {} : { active: true };
    return getModels()
      .UsagePackage.find(filter)
      .sort({ sortOrder: 1, createdAt: 1 })
      .lean<IUsagePackage[]>();
  }

  async function getUsagePackage(key: string): Promise<IUsagePackage | null> {
    return getModels().UsagePackage.findOne({ key }).lean<IUsagePackage>();
  }

  async function createUsagePackage(
    fields: UsagePackageFields,
    actorId?: ActorId,
  ): Promise<IUsagePackage> {
    const created = await getModels().UsagePackage.create({
      ...fields,
      createdBy: actorId ?? null,
      updatedBy: actorId ?? null,
    });
    return created.toObject();
  }

  async function updateUsagePackage(
    key: string,
    updates: UsagePackageUpdate,
    actorId?: ActorId,
  ): Promise<IUsagePackage | null> {
    return getModels()
      .UsagePackage.findOneAndUpdate(
        { key },
        { $set: { ...updates, updatedBy: actorId ?? null } },
        { new: true, runValidators: true },
      )
      .lean<IUsagePackage>();
  }

  async function getUsagePricing(): Promise<IUsagePricing | null> {
    return getModels().UsagePricing.findOne({ key: PRICING_KEY }).lean<IUsagePricing>();
  }

  async function saveUsagePricing(
    fields: UsagePricingFields,
    actorId?: ActorId,
  ): Promise<IUsagePricing> {
    const saved = await getModels()
      .UsagePricing.findOneAndUpdate(
        { key: PRICING_KEY },
        { $set: { ...fields, updatedBy: actorId ?? null }, $setOnInsert: { key: PRICING_KEY } },
        { new: true, upsert: true, runValidators: true },
      )
      .lean<IUsagePricing>();
    return saved as IUsagePricing;
  }

  return {
    listUsagePackages,
    getUsagePackage,
    createUsagePackage,
    updateUsagePackage,
    getUsagePricing,
    saveUsagePricing,
    getQuotaOwner,
    setQuotaOwnerPackage,
  };
}
