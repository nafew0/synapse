import { liveBdrenOverride } from './override';
import { createAllowanceClient } from './client';
import { readBdrenConfig } from './config';

const config = readBdrenConfig({
  BDREN_ALLOWANCE_ENABLED: 'true',
  BDREN_API_URL: 'https://bdren.test',
  BDREN_PRODUCT_KEY: 'k',
  BDREN_ISSUER: 'https://auth.bdren.test',
});

const now = new Date('2026-11-25T10:00:00Z');

const override = {
  scope: 'person',
  kind: 'package',
  starts_at: '2026-11-20T00:00:00Z',
  ends_at: '2026-12-20T00:00:00Z',
  package: { name: 'Plus', slug: 'plus', kind: 'bundle' },
};

const payload = {
  product: 'synapse',
  user: { subject: 'sub-1' },
  plan_source: 'institution',
  package: { slug: 'business-pro', name: 'Business Pro', version: 1 },
  subscription: null,
  limits: { ai_credits: { monthly: 10 } },
  limits_source: 'override',
  windows: {},
  override,
  etag: 'e1',
};

describe('liveBdrenOverride', () => {
  it('shows the running override without its reason', () => {
    expect(liveBdrenOverride({ override }, now)).toEqual({
      scope: 'person',
      kind: 'package',
      packageName: 'Plus',
      startsAt: '2026-11-20T00:00:00Z',
      endsAt: '2026-12-20T00:00:00Z',
    });
  });

  it('is null without an override or once it has ended', () => {
    expect(liveBdrenOverride(null, now)).toBeNull();
    expect(liveBdrenOverride({}, now)).toBeNull();
    expect(liveBdrenOverride({ override: null }, now)).toBeNull();
    expect(
      liveBdrenOverride({ override: { ...override, ends_at: '2026-11-25T09:59:59Z' } }, now),
    ).toBeNull();
  });

  it('keeps a limits override without a package', () => {
    const limits = { ...override, kind: 'limits', scope: 'institution', package: null };
    expect(liveBdrenOverride({ override: limits }, now)).toMatchObject({
      scope: 'institution',
      kind: 'limits',
      packageName: null,
    });
  });
});

describe('allowance client', () => {
  it('keeps the override block of the answer', async () => {
    const fetchFn = jest.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));
    const client = createAllowanceClient(config, fetchFn);
    const result = await client.fetchAllowance({
      issuer: 'https://auth.bdren.test',
      subject: 'sub-1',
    });
    expect(result.status).toBe('ok');
    expect(result.status === 'ok' && result.payload.override).toEqual(override);
  });
});
