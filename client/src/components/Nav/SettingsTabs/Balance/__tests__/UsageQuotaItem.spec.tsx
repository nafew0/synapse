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
