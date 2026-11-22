import type { TBalanceResponse } from 'librechat-data-provider';
import { useGetStartupConfig, useGetUserBalance, useGetUserQuota } from '~/data-provider';
import AutoRefillSettings from '../SettingsTabs/Balance/AutoRefillSettings';
import UsageQuotaItem from '../SettingsTabs/Balance/UsageQuotaItem';
import TokenCreditsItem from '../SettingsTabs/Balance/TokenCreditsItem';
import { useAuthContext, useLocalize } from '~/hooks';

function useBalance(): Partial<TBalanceResponse> {
  const { isAuthenticated } = useAuthContext();
  const { data: startupConfig } = useGetStartupConfig();

  const balanceQuery = useGetUserBalance({
    enabled: !!isAuthenticated && !!startupConfig?.balance?.enabled,
  });

  return balanceQuery.data ?? {};
}

/**
 * Shows the plan allowance when the tenant is on a usage policy, falling back to
 * the raw credit ledger otherwise. The two are different units — weighted
 * billing tokens vs. real cost — so they are never shown together.
 */
export function TokenCredits() {
  const { isAuthenticated } = useAuthContext();
  const quotaQuery = useGetUserQuota({ enabled: !!isAuthenticated });
  const { tokenCredits = 0 } = useBalance();

  if (quotaQuery.data?.meters?.length) {
    return <UsageQuotaItem quota={quotaQuery.data} />;
  }

  return <TokenCreditsItem tokenCredits={tokenCredits} />;
}

export function AutoRefill() {
  const localize = useLocalize();
  const {
    autoRefillEnabled = false,
    lastRefill,
    refillAmount,
    refillIntervalUnit,
    refillIntervalValue,
  } = useBalance();

  const hasValidRefillSettings =
    lastRefill !== undefined &&
    refillAmount !== undefined &&
    refillIntervalUnit !== undefined &&
    refillIntervalValue !== undefined;

  if (!autoRefillEnabled) {
    return (
      <div className="text-sm text-text-secondary">
        {localize('com_nav_balance_auto_refill_disabled')}
      </div>
    );
  }

  if (!hasValidRefillSettings) {
    return (
      <div className="text-sm text-text-destructive">
        {localize('com_nav_balance_auto_refill_error')}
      </div>
    );
  }

  return (
    <AutoRefillSettings
      lastRefill={lastRefill}
      refillAmount={refillAmount}
      refillIntervalUnit={refillIntervalUnit}
      refillIntervalValue={refillIntervalValue}
    />
  );
}
