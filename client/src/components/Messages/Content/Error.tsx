import { useContext, useEffect, useMemo } from 'react';
import { Button } from '@librechat/client';
import {
  ErrorTypes,
  ViolationTypes,
  PublicErrorCodes,
  toErrorReference,
} from 'librechat-data-provider';
import type { ContextType } from 'react';
import type { TErrorInfo } from '~/utils/errors';
import type { TranslationKeys } from '~/hooks';
import { getErrorInfo, publicErrorKeys, recordError } from '~/utils/errors';
import { useGenerationsByLatest, useLocalize } from '~/hooks';
import { ChatContext, useMessageContext } from '~/Providers';
import { ReportButton } from '~/components/Report';
import { useGetAddedConvo } from '~/hooks/Chat';

/** Code stored on a response that stopped before it finished (see `UnfinishedMessage`). */
export const UNFINISHED_ERROR_CODE = 'response_incomplete';

const langChainModelNotFoundUrl = /langchain\.com\/.*\/MODEL_NOT_FOUND(?:\/|\b)/i;

/**
 * Every code the chat can show. None interpolate model, provider or endpoint names;
 * anything not listed (including legacy raw error text) renders the generic message.
 */
const errorKeys: Record<string, TranslationKeys> = {
  ...publicErrorKeys,
  [ErrorTypes.MODERATION]: 'com_error_moderation',
  [ErrorTypes.NO_USER_KEY]: 'com_error_no_user_key',
  [ErrorTypes.INVALID_USER_KEY]: 'com_error_invalid_user_key',
  [ErrorTypes.EXPIRED_USER_KEY]: 'com_error_user_key_expired',
  [ErrorTypes.NO_BASE_URL]: 'com_error_no_base_url',
  [ErrorTypes.INVALID_BASE_URL]: 'com_error_invalid_base_url',
  [ErrorTypes.INVALID_ACTION]: 'com_error_invalid_action_error',
  [ErrorTypes.INVALID_REQUEST]: 'com_error_invalid_request_error',
  [ErrorTypes.NO_SYSTEM_MESSAGES]: 'com_error_no_system_messages',
  [ErrorTypes.REFUSAL]: 'com_error_content_filtered',
  [ErrorTypes.INPUT_LENGTH]: 'com_error_context_too_long',
  [ErrorTypes.MISSING_MODEL]: 'com_error_no_model_selected',
  [ErrorTypes.MODELS_NOT_LOADED]: 'com_error_models_not_loaded',
  [ErrorTypes.ENDPOINT_MODELS_NOT_LOADED]: 'com_error_models_not_loaded',
  [ErrorTypes.INVALID_AGENT_PROVIDER]: 'com_error_model_unavailable',
  [ErrorTypes.GOOGLE_ERROR]: 'com_error_unknown',
  [ErrorTypes.GOOGLE_TOOL_CONFLICT]: 'com_error_google_tool_conflict',
  [ErrorTypes.GOOGLE_VIDEO_UNPROCESSABLE]: 'com_error_google_video_unprocessable',
  [ErrorTypes.RESOURCE_RECOVERY_REQUIRED]: 'com_error_resource_recovery_required',
  [ErrorTypes.STREAM_EXPIRED]: 'com_error_stream_expired',
  [ViolationTypes.BAN]: 'com_error_ban',
  [ViolationTypes.TOKEN_BALANCE]: 'com_error_token_balance',
  [ViolationTypes.ILLEGAL_MODEL_REQUEST]: 'com_error_model_unavailable',
  invalid_api_key: 'com_error_model_unavailable',
  insufficient_quota: 'com_error_model_unavailable',
  concurrent: 'com_error_concurrent',
  message_limit: 'com_error_message_limit',
  [UNFINISHED_ERROR_CODE]: 'com_error_response_incomplete',
};

type TChat = NonNullable<ContextType<typeof ChatContext>>;

type TErrorProps = {
  text: string;
  messageId?: string;
  conversationId?: string | null;
};

function parseError(text: string): TErrorInfo {
  if (langChainModelNotFoundUrl.test(text)) {
    return { code: PublicErrorCodes.MODEL_UNAVAILABLE };
  }
  return getErrorInfo(text);
}

function RetryButton({ chat, messageId }: { chat: TChat; messageId: string }) {
  const localize = useLocalize();
  const getAddedConvo = useGetAddedConvo();
  const { conversation, isSubmitting, regenerate, getMessages } = chat;
  const { regenerateEnabled } = useGenerationsByLatest({
    messageId,
    isSubmitting,
    endpoint: conversation?.endpointType ?? conversation?.endpoint ?? '',
  });

  if (!regenerateEnabled) {
    return null;
  }

  const handleRetry = () => {
    const message = getMessages()?.find((item) => item.messageId === messageId);
    if (!message || message.isCreatedByUser === true) {
      return;
    }
    regenerate(message, { addedConvo: getAddedConvo() });
  };

  return (
    <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={handleRetry}>
      {localize('com_ui_try_again')}
    </Button>
  );
}

const Error = ({ text, messageId, conversationId }: TErrorProps) => {
  const localize = useLocalize();
  const chat = useContext(ChatContext);
  const messageContext = useMessageContext();
  const { code, requestId } = useMemo(() => parseError(text), [text]);
  const reference = toErrorReference(requestId);
  const targetMessageId = messageId ?? messageContext.messageId;
  const targetConversationId = conversationId ?? messageContext.conversationId ?? undefined;

  const message = localize(Object.hasOwn(errorKeys, code) ? errorKeys[code] : 'com_error_unknown');

  useEffect(() => {
    recordError({ code, requestId });
  }, [code, requestId]);

  return (
    <>
      <p>{message}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {chat && targetMessageId ? <RetryButton chat={chat} messageId={targetMessageId} /> : null}
        <ReportButton
          code={code}
          requestId={requestId}
          shownMessage={message}
          messageId={targetMessageId}
          conversationId={targetConversationId}
        />
        {reference ? (
          <span className="text-xs text-text-tertiary">
            {localize('com_error_reference', { 0: reference })}
          </span>
        ) : null}
      </div>
    </>
  );
};

export default Error;
