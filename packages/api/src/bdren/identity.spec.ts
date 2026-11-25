import { limitsManagedElsewhere } from './identity';
import { readBdrenConfig } from './config';

const issuer = 'https://auth.bdren.test';
const on = readBdrenConfig({
  BDREN_ALLOWANCE_ENABLED: 'true',
  BDREN_API_URL: 'https://bdren.test',
  BDREN_PRODUCT_KEY: 'k',
  BDREN_ISSUER: issuer,
});
const off = readBdrenConfig({});

const member = {
  id: 'u1',
  tenantId: 'tenant-a',
  accountScope: 'institution' as const,
  openidId: 'sub-1',
  openidIssuer: issuer,
};

describe('limitsManagedElsewhere', () => {
  it('is true for a user signed in through the bdren.ai issuer while the link is on', () => {
    expect(limitsManagedElsewhere(member, on)).toBe(true);
    expect(limitsManagedElsewhere({ ...member, openidIssuer: `${issuer}/` }, on)).toBe(true);
  });

  it('is false when the link is off', () => {
    expect(limitsManagedElsewhere(member, off)).toBe(false);
  });

  it('is false for users from another issuer or without an OpenID sign-in', () => {
    expect(limitsManagedElsewhere({ ...member, openidIssuer: 'https://other.test' }, on)).toBe(
      false,
    );
    expect(limitsManagedElsewhere({ ...member, openidId: undefined }, on)).toBe(false);
    expect(limitsManagedElsewhere(null, on)).toBe(false);
  });
});
