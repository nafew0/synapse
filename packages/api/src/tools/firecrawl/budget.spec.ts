import { reserveFirecrawlCall, resolveFirecrawlBudgetScope } from './budget';

const limits = { maxSearches: 1, maxScrapes: 2 };

describe('resolveFirecrawlBudgetScope', () => {
  it('keys a resumable run by user, stream and job creation time', () => {
    const req = {};
    expect(
      resolveFirecrawlBudgetScope({ req, userId: 'u1', streamId: 'conv-1', jobCreatedAt: 1700 }),
    ).toBe('u1:conv-1:1700');
  });

  it('falls back to the request object when the run has no generation job', () => {
    const req = {};
    expect(resolveFirecrawlBudgetScope({ req, userId: 'u1', streamId: null })).toBe(req);
    expect(resolveFirecrawlBudgetScope({ req, userId: 'u1', streamId: 'conv-1' })).toBe(req);
  });
});

describe('reserveFirecrawlCall', () => {
  it('keeps the budget when a paused turn resumes on a new request', () => {
    const job = { userId: 'u2', streamId: 'conv-2', jobCreatedAt: 1800 };
    const firstRequest = resolveFirecrawlBudgetScope({ req: {}, ...job });
    const resumedRequest = resolveFirecrawlBudgetScope({ req: {}, ...job });

    expect(reserveFirecrawlCall(firstRequest, 'scrape', limits)).toBeNull();
    expect(reserveFirecrawlCall(resumedRequest, 'scrape', limits)).toBeNull();
    expect(reserveFirecrawlCall(resumedRequest, 'scrape', limits)).toContain(
      'Budget reached: firecrawl_scrape has been used 2 of 2 times',
    );
  });

  it('gives a new user message (a new job) a fresh budget', () => {
    const turn = { req: {}, userId: 'u3', streamId: 'conv-3' };
    const first = resolveFirecrawlBudgetScope({ ...turn, jobCreatedAt: 1 });
    const next = resolveFirecrawlBudgetScope({ ...turn, jobCreatedAt: 2 });

    expect(reserveFirecrawlCall(first, 'search', limits)).toBeNull();
    expect(reserveFirecrawlCall(first, 'search', limits)).toContain('Budget reached');
    expect(reserveFirecrawlCall(next, 'search', limits)).toBeNull();
  });

  it('keeps budgets of different users apart in the same conversation id', () => {
    const a = resolveFirecrawlBudgetScope({ userId: 'ua', streamId: 'c', jobCreatedAt: 5 });
    const b = resolveFirecrawlBudgetScope({ userId: 'ub', streamId: 'c', jobCreatedAt: 5 });
    expect(reserveFirecrawlCall(a, 'search', limits)).toBeNull();
    expect(reserveFirecrawlCall(b, 'search', limits)).toBeNull();
  });
});
