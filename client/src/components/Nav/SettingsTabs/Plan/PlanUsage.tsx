import { Button, Progress, Skeleton } from '@librechat/client';
import type { TPlanUsageResponse, TQuotaMeterState } from 'librechat-data-provider';
import { useGetPlanUsage } from '~/data-provider';
import { useAuthContext, useLocalize } from '~/hooks';
import { cn } from '~/utils';

type Plan = NonNullable<TPlanUsageResponse['plan']>;

const windowLabelKeys = {
  week: 'com_ui_usage_this_week',
  month: 'com_ui_usage_this_month',
} as const;

function formatTaka(value: number | null | undefined): string {
  return `৳${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value ?? 0)}`;
}

function formatDate(iso: string, withTime = false): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(withTime ? { weekday: 'short', hour: 'numeric', minute: '2-digit' } : { year: 'numeric' }),
  });
}

function usedPercent(state: TQuotaMeterState): number {
  if (state.limit == null || state.limit <= 0) {
    return 0;
  }
  return Math.round(Math.min((state.used ?? 0) / state.limit, 1) * 100);
}

function SourceLine({ plan }: { plan: Plan }) {
  const localize = useLocalize();
  if (plan.source === 'institution') {
    return (
      <>
        {plan.institutionName
          ? localize('com_ui_plan_source_institution', { 0: plan.institutionName })
          : localize('com_ui_plan_source_institution_unnamed')}
      </>
    );
  }
  if (plan.source === 'personal') {
    return <>{localize('com_ui_plan_source_personal')}</>;
  }
  if (plan.source === 'free') {
    return <>{localize('com_ui_plan_source_free')}</>;
  }
  return null;
}

function PlanHeader({ plan, linked }: { plan: Plan; linked: boolean }) {
  const localize = useLocalize();
  const changeKey = plan.source === 'personal' ? 'com_ui_plan_manage' : 'com_ui_plan_upgrade';
  const canChange = linked && plan.upgradeUrl != null && plan.source !== 'institution';
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-base font-semibold text-text-primary">{plan.name}</span>
        <span className="text-xs text-text-secondary">
          <SourceLine plan={plan} />
          {plan.endsAt && plan.source === 'personal' && (
            <> · {localize('com_ui_plan_ends', { 0: formatDate(plan.endsAt) })}</>
          )}
        </span>
      </div>
      {canChange && (
        <a
          href={plan.upgradeUrl ?? undefined}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 text-sm font-medium text-text-primary underline underline-offset-2 hover:text-text-secondary"
        >
          {localize(changeKey)}
        </a>
      )}
    </div>
  );
}

function PeriodRow({ state, unlimited }: { state: TQuotaMeterState; unlimited: boolean }) {
  const localize = useLocalize();
  const label = localize(windowLabelKeys[state.window]);
  const percent = usedPercent(state);
  const noCeiling = unlimited || state.unlimited;
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
          >
            {localize('com_ui_plan_used', { 0: formatTaka(state.usedBdt) })}
          </span>
          <span className="text-xs text-text-secondary">
            {noCeiling
              ? localize('com_ui_usage_unlimited')
              : localize('com_ui_plan_left', {
                  0: formatTaka(state.remainingBdt),
                  1: formatTaka(state.limitBdt),
                })}
          </span>
        </span>
      </div>
      {!noCeiling && (
        <Progress
          value={percent}
          aria-label={localize('com_ui_usage_used_percent', { 0: label, 1: percent })}
        />
      )}
      <span className="text-xs font-light text-text-secondary">
        {localize('com_ui_usage_resets', { 0: formatDate(state.resetsAt, true) })}
      </span>
    </div>
  );
}

function Loading() {
  const localize = useLocalize();
  return (
    <div
      className="flex flex-col gap-3"
      aria-busy="true"
      aria-label={localize('com_ui_plan_loading')}
    >
      <Skeleton className="h-5 w-32" />
      <Skeleton className="h-2 w-full" />
      <Skeleton className="h-2 w-full" />
    </div>
  );
}

function LoadError({ onRetry }: { onRetry: () => void }) {
  const localize = useLocalize();
  return (
    <div className="flex items-center justify-between gap-4" role="alert">
      <span className="text-sm text-text-destructive">{localize('com_ui_plan_error')}</span>
      <Button variant="outline" size="sm" onClick={onRetry}>
        {localize('com_ui_retry')}
      </Button>
    </div>
  );
}

/** The plan the user is on (their own bdren.ai package, their institution's, or Free) and its AI allowance. */
export default function PlanUsage() {
  const localize = useLocalize();
  const { isAuthenticated } = useAuthContext();
  const query = useGetPlanUsage({ enabled: !!isAuthenticated });

  if (query.isError && !query.data) {
    return <LoadError onRetry={() => query.refetch()} />;
  }
  if (!query.data) {
    return <Loading />;
  }

  const { linked, plan, periods } = query.data;
  return (
    <div className="flex flex-col gap-4" role="group" aria-label={localize('com_ui_plan_usage')}>
      {plan ? (
        <PlanHeader plan={plan} linked={linked} />
      ) : (
        <span className="text-sm text-text-secondary">{localize('com_ui_plan_none')}</span>
      )}
      {plan?.stale && (
        <span className="text-xs text-status-warning" role="note">
          {localize('com_ui_plan_stale')}
        </span>
      )}
      {periods.map((state) => (
        <PeriodRow key={state.window} state={state} unlimited={plan?.unlimited === true} />
      ))}
      {!linked && (
        <span className="text-xs text-text-secondary" role="note">
          {localize('com_ui_plan_not_linked')}
        </span>
      )}
    </div>
  );
}
