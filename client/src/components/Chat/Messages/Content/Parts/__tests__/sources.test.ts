import { parsePageSource, parseSearchSources } from '../sources';

const searchOutput = [
  '1. BdREN Annual Report 2025',
  'URL: https://www.bdren.net.bd/report',
  'Date: 2025-06-01',
  'Connectivity grew across 200 institutions.',
  '',
  '2. Research networks in South Asia',
  'URL: https://example.org/asia',
  'A survey of NRENs.',
  '',
  '3. BdREN Annual Report 2025 (mirror)',
  'URL: https://www.bdren.net.bd/report',
].join('\n');

describe('parseSearchSources', () => {
  it('returns each result once, with its title and link', () => {
    expect(parseSearchSources(searchOutput)).toEqual([
      { link: 'https://www.bdren.net.bd/report', title: 'BdREN Annual Report 2025' },
      { link: 'https://example.org/asia', title: 'Research networks in South Asia' },
    ]);
  });

  it('returns nothing for an empty search or a budget message', () => {
    expect(parseSearchSources('No results found for "x".')).toEqual([]);
    expect(parseSearchSources('Budget reached: Web search has been used 3 of 3 times')).toEqual([]);
  });
});

describe('parsePageSource', () => {
  it('reads the title and final URL from the page header', () => {
    const output = '# Tariffs 2026\nURL: https://bdren.net.bd/tariffs\n\nBody text';
    expect(parsePageSource(output)).toEqual({
      link: 'https://bdren.net.bd/tariffs',
      title: 'Tariffs 2026',
    });
  });

  it('uses the URL of a page with no readable content', () => {
    expect(parsePageSource('No readable content at https://a.org/x.pdf (status 404).')).toEqual({
      link: 'https://a.org/x.pdf',
    });
  });

  it('falls back to the requested URL, and to nothing without one', () => {
    expect(parsePageSource('', '{"url":"https://a.org/y"}')).toEqual({ link: 'https://a.org/y' });
    expect(parsePageSource('')).toBeNull();
  });
});
