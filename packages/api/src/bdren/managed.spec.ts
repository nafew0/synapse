import type { NextFunction, Request, Response } from 'express';
import { requirePackagesEditable } from './managed';
import { readBdrenConfig } from './config';
import { overrideActive } from './credits';

const on = readBdrenConfig({
  BDREN_ALLOWANCE_ENABLED: 'true',
  BDREN_API_URL: 'https://bdren.test',
  BDREN_PRODUCT_KEY: 'k',
  BDREN_ISSUER: 'https://auth.bdren.test',
});
const off = readBdrenConfig({});

function run(config: typeof on, method: string) {
  const next = jest.fn() as unknown as NextFunction;
  const json = jest.fn();
  const res = { status: jest.fn(() => ({ json })) } as unknown as Response;
  requirePackagesEditable(config)({ method } as Request, res, next);
  return { next, status: res.status as jest.Mock, json };
}

describe('requirePackagesEditable', () => {
  it('blocks every change while bdren.ai owns the packages, and lets reads through', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const { next, status, json } = run(on, method);
      expect(next).not.toHaveBeenCalled();
      expect(status).toHaveBeenCalledWith(409);
      expect(json.mock.calls[0][0].code).toBe('PACKAGES_MANAGED_BY_BDREN');
    }
    expect(run(on, 'GET').next).toHaveBeenCalled();
  });

  it('does nothing when the link is off', () => {
    expect(run(off, 'POST').next).toHaveBeenCalled();
  });
});

describe('overrideActive', () => {
  const future = new Date(Date.now() + 86_400_000);
  const past = new Date(Date.now() - 1000);

  it('is true only for a flagged override that has not ended', () => {
    expect(overrideActive({ override: true, expiresAt: future })).toBe(true);
    expect(overrideActive({ override: true, expiresAt: past })).toBe(false);
    expect(overrideActive({ override: true, expiresAt: null })).toBe(false);
    expect(overrideActive({ override: false, expiresAt: future })).toBe(false);
    expect(overrideActive({ expiresAt: future })).toBe(false);
    expect(overrideActive(null)).toBe(false);
  });
});
