import { Constants, isRequestId, ISSUE_REPORT_LIMITS } from 'librechat-data-provider';
import type { TMessage, TStartupConfig, TIssueReportRequest } from 'librechat-data-provider';
import { getRecentErrors } from '~/utils/errors';

export type TReportContext = {
  code?: string;
  requestId?: string;
  conversationId?: string;
  messageId?: string;
};

const USER_AGENT_LIMIT = 512;

const optional = (value?: string | null): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, ISSUE_REPORT_LIMITS.field) : undefined;
};

/** Returns the conversation id only when it names a saved conversation. */
export const knownConversation = (conversationId?: string | null): string | undefined =>
  conversationId && conversationId !== Constants.NEW_CONVO ? conversationId : undefined;

/** Text of the most recent message the user wrote, capped to the report limit. */
export function getLastUserMessage(messages?: TMessage[]): string | undefined {
  if (!messages) {
    return undefined;
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.isCreatedByUser === true && message.text?.trim()) {
      return message.text.slice(0, ISSUE_REPORT_LIMITS.lastMessage);
    }
  }
  return undefined;
}

function getClientInfo(startupConfig?: TStartupConfig): TIssueReportRequest['client'] {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  const screenSize =
    typeof window === 'undefined' ? undefined : `${window.screen.width}x${window.screen.height}`;
  return {
    appVersion: optional(startupConfig?.buildInfo?.commitShort ?? startupConfig?.buildInfo?.commit),
    userAgent: nav?.userAgent?.slice(0, USER_AGENT_LIMIT) || undefined,
    language: optional(nav?.language),
    timezone: optional(Intl.DateTimeFormat().resolvedOptions().timeZone),
    screen: optional(screenSize),
  };
}

export function buildReport({
  context,
  description,
  lastMessage,
  startupConfig,
}: {
  context: TReportContext;
  description: string;
  lastMessage?: string;
  startupConfig?: TStartupConfig;
}): TIssueReportRequest {
  const recentErrors = getRecentErrors();
  const text = description.trim().slice(0, ISSUE_REPORT_LIMITS.description);
  return {
    description: text || undefined,
    lastMessage,
    code: optional(context.code),
    requestId: isRequestId(context.requestId) ? context.requestId : undefined,
    conversationId: optional(knownConversation(context.conversationId)),
    messageId: optional(context.messageId),
    page: optional(window.location.pathname),
    occurredAt: new Date().toISOString(),
    recentErrors: recentErrors.length > 0 ? recentErrors : undefined,
    client: getClientInfo(startupConfig),
  };
}
