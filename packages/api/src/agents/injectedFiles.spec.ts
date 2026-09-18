import { dedupeInjectedFiles, sandboxDestination } from './injectedFiles';

jest.mock('@librechat/data-schemas', () => ({
  logger: { debug: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

describe('sandboxDestination', () => {
  it('keeps a path-safe name as it is', () => {
    expect(sandboxDestination('roadmap_v2.pptx')).toBe('roadmap_v2.pptx');
    expect(sandboxDestination('skills/pdf/scripts/fill.py')).toBe('skills/pdf/scripts/fill.py');
  });

  it('replaces what codeapi cannot keep in a path', () => {
    expect(sandboxDestination('527. Dr. Md. Tarikat Islam- Office Order.pdf')).toBe(
      '527._Dr._Md._Tarikat_Islam-_Office_Order.pdf',
    );
  });

  it('is empty for a missing name', () => {
    expect(sandboxDestination(undefined)).toBe('');
  });
});

describe('dedupeInjectedFiles', () => {
  it('leaves distinct destinations alone', () => {
    const files = [
      { id: 'a', name: 'order.pdf' },
      { id: 'b', name: 'notes.docx' },
    ];

    expect(dedupeInjectedFiles(files)).toEqual(files);
  });

  it('sends one input when a name and its sanitized form both appear', () => {
    /**
     * Regression: the seeded entry carries the user's filename and the sandbox echoes its own
     * sanitized spelling back after the first call. Both reached codeapi, which resolved them to
     * one path and rejected every execution in the conversation.
     */
    const kept = dedupeInjectedFiles([
      { id: 'same', name: '527. Dr. Md. Tarikat Islam- Office Order.pdf' },
      { id: 'same', name: '527._Dr._Md._Tarikat_Islam-_Office_Order.pdf' },
    ]);

    expect(kept).toEqual([{ id: 'same', name: '527. Dr. Md. Tarikat Islam- Office Order.pdf' }]);
  });

  it('drops a second object that would overwrite the first', () => {
    const kept = dedupeInjectedFiles([
      { id: 'older', name: 'report final.docx' },
      { id: 'newer', name: 'report_final.docx' },
    ]);

    expect(kept.map((f) => f.id)).toEqual(['older']);
  });

  it('keeps unnamed refs rather than collapsing them together', () => {
    const kept = dedupeInjectedFiles([{ id: 'a' }, { id: 'b' }]);

    expect(kept).toHaveLength(2);
  });

  it('returns a short list untouched', () => {
    const files = [{ id: 'only', name: 'one.pdf' }];

    expect(dedupeInjectedFiles(files)).toBe(files);
  });
});
