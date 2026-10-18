import React from 'react';
import { render, screen } from '@testing-library/react';
import type { TQuotaResponse } from 'librechat-data-provider';
import UsageQuotaItem from '../UsageQuotaItem';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string, string>) =>
    values ? `${key}|${Object.values(values).join('|')}` : key,
}));

const meter = (
  meterName: 'tokens' | 'images',
  window: 'week' | 'month',
  used: number,
  limit: number | null,
) => ({
  meter: meterName,
  window,
  used,
  limit,
  remaining: limit == null ? null : Math.max(limit - used, 0),
  unlimited: limit == null,
  blocked: limit != null && used >= limit,
  resetsAt: window === 'week' ? '2026-09-14T00:00:00.000Z' : '2026-10-01T00:00:00.000Z',
});

const quota = (...meters: ReturnType<typeof meter>[]) =>
  ({ tenantId: 't', unit: 'billing_tokens', enforced: true, meters }) as TQuotaResponse;

describe('UsageQuotaItem', () => {
  /** Two rows both labelled "Images" were indistinguishable in the panel. */
  it('distinguishes the weekly and monthly image meters', () => {
    render(
      <UsageQuotaItem
        quota={quota(meter('images', 'week', 2, 2), meter('images', 'month', 2, 3))}
      />,
    );
    expect(screen.getByText('com_ui_usage_images_this_week')).toBeInTheDocument();
    expect(screen.getByText('com_ui_usage_images_this_month')).toBeInTheDocument();
  });

  it('labels the token meters by window too', () => {
    render(
      <UsageQuotaItem
        quota={quota(meter('tokens', 'week', 1, 5), meter('tokens', 'month', 1, 20))}
      />,
    );
    expect(screen.getByText('com_ui_usage_this_week')).toBeInTheDocument();
    expect(screen.getByText('com_ui_usage_this_month')).toBeInTheDocument();
  });

  /** The value and the reset used to render inside one element, producing
   *  "5K leftResets Mon, Sep 14" with nothing between them. */
  it('keeps the remaining value and the reset in separate elements', () => {
    render(<UsageQuotaItem quota={quota(meter('tokens', 'week', 1300, 5000))} />);
    const value = screen.getByRole('note');
    expect(value.textContent).toBe('com_ui_usage_remaining|3.7K|5K');
    expect(value.textContent).not.toMatch(/Resets|com_ui_usage_resets/);
    expect(screen.getByText(/com_ui_usage_resets\|/)).toBeInTheDocument();
  });

  it('shows an unlimited meter without a remaining count', () => {
    render(<UsageQuotaItem quota={quota(meter('tokens', 'month', 999, null))} />);
    expect(screen.getByText('com_ui_usage_unlimited')).toBeInTheDocument();
  });

  it('orders weekly before monthly, tokens before images', () => {
    render(
      <UsageQuotaItem
        quota={quota(
          meter('images', 'month', 0, 3),
          meter('tokens', 'month', 0, 20),
          meter('images', 'week', 0, 2),
          meter('tokens', 'week', 0, 5),
        )}
      />,
    );
    const labels = screen
      .getAllByText(/^com_ui_usage_(this_week|this_month|images_this_week|images_this_month)$/)
      .map((node) => node.textContent);
    expect(labels).toEqual([
      'com_ui_usage_this_week',
      'com_ui_usage_this_month',
      'com_ui_usage_images_this_week',
      'com_ui_usage_images_this_month',
    ]);
  });

  it('renders nothing when no policy applies', () => {
    const { container } = render(<UsageQuotaItem quota={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('UsageQuotaItem with a usage package', () => {
  const credit = (window: 'week' | 'month', used: number, limit: number) => ({
    meter: 'credits' as const,
    window,
    used,
    limit,
    remaining: Math.max(limit - used, 0),
    usedBdt: (used / 1e6) * 123,
    limitBdt: (limit / 1e6) * 123,
    remainingBdt: (Math.max(limit - used, 0) / 1e6) * 123,
    unlimited: false,
    blocked: used >= limit,
    resetsAt: window === 'week' ? '2026-10-19T00:00:00.000Z' : '2026-11-01T00:00:00.000Z',
  });
  const institution = (window: 'week' | 'month', blocked: boolean) => ({
    meter: 'institution' as const,
    window,
    used: null,
    limit: null,
    remaining: null,
    unlimited: false,
    blocked,
    resetsAt: '2026-10-19T00:00:00.000Z',
  });
  const creditQuota = (
    meters: TQuotaResponse['meters'],
    pkg: TQuotaResponse['package'] = { key: 'standard', name: 'Standard', unlimited: false },
  ) => ({ tenantId: 't', unit: 'credits', enforced: true, package: pkg, meters }) as TQuotaResponse;

  it('shows the remaining allowance in taka, week first, under the package name', () => {
    render(
      <UsageQuotaItem
        quota={creditQuota([
          credit('month', 1_000_000, 4_878_048),
          credit('week', 500_000, 1_707_317),
        ])}
      />,
    );
    expect(screen.getByText('com_ui_usage_allowance_package|Standard')).toBeInTheDocument();
    const rows = screen.getAllByRole('note').map((node) => node.textContent);
    expect(rows[0]).toBe('com_ui_usage_remaining|৳148.5|৳210');
    expect(rows[1]).toBe('com_ui_usage_remaining|৳477|৳600');
    expect(screen.getAllByRole('progressbar')).toHaveLength(2);
  });

  it('shows Unlimited below 80% used and the real amounts above it', () => {
    const vip = { key: 'vip', name: 'Unlimited', unlimited: true };
    const { rerender } = render(
      <UsageQuotaItem quota={creditQuota([credit('month', 7_000_000, 56_910_569)], vip)} />,
    );
    expect(screen.getByRole('note')).toHaveTextContent('com_ui_usage_unlimited');
    expect(screen.queryByRole('progressbar')).toBeNull();

    rerender(
      <UsageQuotaItem quota={creditQuota([credit('month', 50_000_000, 56_910_569)], vip)} />,
    );
    expect(screen.getByRole('note')).toHaveTextContent('com_ui_usage_remaining');
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it("mentions the institution's pool only when it is used up", () => {
    const { rerender } = render(
      <UsageQuotaItem quota={creditQuota([credit('week', 0, 100), institution('week', false)])} />,
    );
    expect(screen.queryByRole('alert')).toBeNull();

    rerender(
      <UsageQuotaItem quota={creditQuota([credit('week', 0, 100), institution('week', true)])} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('com_ui_usage_institution_week_used');
  });
});
