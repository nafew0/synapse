import { Constants, toErrorReference } from 'librechat-data-provider';
import type { TIssueReportRequest } from 'librechat-data-provider';
import type { TErrorSummary } from '~/errors/public';
import { checkEmailConfig } from '~/utils/email';
import { resolveBuildInfo } from '~/app/build';

export const ISSUE_REPORT_TEMPLATE = 'issueReport.handlebars';

const SUBJECT_PART_MAX = 60;

export type TReporter = {
  id: string;
  name?: string;
  email: string;
  username?: string;
  role?: string;
  tenantId?: string;
  institution?: string;
};

/** Support only needs where and why it failed; ownership fields stay server-side. */
type TEmailSummary = Omit<TErrorSummary, 'userId' | 'conversationId' | 'agentId'> & {
  reference?: string;
};

type TEmailRecentError = {
  code: string;
  requestId?: string;
  reference?: string;
  occurredAt?: string;
  page?: string;
};

/** Data handed to `issueReport.handlebars`. Every value is rendered through escaped `{{ }}`. */
export type TIssueReportPayload = {
  name: string;
  reporter: TReporter;
  description?: string;
  lastMessage?: string;
  context: {
    code?: string;
    requestId?: string;
    reference?: string;
    page?: string;
    conversationId?: string;
    messageId?: string;
    occurredAt?: string;
    serverTime: string;
    environment?: string;
    appVersion: string;
    clientAppVersion?: string;
    browser?: string;
    language?: string;
    timezone?: string;
    screen?: string;
  };
  summaries: TEmailSummary[];
  missing: string[];
  recentErrors: TEmailRecentError[];
};

export type TIssueReportEmail = {
  email: string;
  subject: string;
  replyTo: string;
  template: string;
  payload: TIssueReportPayload;
};

/** Comma-separated `SUPPORT_REPORT_EMAIL` addresses. */
export function getSupportRecipients(): string[] {
  return (process.env.SUPPORT_REPORT_EMAIL ?? '')
    .split(',')
    .map((address) => address.trim())
    .filter(Boolean);
}

/** Reporting needs a working mail transport and at least one support address. */
export function isIssueReportingEnabled(): boolean {
  return checkEmailConfig() && getSupportRecipients().length > 0;
}

/** First support address, shown to users as the fallback contact. */
export function getSupportEmail(): string | undefined {
  return getSupportRecipients()[0];
}

function getAppVersion(): string {
  const { commitShort } = resolveBuildInfo();
  return commitShort ? `${Constants.VERSION} (${commitShort})` : Constants.VERSION;
}

function toSubjectPart(value: string | undefined, fallback: string): string {
  const clean = (value ?? '').replace(/\s+/g, ' ').trim().slice(0, SUBJECT_PART_MAX);
  return clean || fallback;
}

function toEmailSummary(summary: TErrorSummary): TEmailSummary {
  return {
    requestId: summary.requestId,
    reference: toErrorReference(summary.requestId),
    code: summary.code,
    status: summary.status,
    message: summary.message,
    stack: summary.stack,
    route: summary.route,
    provider: summary.provider,
    model: summary.model,
    at: summary.at,
  };
}

export type TBuildIssueReportParams = {
  report: TIssueReportRequest;
  reporter: TReporter;
  summaries: TErrorSummary[];
  missing: string[];
  recipients: string[];
  now?: Date;
};

export function buildIssueReportEmail({
  report,
  reporter,
  summaries,
  missing,
  recipients,
  now = new Date(),
}: TBuildIssueReportParams): TIssueReportEmail {
  const reference = toErrorReference(report.requestId);
  const subject = [
    '[Synapse] Issue report',
    toSubjectPart(report.code, 'general'),
    toSubjectPart(reporter.institution, 'no institution'),
    reference ?? 'no ref',
  ].join(' · ');

  return {
    email: recipients.join(', '),
    subject,
    replyTo: reporter.email,
    template: ISSUE_REPORT_TEMPLATE,
    payload: {
      name: 'Synapse Support',
      reporter,
      description: report.description || undefined,
      lastMessage: report.lastMessage || undefined,
      context: {
        code: report.code,
        requestId: report.requestId,
        reference,
        page: report.page,
        conversationId: report.conversationId,
        messageId: report.messageId,
        occurredAt: report.occurredAt,
        serverTime: now.toISOString(),
        environment: process.env.DOMAIN_CLIENT,
        appVersion: getAppVersion(),
        clientAppVersion: report.client?.appVersion,
        browser: report.client?.userAgent,
        language: report.client?.language,
        timezone: report.client?.timezone,
        screen: report.client?.screen,
      },
      summaries: summaries.map(toEmailSummary),
      missing,
      recentErrors: (report.recentErrors ?? []).map((entry) => ({
        ...entry,
        reference: toErrorReference(entry.requestId),
      })),
    },
  };
}
