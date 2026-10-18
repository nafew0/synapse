import React from 'react';
import { Clock, ImageOff, GaugeCircle } from 'lucide-react';
import { useSetRecoilState } from 'recoil';
import { SettingsTabValues } from 'librechat-data-provider';
import type { LocalizeFunction } from '~/common';
import store from '~/store';

export type TQuotaExceeded = {
  limitCode?: string | null;
  window?: string | null;
  meter?: string | null;
  resetAt?: string | null;
};

/** Every `limitCode` the quota engine can emit, so a refusal always names the
 *  allowance that actually ran out rather than falling back to vague copy. */
const quotaMessageKeys = {
  WEEKLY_CAP: 'com_error_quota_weekly',
  MONTHLY_CAP: 'com_error_quota_monthly',
  IMAGE_WEEKLY_CAP: 'com_error_quota_images_weekly',
  IMAGE_MONTHLY_CAP: 'com_error_quota_images_monthly',
  MODEL_CAP: 'com_error_quota_model',
  INSTITUTION_CAP: 'com_error_quota_institution',
  INSTITUTION_WEEKLY_CAP: 'com_error_quota_institution_weekly',
} as const;

const quotaTitleKeys = {
  WEEKLY_CAP: 'com_error_quota_title',
  MONTHLY_CAP: 'com_error_quota_title',
  IMAGE_WEEKLY_CAP: 'com_error_quota_title_images',
  IMAGE_MONTHLY_CAP: 'com_error_quota_title_images',
  MODEL_CAP: 'com_error_quota_title_model',
  INSTITUTION_CAP: 'com_error_quota_title_institution',
  INSTITUTION_WEEKLY_CAP: 'com_error_quota_title_institution',
} as const;

type QuotaLimitCode = keyof typeof quotaMessageKeys;

/** Narrowed rather than cast: `localize` takes a literal union of translation
 *  keys, so an unrecognised code from a newer server falls back to generic copy
 *  instead of being forced through as a key. */
function knownLimitCode(limitCode?: string | null): QuotaLimitCode | undefined {
  return limitCode != null && limitCode in quotaMessageKeys
    ? (limitCode as QuotaLimitCode)
    : undefined;
}

/** Absolute local date-time, not "in 2 days": the message stays in the
 *  conversation, so a relative phrase would go stale and start lying. */
export function formatQuotaReset(resetAt?: string | null): string | null {
  if (!resetAt) {
    return null;
  }
  const reset = new Date(resetAt);
  if (Number.isNaN(reset.getTime())) {
    return null;
  }
  return reset.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * A usage limit is planned behaviour, not a failure: the user did nothing wrong
 * and retrying will not help. So the card sits on the normal surface and the
 * amber is confined to the icon chip — enough to draw the eye without the
 * whole-banner red that reads as "something broke".
 */
export default function QuotaNotice({
  json,
  localize,
}: {
  json: TQuotaExceeded;
  localize: LocalizeFunction;
}) {
  const setRequestedSettingsTab = useSetRecoilState(store.requestedSettingsTab);
  const code = knownLimitCode(json.limitCode);
  const resetsAt = formatQuotaReset(json.resetAt);
  /** The icon follows the meter that ran out: an image cap is a different fact
   *  about the world than a token cap, and the glyph should say so at a glance. */
  const isImages = json.meter === 'images' || code?.startsWith('IMAGE') === true;
  const MeterIcon = isImages ? ImageOff : GaugeCircle;

  /** The body no longer embeds the date — the reset pill carries it — so an
   *  unknown reset instant only hides the pill. Generic copy is reserved for an
   *  unrecognised limit code from a newer server. */
  const message = code ? localize(quotaMessageKeys[code]) : localize('com_error_quota_generic');
  const title = localize(code ? quotaTitleKeys[code] : 'com_error_quota_title');

  /* Sizes step up at `sm` and hold there: the source mockup was drawn at a
     narrow fixed width and reads undersized in a full chat column, while phones
     still need the compact treatment. Everything scales together — chip, type,
     padding — so the proportions stay as designed at either size. */
  return (
    <div className="flex gap-3.5 rounded-xl border border-border-light bg-surface-primary px-4 py-4 sm:gap-4 sm:px-5 sm:py-[18px]">
      <div className="flex size-8 flex-none items-center justify-center rounded-lg bg-status-warning-subtle sm:size-10 sm:rounded-xl">
        <MeterIcon className="size-[18px] text-status-warning sm:size-5" aria-hidden={true} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="mb-1 text-[15px] font-semibold text-text-primary sm:text-base">{title}</p>
        <p className="text-sm leading-relaxed text-text-secondary sm:text-[15px]">{message}</p>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          {resetsAt != null && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-tertiary px-3 py-1.5 text-xs text-text-secondary sm:text-[13px]">
              <Clock className="size-3.5 sm:size-4" aria-hidden={true} />
              {localize('com_ui_usage_resets', { 0: resetsAt })}
            </span>
          )}
          <button
            type="button"
            onClick={() => setRequestedSettingsTab(SettingsTabValues.ACCOUNT)}
            className="rounded text-xs font-medium text-link hover:text-link-hover hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring-primary sm:text-[13px]"
          >
            {localize('com_ui_usage_manage_plan')}
          </button>
        </div>
      </div>
    </div>
  );
}
