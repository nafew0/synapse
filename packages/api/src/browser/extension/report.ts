import { z } from 'zod';
import { Types } from 'mongoose';
import { logger } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { BrowserExtensionMethods } from '@librechat/data-schemas';
import type { ExtensionRequest } from './auth';

/**
 * A run the user sends from the extension when it went wrong: each step's tool, its arguments with typed text
 * replaced by its length, and how it ended. Never what the page showed: the extension leaves results out, and this
 * schema has no place for them.
 */
export const ReportSchema = z.object({
  extensionVersion: z.string().min(1).max(40),
  build: z.string().max(40).optional(),
  llmModel: z.string().max(200).optional(),
  status: z.string().min(1).max(40),
  outcome: z.string().max(40).optional(),
  reason: z.string().max(1000).optional(),
  turns: z.number().int().min(0).max(10_000),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  hosts: z.array(z.string().max(253)).max(50),
  comment: z.string().max(2000).optional(),
  steps: z
    .array(
      z.object({
        tool: z.string().min(1).max(60),
        args: z.string().max(600),
        ok: z.boolean(),
        code: z.string().max(60).optional(),
      }),
    )
    .max(500),
});

export type ReportBody = z.infer<typeof ReportSchema>;

export function createReportHandler(deps: {
  store: Pick<BrowserExtensionMethods, 'recordBrowserExtensionReport'>;
}): (req: ExtensionRequest, res: Response) => Promise<void> {
  return async (req, res) => {
    const parsed = ReportSchema.safeParse((req as ExtensionRequest & { body?: unknown }).body);
    if (!parsed.success || !req.user?.id) {
      res
        .status(400)
        .json({ error: { code: 'bad_report', message: 'The report could not be read.' } });
      return;
    }
    try {
      const id = await deps.store.recordBrowserExtensionReport({
        ...parsed.data,
        user: new Types.ObjectId(String(req.user.id)),
        tenantId: req.user.tenantId,
        createdAt: new Date(),
      });
      res.status(201).json({ id: String(id) });
    } catch (error) {
      logger.error('[browserExtension] run report not kept', error);
      res
        .status(500)
        .json({ error: { code: 'not_kept', message: 'The report could not be kept.' } });
    }
  };
}
