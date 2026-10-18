import { INDIVIDUAL_USAGE_ACCOUNT } from '@librechat/data-schemas';
import type { IUser } from '@librechat/data-schemas';

/** Prefix of quota account keys that are not institutions; no institution may use it. */
const RESERVED_TENANT_PREFIX = '__';

export type QuotaAccountUser = Pick<IUser, 'tenantId' | 'accountScope'>;

/**
 * The quota account a user is metered under: their institution, or the individuals account for
 * standalone users. Platform staff belong to neither and are never metered.
 */
export function quotaAccountFor(user?: QuotaAccountUser | null): string | null {
  if (user?.tenantId) {
    return user.tenantId;
  }
  return user?.accountScope === 'standalone' ? INDIVIDUAL_USAGE_ACCOUNT : null;
}

/** Whether a quota key names an account that is not an institution. */
export function isUsageAccount(tenantId?: string | null): boolean {
  return tenantId === INDIVIDUAL_USAGE_ACCOUNT;
}

/** Whether a `tenantId` is reserved for quota accounts and so cannot name an institution. */
export function isReservedTenantId(tenantId?: string | null): boolean {
  return typeof tenantId === 'string' && tenantId.trim().startsWith(RESERVED_TENANT_PREFIX);
}
