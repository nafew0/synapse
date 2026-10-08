import { z } from 'zod';

/** Response header carrying the server-side request id used to correlate logs. */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * User-safe error codes. The server sends only a code and a request id; the client
 * maps the code to localized text. Raw error text never leaves the server.
 */
export enum PublicErrorCodes {
  SERVICE_BUSY = 'service_busy',
  SERVICE_UNAVAILABLE = 'service_unavailable',
  CONTEXT_TOO_LONG = 'context_too_long',
  CONTENT_FILTERED = 'content_filtered',
  MODEL_UNAVAILABLE = 'model_unavailable',
  TOOLS_UNAVAILABLE = 'tools_unavailable',
  CONNECTION_LOST = 'connection_lost',
  NOT_FOUND = 'not_found',
  FORBIDDEN = 'forbidden',
  REQUEST_FAILED = 'request_failed',
  REPORT_FAILED = 'report_failed',
  UNKNOWN = 'unknown',
}

export type TPublicError = {
  code: string;
  requestId?: string;
};

const publicErrorCodeSet = new Set<string>(Object.values(PublicErrorCodes));

export function isPublicErrorCode(value: unknown): value is PublicErrorCodes {
  return typeof value === 'string' && publicErrorCodeSet.has(value);
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

export function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value);
}

/** Short form of a request id shown to users as a support reference. */
export function toErrorReference(requestId?: string): string | undefined {
  if (!isRequestId(requestId)) {
    return undefined;
  }
  return requestId.replace(/-/g, '').slice(0, 8);
}

export const ISSUE_REPORT_LIMITS = {
  description: 2000,
  shownMessage: 500,
  lastMessage: 4000,
  recentErrors: 5,
  field: 256,
} as const;

const shortText = z.string().trim().max(ISSUE_REPORT_LIMITS.field);

export const issueReportErrorSchema = z
  .object({
    code: shortText,
    requestId: z.string().regex(REQUEST_ID_PATTERN).optional(),
    occurredAt: z.string().datetime().optional(),
    page: shortText.optional(),
  })
  .strict();

export const issueReportSchema = z
  .object({
    description: z.string().trim().max(ISSUE_REPORT_LIMITS.description).optional(),
    shownMessage: z.string().trim().max(ISSUE_REPORT_LIMITS.shownMessage).optional(),
    lastMessage: z.string().max(ISSUE_REPORT_LIMITS.lastMessage).optional(),
    code: shortText.optional(),
    requestId: z.string().regex(REQUEST_ID_PATTERN).optional(),
    conversationId: shortText.optional(),
    messageId: shortText.optional(),
    page: shortText.regex(/^\//).optional(),
    occurredAt: z.string().datetime().optional(),
    recentErrors: z.array(issueReportErrorSchema).max(ISSUE_REPORT_LIMITS.recentErrors).optional(),
    client: z
      .object({
        appVersion: shortText.optional(),
        userAgent: z.string().max(512).optional(),
        language: shortText.optional(),
        timezone: shortText.optional(),
        screen: shortText.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type TIssueReportError = z.infer<typeof issueReportErrorSchema>;
export type TIssueReportRequest = z.infer<typeof issueReportSchema>;
