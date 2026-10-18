import mongoose from 'mongoose';
import { EModelEndpoint } from 'librechat-data-provider';
import { createTxMethods } from '@librechat/data-schemas';
import type { IUsagePackage } from '@librechat/data-schemas';
import type { UsageMetadata } from '~/stream/interfaces/IJobStore';
import type { UsageCatalogSnapshot } from './credits';
import { matchModelName, findMatchingPattern } from '~/utils';
import { DEFAULT_USAGE_PRICING } from './packages';
import { createUsageCatalog } from './catalog';
import {
  usesCredits,
  creditRates,
  creditsForUsage,
  estimateCredits,
  creditLimitCode,
  resolveCreditLimits,
  withoutEdgeTargets,
  imageCreditsEstimate,
  outputTokensForCredits,
  unaffordableImageAgents,
} from './credits';

const { getMultiplier, getCacheMultiplier } = createTxMethods(mongoose, {
  matchModelName: (model, endpoint) => matchModelName(model, endpoint as EModelEndpoint),
  findMatchingPattern: (model, values) => findMatchingPattern(model, values) ?? undefined,
});
const pricing = { getMultiplier, getCacheMultiplier };

const haikuConfig = {
  'anthropic/claude-haiku-4.5': {
    prompt: 1,
    completion: 5,
    read: 0.1,
    write: 1.25,
    context: 200000,
  },
};
const imageConfig = {
  'google/gemini-3.1-flash-lite-image': { prompt: 0.25, completion: 30, context: 65536 },
};

function pkg(overrides: Partial<IUsagePackage>): IUsagePackage {
  return {
    key: 'starter',
    name: 'Starter',
    description: '',
    scopes: ['member'],
    price: 300,
    monthlyCredit: 300,
    weeklyPercent: null,
    unlimited: false,
    active: true,
    sortOrder: 0,
    ...overrides,
  } as IUsagePackage;
}

function catalog(...packages: IUsagePackage[]): UsageCatalogSnapshot {
  return { packages: new Map(packages.map((p) => [p.key, p])), pricing: DEFAULT_USAGE_PRICING };
}

describe('credit pricing', () => {
  it('reads credits per token from the billing table and endpoint config', () => {
    expect(creditRates({ model: 'openai/gpt-5.6-luna', endpoint: 'OpenRouter', pricing })).toEqual({
      input: 0.2,
      output: 1.2,
    });
    expect(
      creditRates({
        model: 'anthropic/claude-haiku-4.5',
        endpoint: 'OpenRouter',
        endpointTokenConfig: haikuConfig,
        pricing,
      }),
    ).toEqual({ input: 1, output: 5 });
  });

  it('estimates a request in credits, rounding up', () => {
    expect(
      estimateCredits({ inputTokens: 1000, outputTokens: 500 }, { input: 0.2, output: 1.2 }),
    ).toBe(800);
    expect(estimateCredits({ inputTokens: 3, outputTokens: 0 }, { input: 0.2, output: 1.2 })).toBe(
      1,
    );
  });

  it('fits the output to what is left after paying for the input', () => {
    expect(outputTokensForCredits(1000, 400, 1.2)).toBe(500);
    expect(outputTokensForCredits(300, 400, 1.2)).toBe(0);
    expect(outputTokensForCredits(10, 0, 0)).toBe(Number.POSITIVE_INFINITY);
  });

  it('prices each call of a run at its own model, image included', () => {
    const usages = [
      { model: 'openai/gpt-5.6-luna', input_tokens: 10_000, output_tokens: 2_000 },
      { model: 'google/gemini-3.1-flash-lite-image', input_tokens: 300, output_tokens: 1_120 },
    ] as UsageMetadata[];
    const credits = creditsForUsage(usages, pricing, (usage) =>
      usage.model === 'google/gemini-3.1-flash-lite-image' ? imageConfig : undefined,
    );
    const text = 10_000 * 0.2 + 2_000 * 1.2;
    const image = 300 * 0.25 + 1_120 * 30;
    expect(credits).toBe(Math.round(text + image));
  });

  it('prices cached input at the cache rates', () => {
    const credits = creditsForUsage(
      [
        {
          model: 'anthropic/claude-haiku-4.5',
          /** OpenRouter reports input including cached tokens. */
          provider: 'openrouter',
          input_tokens: 4_000,
          output_tokens: 100,
          input_token_details: { cache_read: 3_000, cache_creation: 0 },
        },
      ] as UsageMetadata[],
      pricing,
      () => haikuConfig,
    );
    expect(credits).toBe(Math.round(1_000 * 1 + 3_000 * 0.1 + 100 * 5));
  });
});

describe('resolveCreditLimits', () => {
  const starter = pkg({});
  const pool = pkg({
    key: 'pool',
    scopes: ['institution'],
    monthlyCredit: 30_000,
    weeklyPercent: 30,
  });
  const vip = pkg({ key: 'vip', monthlyCredit: 7_000, unlimited: true });

  it('meters in credits only once a package is assigned', () => {
    expect(usesCredits(null, null)).toBe(false);
    expect(usesCredits({ memberPackageKey: 'starter' }, null)).toBe(true);
    expect(usesCredits(null, { packageKey: 'vip' })).toBe(true);
  });

  it('converts both packages to monthly and weekly credits', () => {
    const limits = resolveCreditLimits({
      institutionPackage: { packageKey: 'pool', memberPackageKey: 'starter' },
      catalog: catalog(starter, pool),
    });
    expect(limits.member).toEqual({ month: 2_439_024, week: 853_658 });
    expect(limits.institution.month).toBe(Math.floor((30_000 / 123) * 1e6));
    expect(limits.institution.week).toBe(Math.floor((30_000 / 123) * 0.3 * 1e6));
    expect(limits).toMatchObject({
      institutionPackageKey: 'pool',
      memberPackageKey: 'starter',
      unlimited: false,
    });
  });

  it("lets a member's own package override the institution default", () => {
    const limits = resolveCreditLimits({
      institutionPackage: { memberPackageKey: 'starter' },
      memberPackage: { packageKey: 'vip' },
      catalog: catalog(starter, vip),
    });
    expect(limits.memberPackageKey).toBe('vip');
    expect(limits.unlimited).toBe(true);
    expect(limits.institution).toEqual({ month: null, week: null });
  });

  it('falls back to the institution default once a member package expires', () => {
    const limits = resolveCreditLimits({
      institutionPackage: { memberPackageKey: 'starter' },
      memberPackage: { packageKey: 'vip', expiresAt: new Date('2026-10-01T00:00:00Z') },
      catalog: catalog(starter, vip),
      now: new Date('2026-10-18T00:00:00Z'),
    });
    expect(limits.memberPackageKey).toBe('starter');
  });

  it('keeps applying an archived package and ignores a key with no package', () => {
    const archived = pkg({ active: false });
    expect(
      resolveCreditLimits({
        institutionPackage: { memberPackageKey: 'starter' },
        catalog: catalog(archived),
      }).member.month,
    ).toBe(2_439_024);
    expect(
      resolveCreditLimits({ institutionPackage: { memberPackageKey: 'gone' }, catalog: catalog() }),
    ).toMatchObject({ member: { month: null, week: null }, memberPackageKey: null });
  });

  it('names each credit wall', () => {
    expect(creditLimitCode('member_credits', 'week')).toBe('WEEKLY_CAP');
    expect(creditLimitCode('member_credits', 'month')).toBe('MONTHLY_CAP');
    expect(creditLimitCode('institution_credits', 'week')).toBe('INSTITUTION_WEEKLY_CAP');
    expect(creditLimitCode('institution_credits', 'month')).toBe('INSTITUTION_CAP');
  });
});

describe('createUsageCatalog', () => {
  it('caches for the TTL, reloads after it, and reloads at once when invalidated', async () => {
    let clock = 0;
    const listUsagePackages = jest.fn().mockResolvedValue([pkg({})]);
    const getUsagePricing = jest.fn().mockResolvedValue(null);
    const usageCatalog = createUsageCatalog(
      { listUsagePackages, getUsagePricing },
      { ttlMs: 1000, now: () => clock },
    );

    const first = await usageCatalog.load();
    expect(first.packages.get('starter')?.name).toBe('Starter');
    expect(first.pricing).toEqual(DEFAULT_USAGE_PRICING);
    await usageCatalog.load();
    expect(listUsagePackages).toHaveBeenCalledTimes(1);
    expect(listUsagePackages).toHaveBeenCalledWith({ includeArchived: true });

    clock = 1500;
    await usageCatalog.load();
    expect(listUsagePackages).toHaveBeenCalledTimes(2);

    usageCatalog.invalidate();
    await usageCatalog.load();
    expect(listUsagePackages).toHaveBeenCalledTimes(3);
  });

  it('does not cache a failed load', async () => {
    const listUsagePackages = jest
      .fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue([]);
    const usageCatalog = createUsageCatalog({
      listUsagePackages,
      getUsagePricing: jest.fn().mockResolvedValue(null),
    });
    await expect(usageCatalog.load()).rejects.toThrow('down');
    await expect(usageCatalog.load()).resolves.toMatchObject({ packages: new Map() });
  });
});

describe('image allowance', () => {
  const liteImage = { input: 0.25, output: 30 };

  it('prices one 1K image at the image model rates', () => {
    expect(imageCreditsEstimate(liteImage)).toBe(500 * 0.25 + 1120 * 30);
  });

  it('finds image agents the remaining allowance cannot cover', () => {
    const agents = new Map([
      [
        'agent_office_images',
        { model: 'google/gemini-3.1-flash-lite-image', provider: 'OpenRouter Image' },
      ],
      ['agent_writer', { model: 'openai/gpt-5.6-luna', provider: 'OpenRouter' }],
    ]);
    const price = () => imageCreditsEstimate(liteImage);
    expect([...unaffordableImageAgents(agents, 10_000, price)]).toEqual(['agent_office_images']);
    expect(unaffordableImageAgents(agents, 50_000, price).size).toBe(0);
  });

  it('removes hand-offs to the dropped agents and drops empty edges', () => {
    const edges = [
      { from: 'main', to: 'agent_office_images', edgeType: 'handoff' },
      { from: 'main', to: ['agent_writer', 'agent_office_images'], edgeType: 'handoff' },
    ];
    expect(withoutEdgeTargets(edges, new Set(['agent_office_images']))).toEqual([
      { from: 'main', to: ['agent_writer'], edgeType: 'handoff' },
    ]);
    expect(withoutEdgeTargets(undefined, new Set(['x']))).toEqual([]);
  });
});
