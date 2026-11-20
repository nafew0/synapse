import { z } from 'zod';
import { logger } from '@librechat/data-schemas';
import type { RecordAuditEntryInput, RecordAuditEntryOptions } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';
import { getProviderSpendModel, saveSpend } from './store';
import { buildAuditContext } from '~/admin/context';
import { buildReconciliation } from './view';
import { parseRange } from '~/usage/spend';
import { dhakaDay } from '~/usage/rollup';
import { syncProviders } from './sync';

export interface ReconcileDeps {
  recordAuditEntry: (
    input: RecordAuditEntryInput,
    options?: RecordAuditEntryOptions,
  ) => Promise<unknown>;
}

type Handler = (req: ServerRequest, res: Response) => Promise<void>;

export interface ReconcileHandlers {
  view: Handler;
  refresh: Handler;
  enterUnstructured: Handler;
}

const entryBody = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  amountUsd: z.number().finite().min(0).max(1_000_000),
  pages: z.number().int().min(0).max(1_000_000_000).optional(),
  note: z.string().trim().max(200).optional(),
});

const refreshBody = z.object({
  days: z.number().int().min(1).max(30).optional(),
  firecrawlAsOfDay: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export function createReconcileHandlers(deps: ReconcileDeps): ReconcileHandlers {
  const guard =
    (label: string, run: Handler): Handler =>
    async (req, res) => {
      try {
        await run(req, res);
      } catch (error) {
        if (error instanceof RangeError) {
          res.status(400).json({ error: error.message });
          return;
        }
        logger.error(`[reconcile] ${label} failed`, error);
        res.status(500).json({ error: `Failed to ${label}` });
      }
    };

  const view = guard('load reconciliation', async (req, res) => {
    const range = parseRange(req.query as { start?: unknown; end?: unknown });
    res.json(await buildReconciliation(range));
  });

  const refresh = guard('refresh provider figures', async (req, res) => {
    const parsed = refreshBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: 'Invalid request', issues: parsed.error.flatten().fieldErrors });
      return;
    }
    const yesterday = dhakaDay(new Date(Date.now() - 86_400_000));
    if (parsed.data.firecrawlAsOfDay && parsed.data.firecrawlAsOfDay !== yesterday) {
      res.status(400).json({ error: 'firecrawlAsOfDay must be yesterday (Asia/Dhaka)' });
      return;
    }
    const actorId = req.user?.id ?? req.user?._id?.toString() ?? null;
    const results = await syncProviders(parsed.data);
    await deps.recordAuditEntry({
      action: 'platform.provider_spend_entered',
      severity: 'info',
      actor: {
        type: 'user',
        id: actorId ?? undefined,
        name: req.user?.name || req.user?.email || 'platform-superadmin',
      },
      target: { type: 'provider_spend', id: 'refresh', name: 'Provider figures refresh' },
      metadata: { trigger: 'manual_refresh', days: parsed.data.days ?? 'default' },
      context: buildAuditContext(req),
      tenantId: undefined,
    });
    res.json({ results });
  });

  const enterUnstructured = guard('save the Unstructured figure', async (req, res) => {
    const parsed = entryBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: 'Invalid request', issues: parsed.error.flatten().fieldErrors });
      return;
    }
    const { month, amountUsd, pages, note } = parsed.data;
    if (month > dhakaDay(new Date()).slice(0, 7)) {
      res.status(400).json({ error: 'The month has not started yet' });
      return;
    }
    const actorId = req.user?.id ?? req.user?._id?.toString() ?? null;
    const previous = await getProviderSpendModel()
      .findOne({ service: 'unstructured', period: month })
      .lean<{ amount: number | null }>();
    await deps.recordAuditEntry(
      {
        action: 'platform.provider_spend_entered',
        severity: 'info',
        actor: {
          type: 'user',
          id: actorId ?? undefined,
          name: req.user?.name || req.user?.email || 'platform-superadmin',
        },
        target: {
          type: 'provider_spend',
          id: `unstructured:${month}`,
          name: 'Unstructured invoice',
        },
        metadata: {
          service: 'unstructured',
          month,
          amountUsd,
          previous_amountUsd: previous?.amount ?? 'none',
          pages: pages ?? 'none',
        },
        context: buildAuditContext(req),
        tenantId: undefined,
      },
      { failClosed: true },
    );
    await saveSpend({
      service: 'unstructured',
      period: month,
      kind: 'month',
      amount: amountUsd,
      source: 'manual',
      pages,
      note,
      enteredBy: actorId,
      fetchedAt: new Date(),
    });
    res.json({ month, amountUsd, pages: pages ?? null, note: note ?? null });
  });

  return { view, refresh, enterUnstructured } satisfies ReconcileHandlers;
}
