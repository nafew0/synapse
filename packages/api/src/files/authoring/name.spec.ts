import { cleanFileName, editedName, uniqueName, withExtension } from './name';

describe('cleanFileName', () => {
  it('keeps only the last path segment', () => {
    expect(cleanFileName('../../etc/passwd')).toBe('passwd');
    expect(cleanFileName('C:\\Users\\me\\scan.py')).toBe('scan.py');
  });

  it('replaces unsafe characters and drops leading dots', () => {
    expect(cleanFileName('a:b*c?.py')).toBe('a_b_c_.py');
    expect(cleanFileName('...hidden.txt')).toBe('hidden.txt');
  });

  it('shortens long names but keeps the extension', () => {
    const cleaned = cleanFileName(`${'x'.repeat(300)}.py`);
    expect(cleaned.length).toBeLessThanOrEqual(120);
    expect(cleaned.endsWith('.py')).toBe(true);
  });

  it('keeps Bangla names', () => {
    expect(cleanFileName('প্রতিবেদন.md')).toBe('প্রতিবেদন.md');
  });
});

describe('withExtension', () => {
  it('replaces a different extension', () => {
    expect(withExtension('scan.txt', 'py')).toBe('scan.py');
    expect(withExtension('scan', 'py')).toBe('scan.py');
    expect(withExtension('scan.PY', 'py')).toBe('scan.PY');
  });
});

describe('uniqueName', () => {
  it('numbers a name that is already taken', () => {
    const taken = new Set(['scan-edited.py', 'scan-edited-2.py']);
    expect(uniqueName('scan-edited.py', taken)).toBe('scan-edited-3.py');
    expect(uniqueName('other.py', taken)).toBe('other.py');
  });
});

describe('editedName', () => {
  const taken = new Set(['scan.py']);

  it('defaults to <stem>-edited.<ext>', () => {
    expect(editedName({ source: 'scan.py', taken })).toBe('scan-edited.py');
  });

  it('numbers later rounds instead of stacking suffixes', () => {
    const later = new Set(['scan.py', 'scan-edited.py']);
    expect(editedName({ source: 'scan-edited.py', taken: later })).toBe('scan-edited-2.py');
  });

  it('honours a requested name but keeps the source format', () => {
    expect(editedName({ source: 'scan.py', requested: 'fixed.txt', taken })).toBe('fixed.py');
    expect(editedName({ source: 'scan.py', requested: 'fixed', taken })).toBe('fixed.py');
  });

  it('never returns the source name itself', () => {
    expect(editedName({ source: 'scan.py', requested: 'scan.py', taken })).toBe('scan-edited.py');
  });
});
