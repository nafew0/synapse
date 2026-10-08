import { logger, getRequestId } from '@librechat/data-schemas';
import { CacheKeys, PublicErrorCodes } from 'librechat-data-provider';
import type { Response } from 'express';
import type { Keyv } from 'keyv';
import type { TIssueReportEmail, TReporter } from './service';
import type { TErrorSummary } from '~/errors/public';
import type { ServerRequest } from '~/types/http';
import { buildIssueReportEmail, getSupportRecipients, isIssueReportingEnabled } from './service';
import { collectRequestIds, parseIssueReport } from './schema';
import { getErrorSummary } from '~/errors/public';
import { standardCache } from '~/cache';

const DEDUP_TTL_MS = 10 * 60 * 1000;

export type TSendIssueReportEmail = (
  params: TIssueReportEmail & { throwError: boolean },
) => Promise<unknown>;

export interface IssueReportDeps {
  /** `api/server/utils/sendEmail.js` */
  sendEmail: TSendIssueReportEmail;
  /** Resolves an institution's display name for a tenant. */
  getInstitutionName: (tenantId: string) => Promise<string | null | undefined>;
  /** Defaults to `standardCache(CacheKeys.ISSUE_REPORTS, 10 min)`. */
  dedupCache?: Keyv;
}

export interface IssueReportHandlers {
  createReport: (req: ServerRequest, res: Response) => Promise<void>;
}

type TLoadedSummaries = { summaries: TErrorSummary[]; missing: string[] };

function currentRequestId(req: ServerRequest): string | undefined {
  return getRequestId() ?? (req as ServerRequest & { requestId?: string }).requestId;
}

async function loadSummaries(requestIds: string[], userId: string): Promise<TLoadedSummaries> {
  const found = await Promise.all(requestIds.map((id) => getErrorSummary(id, userId)));
  return found.reduce<TLoadedSummaries>(
    (acc, summary, index) => {
      if (summary) {
        acc.summaries.push(summary);
      } else {
        acc.missing.push(requestIds[index]);
      }
      return acc;
    },
    { summaries: [], missing: [] },
  );
}

async function resolveInstitution(
  deps: IssueReportDeps,
  tenantId: string | undefined,
): Promise<string | undefined> {
  if (!tenantId) {
    return undefined;
  }
  try {
    return (await deps.getInstitutionName(tenantId)) ?? undefined;
  } catch (error) {
    logger.warn('[reports] Failed to resolve institution name', (error as Error).message);
    return undefined;
  }
}

export function createIssueReportHandlers(deps: IssueReportDeps): IssueReportHandlers {
  const dedupCache = deps.dedupCache ?? standardCache(CacheKeys.ISSUE_REPORTS, DEDUP_TTL_MS);

  async function isDuplicate(key: string | undefined): Promise<boolean> {
    if (!key) {
      return false;
    }
    try {
      if (await dedupCache.get(key)) {
        return true;
      }
      await dedupCache.set(key, true);
    } catch (error) {
      logger.warn('[reports] Dedup cache unavailable', (error as Error).message);
    }
    return false;
  }

  async function clearDedup(key: string | undefined): Promise<void> {
    if (!key) {
      return;
    }
    await dedupCache.delete(key).catch((error: Error) => {
      logger.warn('[reports] Failed to clear dedup key', error.message);
    });
  }

  async function send(
    email: TIssueReportEmail,
    dedupKey: string | undefined,
    req: ServerRequest,
    res: Response,
  ): Promise<void> {
    try {
      await deps.sendEmail({ ...email, throwError: true });
      res.status(202).json({});
    } catch (error) {
      const reason = (error as Error).message;
      logger.error(
        `[reports] Failed to send issue report email (${reason}); report kept in this log entry`,
        {
          error: reason,
          subject: email.subject,
          report: email.payload,
        },
      );
      await clearDedup(dedupKey);
      res
        .status(502)
        .json({ code: PublicErrorCodes.REPORT_FAILED, requestId: currentRequestId(req) });
    }
  }

  async function createReport(req: ServerRequest, res: Response): Promise<void> {
    const user = req.user;
    const userId = user?._id?.toString() ?? user?.id;
    if (!user || !userId) {
      res.status(401).json({ code: PublicErrorCodes.FORBIDDEN });
      return;
    }
    if (!isIssueReportingEnabled()) {
      res.status(503).json({ code: PublicErrorCodes.REPORT_FAILED });
      return;
    }

    const report = parseIssueReport(req.body);
    if (!report) {
      res
        .status(400)
        .json({ code: PublicErrorCodes.REQUEST_FAILED, requestId: currentRequestId(req) });
      return;
    }

    const dedupKey = report.requestId ? `${userId}:${report.requestId}` : undefined;
    if (await isDuplicate(dedupKey)) {
      res.status(202).json({});
      return;
    }

    const [institution, { summaries, missing }] = await Promise.all([
      resolveInstitution(deps, user.tenantId),
      loadSummaries(collectRequestIds(report), userId),
    ]);

    const reporter: TReporter = {
      id: userId,
      name: user.name,
      email: user.email,
      username: user.username,
      role: user.role,
      tenantId: user.tenantId,
      institution,
    };

    const email = buildIssueReportEmail({
      report,
      reporter,
      summaries,
      missing,
      recipients: getSupportRecipients(),
    });
    await send(email, dedupKey, req, res);
  }

  return { createReport };
}
