import React from 'react';
import { RecoilRoot } from 'recoil';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TPlanUsageResponse, TQuotaMeterState } from 'librechat-data-provider';
import PlanUsage from '../PlanUsage';

const mockGetPlanUsage = jest.fn<Promise<TPlanUsageResponse>, []>();

/** Only the HTTP call is replaced; the real query hook, cache and component run. */
jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: { ...actual.dataService, getPlanUsage: () => mockGetPlanUsage() },
  };
});

jest.mock('~/hooks', () => ({
  useAuthContext: () => ({ isAuthenticated: true }),
  useLocalize: () => (key: string, values?: Record<string, string | number>) =>
    values ? `${key}|${Object.values(values).join('|')}` : key,
}));

const period = (window: 'week' | 'month', usedBdt: number, limitBdt: number): TQuotaMeterState => ({
  meter: 'credits',
  window,
  used: usedBdt * 7400,
  limit: limitBdt * 7400,
  remaining: (limitBdt - usedBdt) * 7400,
  unlimited: false,
  blocked: usedBdt >= limitBdt,
  resetsAt: window === 'week' ? '2026-11-29T18:00:00.000Z' : '2026-11-30T18:00:00.000Z',
  usedBdt,
  limitBdt,
  remainingBdt: limitBdt - usedBdt,
});

const proPlan: TPlanUsageResponse = {
  linked: true,
  managed: true,
  plan: {
    name: 'Pro',
    source: 'personal',
    institutionName: null,
    endsAt: '2026-12-23T00:00:00.000Z',
    upgradeUrl: 'https://bdren.ai/pricing',
    stale: false,
    unlimited: false,
  },
  periods: [period('week', 30, 120), period('month', 100, 450)],
};

function renderPlan() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <RecoilRoot>
      <QueryClientProvider client={client}>
        <PlanUsage />
      </QueryClientProvider>
    </RecoilRoot>,
  );
}

describe('PlanUsage', () => {
  afterEach(() => mockGetPlanUsage.mockReset());

  it('shows a loading state until the plan arrives', async () => {
    let resolve: (value: TPlanUsageResponse) => void = () => undefined;
    mockGetPlanUsage.mockReturnValue(new Promise((done) => (resolve = done)));
    renderPlan();

    expect(screen.getByLabelText('com_ui_plan_loading')).toHaveAttribute('aria-busy', 'true');
    resolve(proPlan);
    expect(await screen.findByText('Pro')).toBeInTheDocument();
    expect(screen.queryByLabelText('com_ui_plan_loading')).not.toBeInTheDocument();
  });

  it('shows the package, what was used and what is left in each window, with a bar', async () => {
    mockGetPlanUsage.mockResolvedValue(proPlan);
    renderPlan();

    expect(await screen.findByText('Pro')).toBeInTheDocument();
    expect(screen.getByText(/com_ui_plan_source_personal/)).toBeInTheDocument();
    expect(screen.getByText('com_ui_plan_used|৳30')).toBeInTheDocument();
    expect(screen.getByText('com_ui_plan_left|৳90|৳120')).toBeInTheDocument();
    expect(screen.getByText('com_ui_plan_used|৳100')).toBeInTheDocument();
    expect(screen.getByText('com_ui_plan_left|৳350|৳450')).toBeInTheDocument();
    const bars = screen.getAllByRole('progressbar');
    expect(bars).toHaveLength(2);
    expect(bars[0]).toHaveAccessibleName('com_ui_usage_used_percent|com_ui_usage_this_week|25');
    expect(screen.getByRole('link', { name: 'com_ui_plan_manage' })).toHaveAttribute(
      'href',
      'https://bdren.ai/pricing',
    );
  });

  it('names the institution for a covered member and offers no plan change', async () => {
    mockGetPlanUsage.mockResolvedValue({
      ...proPlan,
      plan: {
        ...proPlan.plan!,
        name: 'Campus Plus',
        source: 'institution',
        institutionName: 'Dhaka University',
      },
    });
    renderPlan();

    expect(await screen.findByText('Campus Plus')).toBeInTheDocument();
    expect(screen.getByText('com_ui_plan_source_institution|Dhaka University')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('offers an upgrade on the Free plan', async () => {
    mockGetPlanUsage.mockResolvedValue({
      ...proPlan,
      plan: { ...proPlan.plan!, name: 'Free', source: 'free', endsAt: null },
    });
    renderPlan();

    expect(await screen.findByText('Free')).toBeInTheDocument();
    expect(screen.getByText('com_ui_plan_source_free')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'com_ui_plan_upgrade' })).toBeInTheDocument();
  });

  it('says plans are not managed by bdren.ai when the link is off', async () => {
    mockGetPlanUsage.mockResolvedValue({
      linked: false,
      managed: false,
      plan: null,
      periods: [],
    });
    renderPlan();

    expect(await screen.findByText('com_ui_plan_not_linked')).toBeInTheDocument();
    expect(screen.getByText('com_ui_plan_none')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('shows an error with a retry that loads the plan again', async () => {
    mockGetPlanUsage.mockRejectedValueOnce(new Error('500')).mockResolvedValueOnce(proPlan);
    renderPlan();

    expect(await screen.findByRole('alert')).toHaveTextContent('com_ui_plan_error');
    await userEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
    expect(await screen.findByText('Pro')).toBeInTheDocument();
    await waitFor(() => expect(mockGetPlanUsage).toHaveBeenCalledTimes(2));
  });
});
