import { INDIVIDUAL_USAGE_ACCOUNT } from '@librechat/data-schemas';
import { isReservedTenantId, isUsageAccount, quotaAccountFor } from './accounts';

describe('quotaAccountFor', () => {
  it('meters an institution member under their institution', () => {
    expect(quotaAccountFor({ tenantId: 'uni', accountScope: 'institution' })).toBe('uni');
  });

  it('meters a standalone user under the individuals account', () => {
    expect(quotaAccountFor({ accountScope: 'standalone' })).toBe(INDIVIDUAL_USAGE_ACCOUNT);
  });

  it('leaves platform staff and unknown callers unmetered', () => {
    expect(quotaAccountFor({})).toBeNull();
    expect(quotaAccountFor(null)).toBeNull();
  });
});

describe('quota account keys', () => {
  it('tells the individuals account from an institution', () => {
    expect(isUsageAccount(INDIVIDUAL_USAGE_ACCOUNT)).toBe(true);
    expect(isUsageAccount('uni')).toBe(false);
  });

  it('reserves the account prefix so no institution can take it', () => {
    expect(isReservedTenantId(INDIVIDUAL_USAGE_ACCOUNT)).toBe(true);
    expect(isReservedTenantId(' __anything')).toBe(true);
    expect(isReservedTenantId('uni')).toBe(false);
    expect(isReservedTenantId(undefined)).toBe(false);
  });
});
