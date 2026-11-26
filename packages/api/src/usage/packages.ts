import { z } from 'zod';
import { logger, USAGE_PACKAGE_SCOPES } from '@librechat/data-schemas';
import type {
  AuditAction,
  AuditMetadata,
  AuditMetadataValue,
  IUsagePackage,
  IUsagePricing,
  UsagePackageFields,
  UsagePricingFields,
  UsagePackageMethods,
  RecordAuditEntryInput,
  RecordAuditEntryOptions,
} from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';
import { buildAuditContext } from '~/admin/context';

/** `Transaction.tokenValue` units: one credit is one millionth of a US dollar. */
export const CREDITS_PER_USD = 1_000_000;

/** Used until a superadmin saves pricing, so the catalogue can be priced from the first visit. */
export const DEFAULT_USAGE_PRICING: UsagePricingFields = {
  bdtPerUsd: 123,
  providerFeePercent: 0,
  defaultWeeklyPercent: 35,
};

const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,39}$/;
const DUPLICATE_KEY_CODE = 11000;

const percent = z.number().min(1).max(100);

const packageBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(''),
  scopes: z.array(z.enum(USAGE_PACKAGE_SCOPES)).min(1),
  price: z.number().min(0),
  monthlyCredit: z.number().positive(),
  weeklyPercent: percent.nullable().default(null),
  unlimited: z.boolean().default(false),
  active: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});

const usagePackageCreateSchema = packageBody.extend({
  key: z.string().trim().toLowerCase().regex(KEY_PATTERN),
});

const usagePackageUpdateSchema = packageBody
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'No fields to update');

const usagePricingSchema = z
  .object({
    bdtPerUsd: z.number().min(1).max(10_000),
    providerFeePercent: z.number().min(0).max(100),
    defaultWeeklyPercent: percent,
  })
  .strict();

export interface UsagePricingView extends UsagePricingFields {
  /** `false` while the defaults are in use because nothing has been saved yet. */
  configured: boolean;
  /** Taka that buy one dollar of API usage, after the provider fee. */
  bdtPerUsdEffective: number;
  updatedAt: string | null;
}

export interface PricedUsagePackage extends UsagePackageFields {
  effectiveWeeklyPercent: number;
  monthlyUsd: number;
  weeklyUsd: number;
  monthlyCredits: number;
  weeklyCredits: number;
  updatedAt: string | null;
}

/** Taka needed for one dollar of usage, including the provider's purchase fee. */
export function effectiveBdtPerUsd(pricing: UsagePricingFields): number {
  return pricing.bdtPerUsd * (1 + pricing.providerFeePercent / 100);
}

/** Converts a package's taka allowance to the dollar credits the quota engine enforces. */
export function priceUsagePackage(
  pkg: UsagePackageFields,
  pricing: UsagePricingFields,
): Omit<PricedUsagePackage, keyof UsagePackageFields | 'updatedAt'> {
  const effectiveWeeklyPercent = pkg.weeklyPercent ?? pricing.defaultWeeklyPercent;
  const monthlyUsd = pkg.monthlyCredit / effectiveBdtPerUsd(pricing);
  const weeklyUsd = (monthlyUsd * effectiveWeeklyPercent) / 100;
  return {
    effectiveWeeklyPercent,
    monthlyUsd,
    weeklyUsd,
    monthlyCredits: Math.floor(monthlyUsd * CREDITS_PER_USD),
    weeklyCredits: Math.floor(weeklyUsd * CREDITS_PER_USD),
  };
}

function toIso(date?: Date | null): string | null {
  return date ? new Date(date).toISOString() : null;
}

export function toPricingView(saved: IUsagePricing | null): UsagePricingView {
  const fields: UsagePricingFields = saved
    ? {
        bdtPerUsd: saved.bdtPerUsd,
        providerFeePercent: saved.providerFeePercent,
        defaultWeeklyPercent: saved.defaultWeeklyPercent,
      }
    : DEFAULT_USAGE_PRICING;
  return {
    ...fields,
    configured: saved != null,
    bdtPerUsdEffective: effectiveBdtPerUsd(fields),
    updatedAt: toIso(saved?.updatedAt),
  };
}

function toPackageFields(pkg: IUsagePackage): UsagePackageFields {
  return {
    key: pkg.key,
    name: pkg.name,
    description: pkg.description ?? '',
    scopes: pkg.scopes,
    price: pkg.price,
    monthlyCredit: pkg.monthlyCredit,
    weeklyPercent: pkg.weeklyPercent ?? null,
    unlimited: pkg.unlimited,
    active: pkg.active,
    sortOrder: pkg.sortOrder,
  };
}

export function toPricedPackage(
  pkg: IUsagePackage,
  pricing: UsagePricingFields,
): PricedUsagePackage {
  const fields = toPackageFields(pkg);
  return { ...fields, ...priceUsagePackage(fields, pricing), updatedAt: toIso(pkg.updatedAt) };
}

type AuditableValue = AuditMetadataValue | readonly string[] | undefined;
type Auditable<T> = { [K in keyof T]: AuditableValue };

function toAuditValue(value: AuditableValue): AuditMetadataValue {
  if (Array.isArray(value)) {
    return value.join(',');
  }
  return (value as AuditMetadataValue | undefined) ?? null;
}

/** Flattens changed fields into audit metadata, keeping the old value beside the new one. */
function diffMetadata<T extends Auditable<T>>(before: T | null, after: Partial<T>): AuditMetadata {
  const metadata: AuditMetadata = {};
  for (const field of Object.keys(after) as (keyof T & string)[]) {
    metadata[field] = toAuditValue(after[field]);
    if (before && before[field] !== undefined) {
      metadata[`previous_${field}`] = toAuditValue(before[field]);
    }
  }
  return metadata;
}

export interface UsagePackageHandlerDeps
  extends Pick<
    UsagePackageMethods,
    | 'listUsagePackages'
    | 'getUsagePackage'
    | 'createUsagePackage'
    | 'updateUsagePackage'
    | 'getUsagePricing'
    | 'saveUsagePricing'
  > {
  recordAuditEntry: (
    input: RecordAuditEntryInput,
    options?: RecordAuditEntryOptions,
  ) => Promise<unknown>;
  /** Called after any successful write, e.g. to drop a cached catalog. */
  onChange?: () => void;
}

type KeyRequest = ServerRequest & { params: { key?: string } };
type Handler<R extends ServerRequest> = (req: R, res: Response) => Promise<Response>;

export interface UsagePackageHandlers {
  listPackages: Handler<ServerRequest>;
  createPackage: Handler<ServerRequest>;
  updatePackage: Handler<KeyRequest>;
  archivePackage: Handler<KeyRequest>;
  getPricing: Handler<ServerRequest>;
  updatePricing: Handler<ServerRequest>;
}

function actorOf(req: ServerRequest): { id: string | undefined; name: string } {
  const user = req.user;
  return {
    id: user?.id ?? user?._id?.toString(),
    name: user?.name || user?.email || 'platform-superadmin',
  };
}

function validationError(res: Response, error: z.ZodError): Response {
  return res.status(400).json({ error: 'Invalid request', issues: error.flatten().fieldErrors });
}

/** Platform-superadmin handlers for the package catalogue and its pricing. Mount behind superadmin auth. */
export function createUsagePackageHandlers(deps: UsagePackageHandlerDeps): UsagePackageHandlers {
  /** Every change is a platform-wide billing decision, so a failed audit write fails the request. */
  async function audit(
    req: ServerRequest,
    action: AuditAction,
    target: { type: string; id: string; name?: string },
    metadata: AuditMetadata,
  ): Promise<void> {
    const actor = actorOf(req);
    await deps.recordAuditEntry(
      {
        action,
        severity: 'warning',
        actor: { type: 'user', id: actor.id, name: actor.name },
        target,
        metadata,
        context: buildAuditContext(req),
        tenantId: undefined,
      },
      { failClosed: true },
    );
  }

  async function loadPricing(): Promise<UsagePricingView> {
    return toPricingView(await deps.getUsagePricing());
  }

  async function listPackages(req: ServerRequest, res: Response) {
    try {
      const includeArchived = (req.query as Record<string, string>)?.includeArchived === 'true';
      const [pricing, packages] = await Promise.all([
        loadPricing(),
        deps.listUsagePackages({ includeArchived }),
      ]);
      return res.json({ pricing, packages: packages.map((pkg) => toPricedPackage(pkg, pricing)) });
    } catch (error) {
      logger.error('[usagePackages] list failed', error);
      return res.status(500).json({ error: 'Failed to load packages' });
    }
  }

  async function createPackage(req: ServerRequest, res: Response) {
    const parsed = usagePackageCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return validationError(res, parsed.error);
    }
    try {
      const actor = actorOf(req);
      const [pricing, created] = await Promise.all([
        loadPricing(),
        deps.createUsagePackage(parsed.data, actor.id),
      ]);
      await audit(
        req,
        'platform.usage_package_created',
        { type: 'usage_package', id: created.key, name: created.name },
        diffMetadata<UsagePackageFields>(null, parsed.data),
      );
      deps.onChange?.();
      return res.status(201).json({ package: toPricedPackage(created, pricing) });
    } catch (error) {
      if ((error as { code?: number })?.code === DUPLICATE_KEY_CODE) {
        return res.status(409).json({ error: 'A package with this key already exists' });
      }
      logger.error('[usagePackages] create failed', error);
      return res.status(500).json({ error: 'Failed to create package' });
    }
  }

  async function changePackage(
    req: KeyRequest,
    res: Response,
    updates: Partial<Omit<UsagePackageFields, 'key'>>,
    action: AuditAction,
  ) {
    const key = req.params.key ?? '';
    try {
      const existing = await deps.getUsagePackage(key);
      if (!existing) {
        return res.status(404).json({ error: 'Package not found' });
      }
      const actor = actorOf(req);
      const [pricing, updated] = await Promise.all([
        loadPricing(),
        deps.updateUsagePackage(key, updates, actor.id),
      ]);
      if (!updated) {
        return res.status(404).json({ error: 'Package not found' });
      }
      deps.onChange?.();
      await audit(
        req,
        action,
        { type: 'usage_package', id: updated.key, name: updated.name },
        diffMetadata(toPackageFields(existing), updates),
      );
      return res.json({ package: toPricedPackage(updated, pricing) });
    } catch (error) {
      logger.error('[usagePackages] update failed', error);
      return res.status(500).json({ error: 'Failed to update package' });
    }
  }

  async function updatePackage(req: KeyRequest, res: Response) {
    const parsed = usagePackageUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return validationError(res, parsed.error);
    }
    const action: AuditAction =
      parsed.data.active === false
        ? 'platform.usage_package_archived'
        : 'platform.usage_package_updated';
    return changePackage(req, res, parsed.data, action);
  }

  async function archivePackage(req: KeyRequest, res: Response) {
    return changePackage(req, res, { active: false }, 'platform.usage_package_archived');
  }

  async function getPricing(_req: ServerRequest, res: Response) {
    try {
      return res.json({ pricing: await loadPricing() });
    } catch (error) {
      logger.error('[usagePackages] pricing read failed', error);
      return res.status(500).json({ error: 'Failed to load pricing' });
    }
  }

  async function updatePricing(req: ServerRequest, res: Response) {
    const parsed = usagePricingSchema.safeParse(req.body);
    if (!parsed.success) {
      return validationError(res, parsed.error);
    }
    try {
      const previous = await deps.getUsagePricing();
      const saved = await deps.saveUsagePricing(parsed.data, actorOf(req).id);
      deps.onChange?.();
      await audit(
        req,
        'platform.usage_pricing_updated',
        { type: 'usage_pricing', id: 'default', name: 'Usage pricing' },
        diffMetadata(previous ? toPricingView(previous) : null, parsed.data),
      );
      return res.json({ pricing: toPricingView(saved) });
    } catch (error) {
      logger.error('[usagePackages] pricing update failed', error);
      return res.status(500).json({ error: 'Failed to save pricing' });
    }
  }

  return { listPackages, createPackage, updatePackage, archivePackage, getPricing, updatePricing };
}
