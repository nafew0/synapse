import { issueReportSchema } from 'librechat-data-provider';
import type { TIssueReportRequest } from 'librechat-data-provider';

/** Maximum request ids (the main one plus recent errors) whose summaries are attached. */
export const MAX_REPORT_REQUEST_IDS = 6;

export function parseIssueReport(body: unknown): TIssueReportRequest | undefined {
  const result = issueReportSchema.safeParse(body);
  return result.success ? result.data : undefined;
}

/** Main request id first, then recent-error ids; deduplicated and capped. */
export function collectRequestIds(report: TIssueReportRequest): string[] {
  const ids = new Set<string>();
  if (report.requestId) {
    ids.add(report.requestId);
  }
  for (const entry of report.recentErrors ?? []) {
    if (ids.size >= MAX_REPORT_REQUEST_IDS) {
      break;
    }
    if (entry.requestId) {
      ids.add(entry.requestId);
    }
  }
  return [...ids];
}
