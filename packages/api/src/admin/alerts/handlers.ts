import { isValidObjectId } from 'mongoose';
import { logger } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';
import { listAlerts, markSeen } from './store';
import { runAlertChecks } from './runner';

/** Routes for platform superadmins; the caller mounts them behind that check. */
type AlertHandler = (req: ServerRequest, res: Response) => Promise<Response>;

export interface AlertHandlers {
  list: AlertHandler;
  seen: AlertHandler;
  check: AlertHandler;
}

export function createAlertHandlers(): AlertHandlers {
  const fail = (res: Response, message: string, error: unknown) => {
    logger.error(`[alerts] ${message}`, error);
    return res.status(500).json({ error: message });
  };

  const list = async (_req: ServerRequest, res: Response) => {
    try {
      const alerts = await listAlerts();
      const unseen = alerts.filter((alert) => alert.status === 'open' && !alert.seenAt).length;
      return res.status(200).json({ alerts, unseen });
    } catch (error) {
      return fail(res, 'Failed to load alerts', error);
    }
  };

  const seen = async (req: ServerRequest, res: Response) => {
    const alertId = (req.params as { id?: string }).id;
    if (alertId !== undefined && !isValidObjectId(alertId)) {
      return res.status(400).json({ error: 'Invalid alert id' });
    }
    try {
      const changed = await markSeen(req.user?.id ?? '', alertId);
      return res.status(200).json({ changed });
    } catch (error) {
      return fail(res, 'Failed to mark alerts as seen', error);
    }
  };

  const check = async (_req: ServerRequest, res: Response) => {
    try {
      const summary = await runAlertChecks();
      return res.status(200).json({ ...summary, alerts: await listAlerts() });
    } catch (error) {
      return fail(res, 'Failed to run alert checks', error);
    }
  };

  return { list, seen, check } satisfies AlertHandlers;
}
