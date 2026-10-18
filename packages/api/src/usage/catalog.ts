import type { UsagePackageMethods } from '@librechat/data-schemas';
import type { UsageCatalogSnapshot } from './credits';
import { toPricingView } from './packages';

export interface UsageCatalog {
  /** Packages (archived included) and pricing, cached for `ttlMs`. */
  load: () => Promise<UsageCatalogSnapshot>;
  /** Drops the cache; call after any package or pricing write. */
  invalidate: () => void;
}

/** Packages and pricing change rarely and are read on every metered request, so they are cached in memory. */
export function createUsageCatalog(
  deps: Pick<UsagePackageMethods, 'listUsagePackages' | 'getUsagePricing'>,
  { ttlMs = 60_000, now = () => Date.now() }: { ttlMs?: number; now?: () => number } = {},
): UsageCatalog {
  let cached: { at: number; value: Promise<UsageCatalogSnapshot> } | null = null;

  async function read(): Promise<UsageCatalogSnapshot> {
    const [packages, pricing] = await Promise.all([
      deps.listUsagePackages({ includeArchived: true }),
      deps.getUsagePricing(),
    ]);
    const view = toPricingView(pricing);
    return {
      packages: new Map(packages.map((pkg) => [pkg.key, pkg])),
      pricing: {
        bdtPerUsd: view.bdtPerUsd,
        providerFeePercent: view.providerFeePercent,
        defaultWeeklyPercent: view.defaultWeeklyPercent,
      },
    };
  }

  function load(): Promise<UsageCatalogSnapshot> {
    if (cached && now() - cached.at < ttlMs) {
      return cached.value;
    }
    const value = read();
    cached = { at: now(), value };
    value.catch(() => {
      if (cached?.value === value) {
        cached = null;
      }
    });
    return value;
  }

  return {
    load,
    invalidate: () => {
      cached = null;
    },
  };
}
