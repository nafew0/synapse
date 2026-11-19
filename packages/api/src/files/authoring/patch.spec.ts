import { applyEdits } from './patch';

describe('applyEdits', () => {
  const source = 'def scan(host):\n    return ping(host)\n\nprint(scan("a"))\n';

  it('applies edits in order', () => {
    const result = applyEdits(source, [
      { old: 'return ping(host)', new: 'return ping(host, timeout=2)' },
      { old: 'print(scan("a"))', new: 'print(scan("b"))' },
    ]);
    expect(result).toEqual({
      ok: true,
      content: 'def scan(host):\n    return ping(host, timeout=2)\n\nprint(scan("b"))\n',
    });
  });

  it('fails without changing anything when a match is missing', () => {
    const result = applyEdits(source, [
      { old: 'return ping(host)', new: 'x' },
      { old: 'not in the file', new: 'y' },
    ]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('Edit 2');
  });

  it('refuses an ambiguous match', () => {
    const result = applyEdits('a = 1\na = 1\n', [{ old: 'a = 1', new: 'a = 2' }]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('more than once');
  });

  it('refuses an empty old text and an empty edit list', () => {
    expect(applyEdits(source, [{ old: '', new: 'x' }]).ok).toBe(false);
    expect(applyEdits(source, []).ok).toBe(false);
  });

  it('deletes text when new is empty', () => {
    expect(applyEdits('keep\ndrop\n', [{ old: 'drop\n', new: '' }])).toEqual({
      ok: true,
      content: 'keep\n',
    });
  });

  it('matches edits written with \\n in a file with Windows line endings', () => {
    const crlf = 'line one\r\nline two\r\nline three\r\n';
    const result = applyEdits(crlf, [{ old: 'line one\nline two', new: 'first\nsecond' }]);
    expect(result).toEqual({ ok: true, content: 'first\r\nsecond\r\nline three\r\n' });
  });

  it('handles Bangla text', () => {
    const result = applyEdits('শিরোনাম: পুরনো\n', [{ old: 'পুরনো', new: 'নতুন' }]);
    expect(result).toEqual({ ok: true, content: 'শিরোনাম: নতুন\n' });
  });

  it('does not treat $ patterns in the replacement specially', () => {
    expect(applyEdits('cost', [{ old: 'cost', new: "$& and $'" }])).toEqual({
      ok: true,
      content: "$& and $'",
    });
  });
});
