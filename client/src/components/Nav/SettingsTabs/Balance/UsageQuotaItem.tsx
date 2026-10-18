import React, { useMemo } from 'react';
import { Label, InfoHoverCard, ESide, Progress } from '@librechat/client';
import type { TQuotaMeterState, TQuotaResponse } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

interface UsageQuotaItemProps {
  quota?: TQuotaResponse;
}

/** Compact enough to sit in a settings row: 8.2M rather than 8,200,000. */
function formatAmount(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  }
  return new Intl.NumberFormat().format(value);
}

function formatReset(resetsAt: string): string {
  const reset = new Date(resetsAt);
  if (Number.isNaN(reset.getTime())) {
    return '';
  }
  return reset.toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** An "Unlimited" package shows its real numbers once this share is used, so nobody hits a wall unwarned. */
const UNLIMITED_REVEAL_SHARE = 0.8;

function formatTaka(value: number): string {
  return `৳${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)}`;
}

function usedShare(state: TQuotaMeterState): number {
  if (state.limit == null || state.limit <= 0) {
    return 0;
  }
  return Math.min((state.used ?? 0) / state.limit, 1);
}

const windowLabelKeys = {
  week: 'com_ui_usage_this_week',
  month: 'com_ui_usage_this_month',
} as const;

const institutionLabelKeys = {
  week: 'com_ui_usage_institution_week_used',
  month: 'com_ui_usage_institution_month_used',
} as const;

function ResetLine({ resetsAt }: { resetsAt: string }) {
  const localize = useLocalize();
  return (
    <span className="text-xs font-light text-text-secondary">
      {localize('com_ui_usage_resets', { 0: formatReset(resetsAt) })}
    </span>
  );
}

/** The member's own allowance in taka, with a bar; an "Unlimited" package hides the numbers until 80%. */
function CreditRow({ state, unlimited }: { state: TQuotaMeterState; unlimited: boolean }) {
  const localize = useLocalize();
  const share = usedShare(state);
  const showUnlimited = state.unlimited || (unlimited && share < UNLIMITED_REVEAL_SHARE);
  const label = localize(windowLabelKeys[state.window]);
  const value = showUnlimited
    ? localize('com_ui_usage_unlimited')
    : localize('com_ui_usage_remaining', {
        0: formatTaka(state.remainingBdt ?? 0),
        1: formatTaka(state.limitBdt ?? 0),
      });
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-start justify-between gap-4">
        <span className="pt-px text-sm text-text-secondary">{label}</span>
        <span className="flex flex-col items-end text-right">
          <span
            className={cn(
              'text-sm font-medium',
              state.blocked ? 'text-status-warning' : 'text-text-primary',
            )}
            role="note"
          >
            {value}
          </span>
          <ResetLine resetsAt={state.resetsAt} />
        </span>
      </div>
      {!showUnlimited && (
        <Progress
          value={Math.round(share * 100)}
          aria-label={localize('com_ui_usage_used_percent', {
            0: label,
            1: Math.round(share * 100),
          })}
        />
      )}
    </div>
  );
}

/** Only an exhausted institution pool is shown: its size belongs to the institution, not the member. */
function InstitutionRow({ state }: { state: TQuotaMeterState }) {
  const localize = useLocalize();
  return (
    <div className="flex items-start justify-between gap-4" role="alert">
      <span className="text-sm text-status-warning">
        {localize(institutionLabelKeys[state.window])}
      </span>
      <ResetLine resetsAt={state.resetsAt} />
    </div>
  );
}

function CreditQuota({ quota }: { quota: TQuotaResponse }) {
  const localize = useLocalize();
  /** Week before month: the window that blocks first is the one to see first. */
  const own = useMemo(
    () =>
      quota.meters
        .filter((state) => state.meter === 'credits')
        .sort((a, b) => (a.window === 'week' ? -1 : 1) - (b.window === 'week' ? -1 : 1)),
    [quota.meters],
  );
  const institution = quota.meters.filter(
    (state) => state.meter === 'institution' && state.blocked,
  );
  if (own.length === 0 && institution.length === 0) {
    return null;
  }
  return (
    <div
      className="flex flex-col gap-3"
      role="group"
      aria-label={localize('com_ui_usage_allowance')}
    >
      <div className="flex items-center space-x-2">
        <Label className="font-light">
          {quota.package?.name
            ? localize('com_ui_usage_allowance_package', { 0: quota.package.name })
            : localize('com_ui_usage_allowance')}
        </Label>
        <InfoHoverCard side={ESide.Bottom} text={localize('com_ui_usage_credit_note')} />
      </div>
      {own.map((state) => (
        <CreditRow key={state.window} state={state} unlimited={quota.package?.unlimited === true} />
      ))}
      {institution.map((state) => (
        <InstitutionRow key={`institution:${state.window}`} state={state} />
      ))}
      {quota.enforced === false && (
        <p className="text-xs font-light text-text-secondary">
          {localize('com_ui_usage_not_enforced')}
        </p>
      )}
    </div>
  );
}

/** Each meter names BOTH what it counts and which window, because a member has
 *  four of them: two labelled only "Images" are indistinguishable. */
const meterLabelKeys = {
  'tokens:week': 'com_ui_usage_this_week',
  'tokens:month': 'com_ui_usage_this_month',
  'images:week': 'com_ui_usage_images_this_week',
  'images:month': 'com_ui_usage_images_this_month',
} as const;

function MeterRow({ state }: { state: TQuotaMeterState }) {
  const localize = useLocalize();
  const label = localize(
    meterLabelKeys[`${state.meter}:${state.window}` as keyof typeof meterLabelKeys],
  );

  const value = state.unlimited
    ? localize('com_ui_usage_unlimited')
    : localize('com_ui_usage_remaining', {
        0: formatAmount(state.remaining ?? 0),
        1: formatAmount(state.limit ?? 0),
      });

  return (
    <div className="flex items-start justify-between gap-4">
      <span className="pt-px text-sm text-text-secondary">{label}</span>
      {/* Value and reset stack rather than sitting inline: on a narrow settings
          row the two ran together into "5K leftResets Mon, Sep 14". */}
      <span className="flex flex-col items-end text-right">
        <span
          className={cn(
            'text-sm font-medium',
            state.blocked ? 'text-status-warning' : 'text-text-primary',
          )}
          role="note"
        >
          {value}
        </span>
        <span className="text-xs font-light text-text-secondary">
          {localize('com_ui_usage_resets', { 0: formatReset(state.resetsAt) })}
        </span>
      </span>
    </div>
  );
}

/**
 * Remaining allowance on both meters, in the weighted "billing token" unit the
 * wall is actually enforced against — never the raw provider count, which would
 * make `remaining` disagree with the limit that blocks a request.
 */
const UsageQuotaItem: React.FC<UsageQuotaItemProps> = ({ quota }) => {
  if (quota?.unit === 'credits') {
    return <CreditQuota quota={quota} />;
  }
  return <TokenQuota quota={quota} />;
};

/** The token-policy allowance, for institutions not yet on a usage package. */
const TokenQuota: React.FC<UsageQuotaItemProps> = ({ quota }) => {
  const localize = useLocalize();

  /** Weekly before monthly, tokens before images: the window that blocks first
   *  is the one a user needs to see first. */
  const meters = useMemo(() => {
    const order: Record<string, number> = {
      'tokens:week': 0,
      'tokens:month': 1,
      'images:week': 2,
      'images:month': 3,
    };
    return [...(quota?.meters ?? [])].sort(
      (a, b) => (order[`${a.meter}:${a.window}`] ?? 9) - (order[`${b.meter}:${b.window}`] ?? 9),
    );
  }, [quota?.meters]);

  if (meters.length === 0) {
    return null;
  }

  return (
    <div
      className="flex flex-col gap-3"
      role="group"
      aria-label={localize('com_ui_usage_allowance')}
    >
      <div className="flex items-center space-x-2">
        <Label className="font-light">{localize('com_ui_usage_allowance')}</Label>
        <InfoHoverCard side={ESide.Bottom} text={localize('com_ui_usage_weighted_note')} />
      </div>
      {meters.map((state) => (
        <MeterRow key={`${state.meter}:${state.window}`} state={state} />
      ))}
      {quota?.enforced === false && (
        <p className="text-xs font-light text-text-secondary">
          {localize('com_ui_usage_not_enforced')}
        </p>
      )}
    </div>
  );
};

export default UsageQuotaItem;
