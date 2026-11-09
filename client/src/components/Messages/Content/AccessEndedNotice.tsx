import { Lock } from 'lucide-react';
import { ErrorTypes } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';
import { extractJson } from '~/utils/json';

/** The institution's own message from a `chat_access_ended` refusal, or `undefined` for any other text. */
export function parseAccessEnded(text: string): { info?: string } | undefined {
  const json = extractJson(text);
  if (!json) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(json);
    if (parsed?.type !== ErrorTypes.CHAT_ACCESS_ENDED) {
      return undefined;
    }
    return typeof parsed.info === 'string' && parsed.info.trim() ? { info: parsed.info } : {};
  } catch {
    return undefined;
  }
}

/**
 * Ended access is an account state, not a failure: nothing to retry or report, so it sits on the
 * normal surface with the institution's own words, set by a platform admin, as plain text.
 */
export default function AccessEndedNotice({ info }: { info?: string }) {
  const localize = useLocalize();
  return (
    <div
      role="status"
      className="flex gap-3.5 rounded-xl border border-border-light bg-surface-primary px-4 py-4 sm:gap-4 sm:px-5"
    >
      <div className="flex size-8 flex-none items-center justify-center rounded-lg bg-status-warning-subtle sm:size-10 sm:rounded-xl">
        <Lock className="size-[18px] text-status-warning sm:size-5" aria-hidden={true} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="mb-1 text-[15px] font-semibold text-text-primary sm:text-base">
          {localize('com_error_access_ended_title')}
        </p>
        <p className="whitespace-pre-line text-sm leading-relaxed text-text-secondary sm:text-[15px]">
          {info ?? localize('com_error_access_ended')}
        </p>
      </div>
    </div>
  );
}
