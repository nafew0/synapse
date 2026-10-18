import React from 'react';
import { render, screen } from '@testing-library/react';
import { RecoilRoot } from 'recoil';
import Error, { getErrorSeverity } from '../Error';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string, string>) =>
    values ? `${key}|${values['0']}` : key,
}));

/** `mock`-prefixed so jest allows the factory to close over it. */
const mockSetRequestedSettingsTab = jest.fn();
jest.mock('recoil', () => ({
  ...jest.requireActual('recoil'),
  useSetRecoilState: () => mockSetRequestedSettingsTab,
}));

const renderError = (payload: unknown) =>
  render(
    <RecoilRoot>
      <div>
        <Error text={JSON.stringify(payload)} />
      </div>
    </RecoilRoot>,
  );

describe('quota refusal message', () => {
  const resetAt = '2026-09-14T00:00:00.000Z';

  /**
   * The exact string the server emits, captured from a real refusal. Earlier
   * tests here invented a payload that omitted `code`, and so passed while the
   * UI rendered raw JSON: the client resolves its handler as
   * `json.code || json.type`, and an uppercase `code` shadowed the lowercase
   * `type` the handler is registered under. Pin the real shape.
   */
  it('renders the exact envelope the server sends', () => {
    render(
      <RecoilRoot>
        <div>
          <Error
            text={
              '{"type":"token_quota_exceeded","limitCode":"IMAGE_MONTHLY_CAP","window":"month","meter":"images","resetAt":"2026-10-01T00:00:00.000Z"}'
            }
          />
        </div>
      </RecoilRoot>,
    );
    expect(screen.getByText('com_error_quota_title_images')).toBeInTheDocument();
    expect(screen.getByText('com_error_quota_images_monthly')).toBeInTheDocument();
    expect(screen.queryByText(/token_quota_exceeded/)).not.toBeInTheDocument();
  });

  /** Guards the precedence trap directly: if `code` is ever reintroduced to the
   *  envelope, the handler lookup silently misses and the user sees raw JSON. */
  it('still resolves when an uppercase code shadows the type', () => {
    renderError({
      type: 'token_quota_exceeded',
      code: 'TOKEN_QUOTA_EXCEEDED',
      limitCode: 'WEEKLY_CAP',
      resetAt,
    });
    expect(screen.queryByText(/Something went wrong/)).not.toBeInTheDocument();
    expect(screen.getByText('com_error_quota_title')).toBeInTheDocument();
  });

  /** The bug this replaces: the refusal rendered as "Something went wrong. Here's
   *  the specific error message we encountered: Token quota exceeded". */
  it('does not fall back to the generic error wrapper', () => {
    renderError({ type: 'token_quota_exceeded', limitCode: 'WEEKLY_CAP', resetAt });
    expect(screen.queryByText(/Something went wrong/)).not.toBeInTheDocument();
  });

  it('names the weekly allowance and when it resets', () => {
    renderError({ type: 'token_quota_exceeded', limitCode: 'WEEKLY_CAP', resetAt });
    expect(screen.getByText('com_error_quota_title')).toBeInTheDocument();
    expect(screen.getByText('com_error_quota_weekly')).toBeInTheDocument();
  });

  it('names the monthly allowance separately', () => {
    renderError({ type: 'token_quota_exceeded', limitCode: 'MONTHLY_CAP', resetAt });
    expect(screen.getByText('com_error_quota_monthly')).toBeInTheDocument();
  });

  /** Images exhausting must not read as everything having stopped. */
  it('calls out the image allowance on its own', () => {
    renderError({ type: 'token_quota_exceeded', limitCode: 'IMAGE_WEEKLY_CAP', resetAt });
    expect(screen.getByText('com_error_quota_images_weekly')).toBeInTheDocument();
  });

  /** Allowance is left, just not enough for one image: text still works, so say so. */
  it('says an image costs more than what is left, not that the allowance is spent', () => {
    renderError({ type: 'token_quota_exceeded', limitCode: 'IMAGE_CREDITS_LOW', resetAt });
    expect(screen.getByText('com_error_quota_title_images')).toBeInTheDocument();
    expect(screen.getByText('com_error_quota_image_credits_low')).toBeInTheDocument();
  });

  it('shows the reset as an absolute date in its own pill', () => {
    renderError({ type: 'token_quota_exceeded', limitCode: 'WEEKLY_CAP', resetAt });
    const pill = screen.getByText(/com_ui_usage_resets\|/);
    expect(pill.textContent).toMatch(/\d/);
    expect(pill.textContent).not.toMatch(/in \d+ (day|hour)/i);
  });

  /** The body reads fine without a date, so an unknown reset instant should hide
   *  the pill rather than fall back to vaguer copy. */
  it('hides the reset pill when no instant is known, keeping the message', () => {
    renderError({ type: 'token_quota_exceeded', limitCode: 'WEEKLY_CAP', resetAt: null });
    expect(screen.queryByText(/com_ui_usage_resets/)).not.toBeInTheDocument();
    expect(screen.getByText('com_error_quota_weekly')).toBeInTheDocument();
  });

  it('deep-links Manage plan to the account settings tab', () => {
    renderError({ type: 'token_quota_exceeded', limitCode: 'WEEKLY_CAP', resetAt });
    screen.getByRole('button', { name: 'com_ui_usage_manage_plan' }).click();
    expect(mockSetRequestedSettingsTab).toHaveBeenCalledWith('account');
  });

  /** Every code the engine can emit should have copy; only a code from a NEWER
   *  server than this client should ever reach the generic fallback. */
  it.each([
    ['WEEKLY_CAP', 'com_error_quota_title', 'com_error_quota_weekly'],
    ['MONTHLY_CAP', 'com_error_quota_title', 'com_error_quota_monthly'],
    ['IMAGE_WEEKLY_CAP', 'com_error_quota_title_images', 'com_error_quota_images_weekly'],
    ['IMAGE_MONTHLY_CAP', 'com_error_quota_title_images', 'com_error_quota_images_monthly'],
    ['MODEL_CAP', 'com_error_quota_title_model', 'com_error_quota_model'],
    ['INSTITUTION_CAP', 'com_error_quota_title_institution', 'com_error_quota_institution'],
    [
      'INSTITUTION_WEEKLY_CAP',
      'com_error_quota_title_institution',
      'com_error_quota_institution_weekly',
    ],
  ])('names the allowance for %s', (limitCode, titleKey, bodyKey) => {
    renderError({ type: 'token_quota_exceeded', limitCode, resetAt });
    expect(screen.getByText(titleKey)).toBeInTheDocument();
    expect(screen.getByText(bodyKey)).toBeInTheDocument();
    expect(screen.queryByText('com_error_quota_generic')).not.toBeInTheDocument();
  });

  it('falls back when the limit code is unrecognised', () => {
    renderError({ type: 'token_quota_exceeded', limitCode: 'SOMETHING_NEW', resetAt });
    expect(screen.getByText('com_error_quota_generic')).toBeInTheDocument();
  });
});

describe('severity', () => {
  /** A usage limit is planned behaviour, not a failure: red trains people to read
   *  every amber box as something broken, and there is nothing to retry. */
  it('classifies a quota refusal as a notice, not an error', () => {
    expect(
      getErrorSeverity(
        '{"type":"token_quota_exceeded","limitCode":"IMAGE_MONTHLY_CAP","resetAt":"2026-10-01T00:00:00.000Z"}',
      ),
    ).toBe('notice');
  });

  it('classifies it as a notice even if an uppercase code shadows the type', () => {
    expect(getErrorSeverity('{"code":"TOKEN_QUOTA_EXCEEDED","limitCode":"WEEKLY_CAP"}')).toBe(
      'notice',
    );
  });

  it('leaves genuine failures as errors', () => {
    expect(getErrorSeverity('{"type":"moderation"}')).toBe('error');
    expect(getErrorSeverity('Something exploded')).toBe('error');
    expect(getErrorSeverity('')).toBe('error');
  });

  it('does not throw on malformed json', () => {
    expect(getErrorSeverity('{"type":')).toBe('error');
  });
});
