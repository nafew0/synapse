import { z } from 'zod';
import mongoose from 'mongoose';
import { logger, runAsSystem } from '@librechat/data-schemas';
import type { IBdrenEvent, IInstitution } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { Model } from 'mongoose';
import type { AllowanceSubject, BdrenConfig } from './types';
import type { OrganizationRef } from './provision';
import type { AllowanceService } from './allowance';
import {
  readEntry,
  invalidateSubject,
  clearPreviousWindows,
  invalidateOrganization,
} from './store';
import { normalizeOpenIdIssuer } from '~/auth/openid';
import { verifyWebhookSignature } from './signature';
import { carryOverUsage } from './carryover';

const eventSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.string().min(1).max(100),
  reason: z.string().nullish(),
  user: z.object({ issuer: z.string(), subject: z.string() }).nullish(),
  organization: z
    .object({
      id: z.string(),
      slug: z.string().nullish(),
      name: z.string().nullish(),
    })
    .passthrough()
    .nullish(),
});

export interface WebhookDeps {
  config: BdrenConfig;
  service: AllowanceService;
  /** The Synapse user behind a bdren.ai identity, for the upgrade carry-over. */
  findSubject: (issuer: string, subject: string) => Promise<AllowanceSubject | null>;
  /** Creates the institution of an organization Synapse does not know yet; without it unknown organizations are ignored. */
  ensureInstitution?: (org: OrganizationRef) => Promise<string | null>;
  /**
   * Re-checks one person's coverage with a fresh answer and moves them between institutions when
   * it changed. Called for `membership.coverage_changed`, after any new institution exists.
   */
  reviewMember?: (issuer: string, subject: string, review: CoverageReview) => Promise<void>;
  now?: () => Date;
}

/** What a `membership.coverage_changed` says about the person it names. */
export interface CoverageReview {
  /** bdren.ai's `reason`; `null` from a bdren.ai that does not send one. */
  reason: string | null;
  /** An admin or BDREN support decided about this person (or their institution's status changed). */
  decided: boolean;
}

/**
 * `membership.coverage_changed` reasons that are a decision about the person. Anything else (the
 * institution's own sign-in creating an affiliated membership, a sign-up request, `imported` from
 * the one-off Synapse member import, no reason at all) is bdren.ai recording the person, not
 * deciding about them: the review still ends a migration hold once they are covered there.
 */
const COVERAGE_DECISIONS = new Set([
  'covered',
  'uncovered',
  'seats_reduced',
  'removed',
  'suspended',
  'reactivated',
  'invite_accepted',
  'organization_status',
]);

/** Whether a coverage event's `reason` is a decision about the person it names. */
export function isCoverageDecision(reason?: string | null): boolean {
  return reason != null && COVERAGE_DECISIONS.has(reason);
}

/** Events that mean an organization is live; teardown (expired, cancelled, downgraded, suspended) never creates one. */
const LIVE_SUBSCRIPTION_EVENT = /^subscription\.(activated|renewed|upgraded|limits_changed)$/;
/** `limits_changed` follows every change and names the original event in `reason`; a teardown must not create anything. */
const TEARDOWN_REASON = /(^|\.)(expired|cancel+ed|downgraded)$/;
const COVERAGE_EVENT = 'membership.coverage_changed';

/** A membership change names a person; the same event type without one is an organization status change. */
function shouldProvision(event: { type: string; reason?: string | null; user?: unknown }): boolean {
  if (TEARDOWN_REASON.test(event.reason ?? '')) {
    return false;
  }
  return (
    LIVE_SUBSCRIPTION_EVENT.test(event.type) ||
    (event.type === COVERAGE_EVENT && event.user != null)
  );
}

const DUPLICATE_KEY = 11000;

const events = (): Model<IBdrenEvent> => mongoose.models.BdrenEvent as Model<IBdrenEvent>;

async function tenantOfOrganization(organizationId: string): Promise<string | null> {
  const institution = await runAsSystem(() =>
    (mongoose.models.Institution as Model<IInstitution>)
      .findOne({ bdrenOrganizationId: organizationId })
      .select('tenantId')
      .lean<{ tenantId: string }>()
      .exec(),
  );
  return institution?.tenantId ?? null;
}

/**
 * `POST /api/bdren/webhook`. The route must hand it the raw body (`express.raw`), because the
 * signature covers the bytes as sent. Every event means "refresh": the cached answer of the named
 * person, or of every member of the named institution, is marked stale, and an upgrade also
 * carries the old windows' usage into the new ones. A coverage change for a person also moves
 * them between institutions (`reviewMember`). Idempotent by event id; answers 204.
 */
export function createWebhookHandler({
  config,
  service,
  findSubject,
  ensureInstitution,
  reviewMember,
  now = () => new Date(),
}: WebhookDeps) {
  async function process(event: z.infer<typeof eventSchema>, at: Date): Promise<void> {
    if (event.user) {
      const issuer = normalizeOpenIdIssuer(event.user.issuer) ?? event.user.issuer;
      const who =
        event.type === 'subscription.upgraded'
          ? await findSubject(issuer, event.user.subject)
          : null;
      const before = who ? await readEntry(who.userId) : null;
      await invalidateSubject(issuer, event.user.subject, at);
      if (who && before && before.subject === who.subject && before.tenantId === who.account) {
        const fresh = await service.refresh(who);
        const after = await readEntry(who.userId);
        if (fresh.origin !== 'fresh' || !after) {
          throw new Error('allowance refresh failed; the upgrade is retried on redelivery');
        }
        const oldWindows = after.previousWindows ?? before.allowance.windows;
        const moved = await carryOverUsage(who, oldWindows, after.allowance.windows, event.id, at);
        await clearPreviousWindows(who.userId);
        logger.info(`[bdren] upgrade carry-over seeded month=${moved.month} week=${moved.week}`);
      }
    }
    if (event.organization) {
      const org = event.organization;
      const known = await tenantOfOrganization(org.id);
      const tenantId =
        known ??
        (ensureInstitution && shouldProvision(event)
          ? await ensureInstitution({ id: org.id, slug: org.slug, name: org.name ?? org.slug })
          : null);
      await invalidateOrganization(org.id, tenantId, at);
    }
    if (event.type === COVERAGE_EVENT && event.user && reviewMember) {
      const reason = event.reason ?? null;
      await reviewMember(
        normalizeOpenIdIssuer(event.user.issuer) ?? event.user.issuer,
        event.user.subject,
        { reason, decided: isCoverageDecision(reason) },
      );
    }
  }

  return async function handleWebhook(req: Request, res: Response): Promise<Response> {
    const rawBody = req.body;
    if (!Buffer.isBuffer(rawBody)) {
      return res.status(400).json({ error: 'raw body required' });
    }
    const verdict = verifyWebhookSignature({
      secrets: config.webhookSecrets,
      timestamp: req.get('X-BdREN-Timestamp'),
      signature: req.get('X-BdREN-Signature'),
      rawBody,
    });
    if (!verdict.ok) {
      logger.warn(`[bdren] webhook rejected: ${verdict.reason}`);
      return res.status(401).json({ error: 'invalid signature' });
    }
    let event: z.infer<typeof eventSchema>;
    try {
      event = eventSchema.parse(JSON.parse(rawBody.toString('utf8')));
    } catch {
      return res.status(400).json({ error: 'invalid event' });
    }
    const at = now();
    try {
      await events().create({ eventId: event.id, type: event.type, receivedAt: at });
    } catch (error) {
      if ((error as { code?: number })?.code === DUPLICATE_KEY) {
        return res.status(204).end();
      }
      logger.error('[bdren] webhook dedupe failed', error);
      return res.status(500).json({ error: 'failed' });
    }
    try {
      await process(event, at);
      return res.status(204).end();
    } catch (error) {
      logger.error('[bdren] webhook processing failed', error);
      await events().deleteOne({ eventId: event.id }).exec();
      return res.status(500).json({ error: 'failed' });
    }
  };
}
