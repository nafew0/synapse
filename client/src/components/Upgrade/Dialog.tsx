import { useEffect, useRef } from 'react';
import { useRecoilState } from 'recoil';
import { Check, Clock, ExternalLink, GaugeCircle } from 'lucide-react';
import {
  Button,
  OGDialog,
  OGDialogTitle,
  OGDialogContent,
  OGDialogDescription,
} from '@librechat/client';
import type { TPlanUsageResponse } from 'librechat-data-provider';
import type { TQuotaExceeded } from '~/components/Messages/Content/QuotaNotice';
import type { TranslationKeys } from '~/hooks';
import { formatQuotaReset } from '~/components/Messages/Content/QuotaNotice';
import { useGetPlanUsage } from '~/data-provider';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';
import store from '~/store';

type Plan = NonNullable<TPlanUsageResponse['plan']>;

/** Who hit the limit: an institution member, a Free user, a Pro user, or someone on the top package. */
export type UpgradeVariant = 'member' | 'free' | 'pro' | 'top';

type PackageCard = {
  key: 'pro' | 'plus';
  name: string;
  price: string;
  lines: TranslationKeys[];
};

/** The packages a person can move to; prices mirror the bdren.ai pricing page. */
const PACKAGES: Record<PackageCard['key'], PackageCard> = {
  pro: {
    key: 'pro',
    name: 'Pro',
    price: '৳300',
    lines: ['com_ui_upgrade_pro_synapse', 'com_ui_upgrade_pro_survey', 'com_ui_upgrade_all_apps'],
  },
  plus: {
    key: 'plus',
    name: 'Plus',
    price: '৳500',
    lines: ['com_ui_upgrade_plus_synapse', 'com_ui_upgrade_plus_survey', 'com_ui_upgrade_all_apps'],
  },
};

/** Limits the person cannot buy their way past here: another model still works. */
const IGNORED_CODES = new Set(['MODEL_CAP']);

export function upgradeVariant(
  plan: Plan | null | undefined,
  limitCode?: string | null,
): UpgradeVariant {
  if (plan?.source === 'institution' || limitCode?.startsWith('INSTITUTION') === true) {
    return 'member';
  }
  if (plan?.source !== 'personal') {
    return 'free';
  }
  return plan.name.trim().toLowerCase() === 'pro' ? 'pro' : 'top';
}

function titleKey(quota: TQuotaExceeded, variant: UpgradeVariant): TranslationKeys {
  if (quota.meter === 'images' || quota.limitCode?.startsWith('IMAGE') === true) {
    return 'com_ui_upgrade_title_images';
  }
  const weekly = quota.window === 'week' || quota.limitCode?.includes('WEEKLY') === true;
  if (variant === 'member') {
    return weekly ? 'com_ui_upgrade_title_week' : 'com_ui_upgrade_title_month';
  }
  return weekly ? 'com_ui_upgrade_title_week_plan' : 'com_ui_upgrade_title_month_plan';
}

const BODY_KEYS: Record<UpgradeVariant, TranslationKeys> = {
  member: 'com_ui_upgrade_body_member',
  free: 'com_ui_upgrade_body_free',
  pro: 'com_ui_upgrade_body_pro',
  top: 'com_ui_upgrade_body_top',
};

type CardItem = { card: PackageCard; current: boolean; badge?: TranslationKeys };

function Card({ card, current, badge }: CardItem) {
  const localize = useLocalize();
  return (
    <li
      aria-label={card.name}
      className={cn(
        'flex flex-col gap-2.5 rounded-xl p-4',
        badge != null
          ? 'border-2 border-surface-submit bg-surface-submit/10'
          : 'border border-border-light bg-surface-primary',
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[15px] font-semibold text-text-primary">
          {current ? localize('com_ui_upgrade_yours', { 0: card.name }) : card.name}
        </span>
        <span className="text-[15px] font-bold text-text-primary">
          {card.price}
          <span className="text-xs font-medium text-text-secondary">
            {' '}
            {localize('com_ui_upgrade_per_month')}
          </span>
        </span>
      </div>
      <ul className="flex flex-col gap-1.5 text-[13px] leading-snug text-text-secondary">
        {card.lines.map((line) => (
          <li key={line} className="flex items-start gap-2">
            <Check className="mt-0.5 size-3.5 flex-none text-surface-submit" aria-hidden={true} />
            <span>{localize(line)}</span>
          </li>
        ))}
      </ul>
      {badge != null && (
        <span className="self-start rounded-full bg-surface-submit/20 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-text-primary">
          {localize(badge)}
        </span>
      )}
    </li>
  );
}

/** The packages shown for each variant: Free sees both, Pro sees itself and Plus, others see none. */
function cardsFor(variant: UpgradeVariant): CardItem[] {
  if (variant === 'free') {
    return [
      { card: PACKAGES.pro, current: false },
      { card: PACKAGES.plus, current: false, badge: 'com_ui_upgrade_most_popular' },
    ];
  }
  if (variant === 'pro') {
    return [
      { card: PACKAGES.pro, current: true },
      { card: PACKAGES.plus, current: false, badge: 'com_ui_upgrade_recommended' },
    ];
  }
  return [];
}

/**
 * Opens once when a usage limit stops a reply in this session, and points the person to
 * bdren.ai's pricing page to upgrade. Institution members are told to ask their admin
 * instead, since their institution buys the package. A limit already dismissed for the
 * same reset stays closed, so repeated sends do not reopen it.
 */
export default function UpgradeDialog() {
  const localize = useLocalize();
  const [quota, setQuota] = useRecoilState(store.quotaUpgradePrompt);
  const dismissed = useRef(new Set<string>());
  const { data } = useGetPlanUsage({ enabled: quota != null });

  const key = quota ? `${quota.limitCode ?? ''}|${quota.resetAt ?? ''}` : '';
  const ignored =
    quota != null && (IGNORED_CODES.has(quota.limitCode ?? '') || dismissed.current.has(key));

  useEffect(() => {
    if (ignored) {
      setQuota(null);
    }
  }, [ignored, setQuota]);

  const plan = data?.plan ?? null;
  const ready = quota != null && !ignored && data?.linked === true && plan != null;
  if (!ready) {
    return null;
  }

  const close = () => {
    dismissed.current.add(key);
    setQuota(null);
  };

  const variant = upgradeVariant(plan, quota.limitCode);
  const resetsAt = formatQuotaReset(quota.resetAt);
  const cards = cardsFor(variant);
  const upgradeUrl = variant === 'member' ? null : plan.upgradeUrl;
  const institution = plan.institutionName ?? localize('com_ui_upgrade_your_institution');

  return (
    <OGDialog open onOpenChange={(open) => !open && close()}>
      <OGDialogContent className="w-11/12 max-w-[560px] gap-[18px] border border-border-light">
        <div className="flex items-start gap-3.5 pr-8">
          <span className="flex size-10 flex-none items-center justify-center rounded-xl bg-status-warning-subtle">
            <GaugeCircle className="size-5 text-status-warning" aria-hidden={true} />
          </span>
          <div className="flex min-w-0 flex-col gap-1.5">
            <OGDialogTitle className="text-lg font-semibold leading-snug">
              {localize(titleKey(quota, variant), { 0: plan.name })}
            </OGDialogTitle>
            <OGDialogDescription className="leading-relaxed">
              {localize(BODY_KEYS[variant], { 0: plan.name })}
            </OGDialogDescription>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-[13px] text-text-secondary">
          {resetsAt != null && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-tertiary px-3 py-1.5">
              <Clock className="size-3.5" aria-hidden={true} />
              {localize('com_ui_usage_resets', { 0: resetsAt })}
            </span>
          )}
          <span className="inline-flex items-center gap-1 rounded-full bg-surface-tertiary px-3 py-1.5">
            {variant === 'member'
              ? localize('com_ui_upgrade_covered_by', { 0: institution })
              : localize('com_ui_upgrade_your_package', { 0: plan.name })}
          </span>
        </div>

        {cards.length > 0 && (
          <ul
            aria-label={localize('com_ui_upgrade_packages')}
            className="grid grid-cols-1 gap-3 sm:grid-cols-2"
          >
            {cards.map((item) => (
              <Card key={item.card.key} {...item} />
            ))}
          </ul>
        )}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          {upgradeUrl != null ? (
            <>
              <Button variant="outline" onClick={close}>
                {localize('com_ui_upgrade_wait')}
              </Button>
              <a
                href={upgradeUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={close}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-surface-submit px-4 text-sm font-medium text-text-on-status hover:bg-surface-submit-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-ring-primary"
              >
                {localize(
                  variant === 'pro' ? 'com_ui_upgrade_to_plus' : 'com_ui_upgrade_see_packages',
                )}
                <ExternalLink className="size-4" aria-hidden={true} />
              </a>
            </>
          ) : (
            <Button onClick={close}>{localize('com_ui_upgrade_ok')}</Button>
          )}
        </div>
        {upgradeUrl != null && (
          <p className="-mt-1.5 text-xs leading-relaxed text-text-secondary">
            {localize('com_ui_upgrade_note')}
          </p>
        )}
      </OGDialogContent>
    </OGDialog>
  );
}
