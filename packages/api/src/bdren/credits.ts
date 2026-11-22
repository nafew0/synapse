import type { CreditLimits } from '~/usage/credits';
import type { ResolvedAllowance } from './types';
import { bucketRanges } from './windows';

export interface AllowanceCredits {
  limits: CreditLimits;
  ranges: {
    month: { start: Date; end: Date };
    week: { start: Date; end: Date };
  };
}

/**
 * The meter's view of an allowance: member limits as bdren.ai gave them, the institution ceiling
 * only for a seat, and the windows bdren.ai computed. Packages are named `bdren:<slug>` for audit.
 */
export function allowanceCredits(allowance: ResolvedAllowance): AllowanceCredits {
  const { member, institution } = allowance;
  const key = `bdren:${allowance.packageSlug}`;
  return {
    limits: {
      institution: {
        month: institution?.month.limit ?? null,
        week: institution?.week.limit ?? null,
      },
      member: { month: member.month.limit, week: member.week.limit },
      institutionPackageKey: institution ? key : null,
      memberPackageKey: key,
      unlimited: false,
    },
    ranges: bucketRanges(member.month.window, member.week.window),
  };
}

/** Whether a member's support override (reason and end required) is in force and beats bdren.ai. */
export function overrideActive(
  memberPackage: { override?: boolean; expiresAt?: Date | string | null } | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!memberPackage?.override || !memberPackage.expiresAt) {
    return false;
  }
  return new Date(memberPackage.expiresAt) > now;
}

/** Fields the refusal and the usage panel show beside a limit, so the user is told where to go next. */
export function allowanceNotice(allowance: ResolvedAllowance): {
  upgradeUrl: string;
  packageName: string;
  planSource: ResolvedAllowance['planSource'];
  institutionName: string | null;
  renews: string | null;
  endsAt: string | null;
} {
  return {
    upgradeUrl: allowance.upgradeUrl,
    packageName: allowance.packageName,
    planSource: allowance.planSource,
    institutionName: allowance.institutionName,
    renews: allowance.renews,
    endsAt: allowance.subscriptionEndsAt?.toISOString() ?? null,
  };
}
