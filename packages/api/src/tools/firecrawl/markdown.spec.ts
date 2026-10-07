import { cleanMarkdown } from './markdown';

describe('cleanMarkdown', () => {
  it('removes images, including linked images and titled ones', () => {
    const input = [
      '![logo](https://www.bdren.net.bd/asset/images/default/logo.png)',
      'Intro [![badge](https://x.org/b.svg)](https://x.org) text',
      '![chart](https://x.org/c.png "Chart") after',
    ].join('\n');
    expect(cleanMarkdown(input)).toBe('Intro  text\n after');
  });

  it('unwraps ordinary links to their text', () => {
    expect(
      cleanMarkdown('See [the IRRI page](https://www.irri.org/where-we-work/bangladesh).'),
    ).toBe('See the IRRI page.');
  });

  it('keeps URLs of document and DOI links', () => {
    const input =
      'Read [the circular](https://e.bdren.net.bd/c/notice.PDF?v=2) and [the paper](https://doi.org/10.1007/s10113-025-02516-4).';
    expect(cleanMarkdown(input)).toBe(
      'Read the circular (https://e.bdren.net.bd/c/notice.PDF?v=2) and the paper (https://doi.org/10.1007/s10113-025-02516-4).',
    );
  });

  it('handles URLs with balanced parentheses and relative links', () => {
    expect(
      cleanMarkdown('[Rice](https://en.wikipedia.org/wiki/Rice_(disambiguation)) and [home](/)'),
    ).toBe('Rice and home');
  });

  it('drops navigation lines and empty bullets but keeps tables and rules', () => {
    const input = [
      '[Skip to main content](https://link.springer.com/article/x#main)',
      'Loading \\[MathJax\\]/jax/output/CommonHTML/jax.js',
      '[Top](https://www.bdren.net.bd/member#0)',
      '- [](https://x.org)',
      '| Year | Yield |',
      '|---|---|',
      '| 2025 | 4.1 |',
      '---',
      '## Results',
    ].join('\n');
    expect(cleanMarkdown(input)).toBe(
      '| Year | Yield |\n|---|---|\n| 2025 | 4.1 |\n---\n## Results',
    );
  });

  it('collapses runs of blank lines and trims trailing spaces', () => {
    expect(cleanMarkdown('\n\nA  \n\n\n\nB\n\n')).toBe('A\n\nB');
  });
});
