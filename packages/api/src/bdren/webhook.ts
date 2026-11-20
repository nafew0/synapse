import { z } from 'zod';
import mongoose from 'mongoose';
import { logger, runAsSystem } from '@librechat/data-schemas';
import type { IBdrenEvent, IInstitution } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { Model } from 'mongoose';
import type { AllowanceSubject, BdrenConfig } from './types';
import type { AllowanceService } from './allowance';
import { invalidateOrganization, invalidateSubject, readEntry } from './store';
import { verifyWebhookSignature } from './signature';
import { carryOverUsage } from './carryover';

const eventSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.string().min(1).max(100),
  user: z.object({ issuer: z.string(), subject: z.string() }).nullish(),
  organization: z.object({ id: z.string() }).passthrough().nullish(),
});

export interface WebhookDeps {
  config: BdrenConfig;
  service: AllowanceService;
  /** The Synapse user behind a bdren.ai identity, for the upgrade carry-over. */
  findSubject: (issuer: string, subject: string) => Promise<AllowanceSubject | null>;
  now?: () => Date;
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
 * carries the old windows' usage into the new ones. Idempotent by event id; answers 204.
 */
export function createWebhookHandler({
  config,
  service,
  findSubject,
  now = () => new Date(),
}: WebhookDeps) {
  async function process(event: z.infer<typeof eventSchema>, at: Date): Promise<void> {
    if (event.user) {
      const who =
        event.type === 'subscription.upgraded'
          ? await findSubject(event.user.issuer, event.user.subject)
          : null;
      const before = who ? await readEntry(who.userId) : null;
      await invalidateSubject(event.user.issuer, event.user.subject, at);
      if (who && before && before.subject === who.subject && before.tenantId === who.account) {
        const fresh = await service.refresh(who);
        const after = await readEntry(who.userId);
        if (after && fresh.origin === 'fresh') {
          const moved = await carryOverUsage(who, before.allowance, after.allowance, event.id);
          logger.info(`[bdren] upgrade carry-over seeded month=${moved.month} week=${moved.week}`);
        }
      }
    }
    if (event.organization) {
      const tenantId = await tenantOfOrganization(event.organization.id);
      await invalidateOrganization(event.organization.id, tenantId, at);
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
