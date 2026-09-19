import { dedupeInjectedFiles, sandboxDestination } from './injectedFiles';

jest.mock('@librechat/data-schemas', () => ({
  logger: { debug: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

describe('sandboxDestination', () => {
  it('keeps a path-safe name as it is', () => {
    expect(sandboxDestination('roadmap_v2.pptx')).toBe('roadmap_v2.pptx');
    expect(sandboxDestination('skills/pdf/scripts/fill.py')).toBe('skills/pdf/scripts/fill.py');
  });

  it('leaves a space alone, because the sandbox does', () => {
    /** codeapi mounts a name verbatim; only control characters are rewritten on upload. */
    expect(sandboxDestination('527. Dr. Md. Tarikat Islam- Office Order.pdf')).toBe(
      '527. Dr. Md. Tarikat Islam- Office Order.pdf',
    );
  });

  it('replaces the control characters the upload path replaces', () => {
    expect(sandboxDestination('report\u0007.docx')).toBe('report_.docx');
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

  it('keeps a spaced name and an underscored one apart', () => {
    /**
     * They are two different files in the sandbox: codeapi mounts a name verbatim and the upload
     * path rewrites only control characters. Folding them together dropped the one the model had
     * been handed, which then failed to open — "No such file or directory" for a file the user
     * had just uploaded.
     */
    const kept = dedupeInjectedFiles([
      { id: 'uploaded', name: '527. Dr. Md. Tarikat Islam- Office Order.pdf' },
      { id: 'converted', name: '527._Dr._Md._Tarikat_Islam-_Office_Order.pdf' },
    ]);

    expect(kept.map((file) => file.id)).toEqual(['uploaded', 'converted']);
  });

  it('still collapses two objects that claim the very same name', () => {
    const kept = dedupeInjectedFiles([
      { id: 'first', name: '527. Dr. Md. Tarikat Islam- Office Order.docx' },
      { id: 'second', name: '527. Dr. Md. Tarikat Islam- Office Order.docx' },
    ]);

    expect(kept.map((file) => file.id)).toEqual(['first']);
  });

  it('normalises only what the upload path normalises', () => {
    const kept = dedupeInjectedFiles([
      { id: 'control', name: 'report\u0007.docx' },
      { id: 'underscore', name: 'report_.docx' },
    ]);

    expect(kept.map((file) => file.id)).toEqual(['control']);
  });

  it('drops a second object that would overwrite the first', () => {
    /** A re-upload of the same document: two objects, one destination, first seen wins. */
    const kept = dedupeInjectedFiles([
      { id: 'older', name: 'report final.docx' },
      { id: 'newer', name: 'report final.docx' },
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

  it('drops an upload that would take the directory the skills mount in', () => {
    /**
     * codeapi rejects a path that is the parent of one another input claims (`job.ts:920`), so a
     * file named `skills` fails every execution in the conversation — naming two files the user
     * never connected. Skill files are seeded first, so the skill tree keeps its directory.
     */
    const kept = dedupeInjectedFiles([
      { id: 'skill-md', name: 'skills/docx/SKILL.md' },
      { id: 'skill-py', name: 'skills/docx/scripts/merge_runs.py' },
      { id: 'upload', name: 'skills' },
    ]);

    expect(kept.map((file) => file.id)).toEqual(['skill-md', 'skill-py']);
  });

  it('drops a file that would be mounted inside another input', () => {
    const kept = dedupeInjectedFiles([
      { id: 'parent', name: 'out' },
      { id: 'child', name: 'out/report.docx' },
    ]);

    expect(kept.map((file) => file.id)).toEqual(['parent']);
  });

  it('sends one stored object once, however it is spelled', () => {
    /**
     * The failure this was written for: codeapi mounts a ref at the name its own egress
     * returns, so the sandbox echoes an input back under a different spelling than the one
     * asked for, and the merge keeps both. Two refs, one object, one destination — and codeapi
     * refuses the whole execution against itself: "Conflicting input destinations:
     * 527._Dr._…pdf and 527._Dr._…pdf". Every call in the conversation 400s from then on.
     */
    const kept = dedupeInjectedFiles([
      {
        id: 'jiZagNvli2gcd2X4xUibx',
        name: '527. Dr. Md. Tarikat Islam- Office Order.pdf',
        storage_session_id: 'vupOHA48t14D4WngkJCmg',
      },
      {
        id: 'jiZagNvli2gcd2X4xUibx',
        name: '527._Dr._Md._Tarikat_Islam-_Office_Order.pdf',
        storage_session_id: 'vupOHA48t14D4WngkJCmg',
      },
    ]);

    expect(kept.map((file) => file.name)).toEqual(['527. Dr. Md. Tarikat Islam- Office Order.pdf']);
  });

  it('keeps one id that lives in two storage sessions apart', () => {
    /** A reupload keeps the file id and lands in a fresh session: two objects, two mounts. */
    const kept = dedupeInjectedFiles([
      { id: 'shared', name: 'old.pdf', storage_session_id: 'session-a' },
      { id: 'shared', name: 'new.pdf', storage_session_id: 'session-b' },
    ]);

    expect(kept.map((file) => file.name)).toEqual(['old.pdf', 'new.pdf']);
  });

  it('still separates two objects that merely share a spelling rule', () => {
    const kept = dedupeInjectedFiles([
      { id: 'one', name: 'Office Order.pdf', storage_session_id: 's' },
      { id: 'two', name: 'Office_Order.pdf', storage_session_id: 's' },
    ]);

    expect(kept.map((file) => file.id)).toEqual(['one', 'two']);
  });

  it('keeps siblings that merely share a directory', () => {
    const kept = dedupeInjectedFiles([
      { id: 'a', name: 'reports/q1.docx' },
      { id: 'b', name: 'reports/q2.docx' },
    ]);

    expect(kept.map((file) => file.id)).toEqual(['a', 'b']);
  });
});
