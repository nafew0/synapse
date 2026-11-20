import { logger } from '@librechat/data-schemas';
import type { BdrenConfig, AllowanceSubject, AllowanceOrigin, ResolvedAllowance } from './types';
import type { AllowanceClient } from './client';
import { fallbackAllowance, resolveAllowance } from './windows';
import { readEntry, saveEntry, touchEntry } from './store';

export interface AllowanceService {
  /**
   * What one person may use now. Cached per user for the TTL, revalidated by ETag; when bdren.ai
   * cannot be reached the last answer is kept for up to `maxStaleMs`, then the Free allowance
   * applies. Never returns an unlimited allowance.
   */
  getAllowance: (who: AllowanceSubject) => Promise<ResolvedAllowance>;
  /** Fetches from bdren.ai now, ignoring the TTL. Used when a webhook says the answer changed. */
  refresh: (who: AllowanceSubject) => Promise<ResolvedAllowance>;
}

interface Deps {
  config: BdrenConfig;
  client: AllowanceClient;
  now?: () => Date;
}

function stamp(
  resolved: Omit<ResolvedAllowance, 'origin'>,
  origin: AllowanceOrigin,
): ResolvedAllowance {
  return { ...resolved, origin };
}

export function createAllowanceService({
  config,
  client,
  now = () => new Date(),
}: Deps): AllowanceService {
  const inflight = new Map<string, Promise<ResolvedAllowance>>();

  /** A cached entry belongs to this exact user, identity and account, or it is not used at all. */
  async function usableEntry(who: AllowanceSubject) {
    const entry = await readEntry(who.userId);
    if (!entry) {
      return null;
    }
    const sameOwner =
      String(entry.userId) === who.userId &&
      entry.issuer === who.issuer &&
      entry.subject === who.subject &&
      entry.tenantId === who.account;
    return sameOwner ? entry : null;
  }

  async function load(who: AllowanceSubject, force: boolean): Promise<ResolvedAllowance> {
    const at = now();
    const entry = await usableEntry(who);
    const fresh =
      !!entry && !entry.invalidatedAt && at.getTime() - entry.verifiedAt.getTime() < config.ttlMs;
    if (entry && fresh && !force) {
      const resolved = resolveAllowance(entry.allowance, config, at);
      if (resolved) {
        return stamp(resolved, 'cache');
      }
    }

    const result = await client.fetchAllowance(
      { issuer: who.issuer, subject: who.subject },
      force ? undefined : entry?.etag,
    );
    if (result.status === 'ok') {
      const moved =
        entry != null &&
        entry.allowance.windows.month?.start !== result.payload.windows.month?.start;
      await saveEntry(
        who,
        result.payload,
        at,
        moved ? entry.allowance.windows : (entry?.previousWindows ?? null),
      );
      const resolved = resolveAllowance(result.payload, config, at);
      if (resolved) {
        return stamp(resolved, 'fresh');
      }
      logger.warn('[bdren] allowance has no usable ai_credits limit; using the Free fallback');
      return fallbackAllowance(config, at);
    }
    if (result.status === 'not_modified' && entry) {
      await touchEntry(who.userId, at);
      const resolved = resolveAllowance(entry.allowance, config, at);
      if (resolved) {
        return stamp(resolved, 'cache');
      }
      return fallbackAllowance(config, at);
    }
    if (result.status === 'not_found') {
      logger.warn('[bdren] user unknown to bdren.ai; using the Free fallback');
      return fallbackAllowance(config, at);
    }

    const reason = result.status === 'error' ? result.reason : 'unexpected_not_modified';
    const stale =
      entry && at.getTime() - entry.verifiedAt.getTime() <= config.maxStaleMs
        ? resolveAllowance(entry.allowance, config, at)
        : null;
    if (stale) {
      logger.warn(`[bdren] allowance unavailable (${reason}); using the last answer`);
      return stamp(stale, 'stale');
    }
    logger.error(`[bdren] allowance unavailable (${reason}); using the Free fallback`);
    return fallbackAllowance(config, at);
  }

  function single(who: AllowanceSubject, force: boolean): Promise<ResolvedAllowance> {
    const key = `${who.userId}:${force ? 'f' : 'r'}`;
    const running = inflight.get(key);
    if (running) {
      return running;
    }
    const promise = load(who, force).finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  }

  return {
    getAllowance: (who) => single(who, false),
    refresh: (who) => single(who, true),
  };
}
