import { logger } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { IUser } from '@librechat/data-schemas';
import type { TPlanUsageResponse, TQuotaMeterState, TQuotaResponse } from 'librechat-data-provider';
import type { ResolvedAllowance } from './types';

type PlanUser = IUser & { id: string };

export interface PlanUsageDeps {
  /** Whether the bdren.ai link is on for this server. */
  linked: () => boolean;
  /** The user's quota account, or `null` for platform staff, who have none. */
  resolveAccount: (user: PlanUser) => Promise<string | null>;
  /** bdren.ai's allowance for the user, or `null` when bdren.ai does not manage them. */
  getAllowance: (user: PlanUser) => Promise<ResolvedAllowance | null>;
  getMemberQuota: (args: {
    tenantId: string;
    userId: string;
    memberPackage: IUser['usagePackage'];
    allowance: ResolvedAllowance | null;
  }) => Promise<TQuotaResponse | null>;
}

const windowOrder = { week: 0, month: 1 } as const;

function creditPeriods(quota: TQuotaResponse | null): TQuotaMeterState[] {
  if (quota?.unit !== 'credits') {
    return [];
  }
  return quota.meters
    .filter((state) => state.meter === 'credits')
    .sort((a, b) => windowOrder[a.window] - windowOrder[b.window]);
}

function planOf(
  allowance: ResolvedAllowance | null,
  quota: TQuotaResponse | null,
): TPlanUsageResponse['plan'] {
  if (allowance) {
    return {
      name: allowance.packageName,
      source: allowance.planSource,
      institutionName: allowance.planSource === 'institution' ? allowance.institutionName : null,
      endsAt: allowance.subscriptionEndsAt?.toISOString() ?? null,
      upgradeUrl: allowance.upgradeUrl || null,
      stale: allowance.origin === 'stale' || allowance.origin === 'fallback',
      unlimited: quota?.package?.unlimited === true,
    };
  }
  if (quota?.package?.name) {
    return {
      name: quota.package.name,
      source: null,
      institutionName: null,
      endsAt: null,
      upgradeUrl: null,
      stale: false,
      unlimited: quota.package.unlimited === true,
    };
  }
  return null;
}

/** The plan and AI allowance shown in Settings, built from the allowance and the member's meters. */
export function toPlanUsage(
  linked: boolean,
  allowance: ResolvedAllowance | null,
  quota: TQuotaResponse | null,
): TPlanUsageResponse {
  return {
    linked,
    managed: allowance != null,
    plan: planOf(allowance, quota),
    periods: creditPeriods(quota),
  };
}

/**
 * `GET /api/quota/plan`: the caller's own plan and usage. Scoped to `req.user`, never a user id
 * from the request, and reads only the current windows.
 */
export function createPlanUsageHandler(deps: PlanUsageDeps) {
  return async function planUsageHandler(req: Request, res: Response): Promise<void> {
    const user = req.user as PlanUser | undefined;
    if (!user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const linked = deps.linked();
    try {
      const tenantId = await deps.resolveAccount(user);
      if (!tenantId) {
        res.status(200).json(toPlanUsage(linked, null, null));
        return;
      }
      const allowance = await deps.getAllowance(user);
      const quota = await deps.getMemberQuota({
        tenantId,
        userId: user.id,
        memberPackage: user.usagePackage,
        allowance,
      });
      res.status(200).json(toPlanUsage(linked, allowance, quota));
    } catch (error) {
      if ((error as { details?: { code?: string } })?.details?.code === 'INSTITUTION_NOT_FOUND') {
        res.status(200).json(toPlanUsage(linked, null, null));
        return;
      }
      logger.error('[quota] failed to read plan usage', error);
      res.status(500).json({ error: 'Failed to load plan usage' });
    }
  };
}
