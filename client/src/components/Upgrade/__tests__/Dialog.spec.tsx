import React from 'react';
import { RecoilRoot } from 'recoil';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TPlanUsageResponse } from 'librechat-data-provider';
import type { TQuotaExceeded } from '~/components/Messages/Content/QuotaNotice';
import UpgradeDialog, { upgradeVariant } from '../Dialog';
import store from '~/store';

const mockGetPlanUsage = jest.fn<Promise<TPlanUsageResponse>, []>();

/** Only the HTTP call is replaced; the real query hook, cache, store and dialog run. */
jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: { ...actual.dataService, getPlanUsage: () => mockGetPlanUsage() },
  };
});

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string, string | number>) =>
    values ? `${key}|${Object.values(values).join('|')}` : key,
}));

const UPGRADE_URL = 'https://bdren.ai/pricing#subscribe';

const planOf = (over: Partial<NonNullable<TPlanUsageResponse['plan']>>): TPlanUsageResponse => ({
  linked: true,
  managed: true,
  plan: {
    name: 'Free',
    source: 'free',
    institutionName: null,
    endsAt: null,
    upgradeUrl: UPGRADE_URL,
    stale: false,
    unlimited: false,
    ...over,
  },
  periods: [],
});

const MONTHLY: TQuotaExceeded = {
  limitCode: 'MONTHLY_CAP',
  window: 'month',
  resetAt: '2026-11-30T18:00:00.000Z',
};

function renderDialog(quota: TQuotaExceeded | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <RecoilRoot initializeState={({ set }) => set(store.quotaUpgradePrompt, quota)}>
      <QueryClientProvider client={client}>
        <UpgradeDialog />
      </QueryClientProvider>
    </RecoilRoot>,
  );
}

describe('UpgradeDialog', () => {
  afterEach(() => mockGetPlanUsage.mockReset());

  it('offers Free users Pro and Plus and links to the bdren.ai pricing page', async () => {
    mockGetPlanUsage.mockResolvedValue(planOf({}));
    renderDialog(MONTHLY);

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('com_ui_upgrade_title_month_plan|Free');
    expect(screen.getByRole('listitem', { name: 'Pro' })).toBeInTheDocument();
    expect(screen.getByRole('listitem', { name: 'Plus' })).toHaveTextContent(
      'com_ui_upgrade_most_popular',
    );
    const link = screen.getByRole('link', { name: /com_ui_upgrade_see_packages/ });
    expect(link).toHaveAttribute('href', UPGRADE_URL);
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('shows a Pro user their package beside Plus and a direct Plus upgrade', async () => {
    mockGetPlanUsage.mockResolvedValue(planOf({ name: 'Pro', source: 'personal' }));
    renderDialog({ ...MONTHLY, limitCode: 'WEEKLY_CAP', window: 'week' });

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('com_ui_upgrade_title_week_plan|Pro');
    expect(screen.getByRole('listitem', { name: 'Pro' })).toHaveTextContent(
      'com_ui_upgrade_yours|Pro',
    );
    expect(screen.getByRole('listitem', { name: 'Plus' })).toHaveTextContent(
      'com_ui_upgrade_recommended',
    );
    expect(screen.getByRole('link', { name: /com_ui_upgrade_to_plus/ })).toHaveAttribute(
      'href',
      UPGRADE_URL,
    );
  });

  it('tells institution members to ask their admin, with nothing to buy', async () => {
    mockGetPlanUsage.mockResolvedValue(
      planOf({ name: 'Enterprise', source: 'institution', institutionName: 'University of Dhaka' }),
    );
    renderDialog(MONTHLY);

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('com_ui_upgrade_body_member');
    expect(dialog).toHaveTextContent('com_ui_upgrade_covered_by|University of Dhaka');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'com_ui_upgrade_packages' })).not.toBeInTheDocument();
  });

  it('closes on "Wait for the reset"', async () => {
    mockGetPlanUsage.mockResolvedValue(planOf({}));
    renderDialog(MONTHLY);
    await userEvent.click(await screen.findByRole('button', { name: 'com_ui_upgrade_wait' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('stays closed on servers whose plans are not managed by bdren.ai', async () => {
    mockGetPlanUsage.mockResolvedValue({ ...planOf({}), linked: false });
    renderDialog(MONTHLY);
    await waitFor(() => expect(mockGetPlanUsage).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does not open for a single model limit, since other models still work', async () => {
    mockGetPlanUsage.mockResolvedValue(planOf({}));
    renderDialog({ ...MONTHLY, limitCode: 'MODEL_CAP' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('picks the variant from the plan source and package', () => {
    expect(upgradeVariant(planOf({}).plan, 'MONTHLY_CAP')).toBe('free');
    expect(upgradeVariant(planOf({ source: 'personal', name: 'Pro' }).plan, 'WEEKLY_CAP')).toBe(
      'pro',
    );
    expect(upgradeVariant(planOf({ source: 'personal', name: 'Plus' }).plan, 'WEEKLY_CAP')).toBe(
      'top',
    );
    expect(upgradeVariant(planOf({}).plan, 'INSTITUTION_CAP')).toBe('member');
  });
});
