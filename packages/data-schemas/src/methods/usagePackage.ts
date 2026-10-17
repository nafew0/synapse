import type { Model, Types } from 'mongoose';
import type { IUsagePackage, IUsagePricing, UsagePackageFields, UsagePricingFields } from '~/types';

type ActorId = Types.ObjectId | string | null | undefined;

const PRICING_KEY = 'default';

export type UsagePackageUpdate = Partial<Omit<UsagePackageFields, 'key'>>;

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
}

/** Packages and pricing are platform-wide rows with no `tenantId`. */
export function createUsagePackageMethods(
  mongoose: typeof import('mongoose'),
): UsagePackageMethods {
  const getModels = () => ({
    UsagePackage: mongoose.models.UsagePackage as Model<IUsagePackage>,
    UsagePricing: mongoose.models.UsagePricing as Model<IUsagePricing>,
  });

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
  };
}
