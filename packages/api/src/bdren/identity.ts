import type { IUser } from '@librechat/data-schemas';
import type { AllowanceSubject, BdrenConfig } from './types';
import { normalizeOpenIdIssuer } from '~/auth/openid';
import { quotaAccountFor } from '~/usage/accounts';

export type IdentityUser = Pick<
  IUser,
  'tenantId' | 'accountScope' | 'openidId' | 'openidIssuer'
> & { id?: string; _id?: { toString: () => string } | string };

/**
 * Who to ask bdren.ai about, or `null` when this user is not managed by it: the link is off, or the
 * user did not sign in through the configured issuer. Such users stay on Synapse's own packages.
 */
export function allowanceSubjectFor(
  user: IdentityUser | null | undefined,
  config: BdrenConfig,
): AllowanceSubject | null {
  if (!config.enabled || !user?.openidId) {
    return null;
  }
  const issuer = normalizeOpenIdIssuer(user.openidIssuer);
  const account = quotaAccountFor(user);
  const userId = user.id ?? user._id?.toString();
  if (!issuer || issuer !== normalizeOpenIdIssuer(config.issuer) || !account || !userId) {
    return null;
  }
  return { userId: String(userId), account, issuer, subject: user.openidId };
}
