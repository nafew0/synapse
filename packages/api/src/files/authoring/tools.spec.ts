import type { DynamicStructuredTool } from '@librechat/agents/langchain/tools';
import type { AuthoringFile, FileAuthoringDeps, SavedFileInput } from './tools';
import { createFileAuthoringTools, MAX_READ_CHARS } from './tools';
import { SAVED_FILE_ARTIFACT_KEY } from './definitions';

type Stored = AuthoringFile & { text?: string; original?: string };

/** An in-memory stand-in for the file collection and storage the real deps wrap. */
function createStore(initial: Stored[]) {
  const files: Stored[] = [...initial];
  const saved: SavedFileInput[] = [];
  const deps: FileAuthoringDeps = {
    listFiles: async () => files,
    readContent: async (file) => {
      const stored = files.find((f) => f.file_id === file.file_id);
      return (stored?.hasCompleteText ? stored.text : stored?.original) ?? null;
    },
    saveFile: async (input) => {
      saved.push(input);
      const record = {
        file_id: `saved-${saved.length}`,
        filename: input.filename,
        type: input.type,
        hasCompleteText: true,
        text: input.content,
        updatedAt: new Date(Date.now() + saved.length),
      };
      files.push(record);
      return record;
    },
  };
  return { deps, saved };
}

async function call(tool: DynamicStructuredTool, args: Record<string, unknown>) {
  const message = await tool.invoke({
    id: 'call-1',
    name: tool.name,
    args,
    type: 'tool_call',
  });
  return {
    content: String(message.content),
    artifact: message.artifact as Record<string, AuthoringFile> | undefined,
  };
}

const script = 'import os\n\ndef main():\n    print("hi")\n';

function setup(extra: Stored[] = []) {
  const store = createStore([
    {
      file_id: 'up-1',
      filename: 'scan.py',
      type: 'text/x-python',
      hasCompleteText: true,
      text: script,
      updatedAt: '2026-10-29T00:00:00Z',
    },
    {
      file_id: 'up-2',
      filename: 'big.ts',
      type: 'application/typescript',
      original: 'const a = 1;\n',
      updatedAt: '2026-10-29T00:00:00Z',
    },
    {
      file_id: 'up-3',
      filename: 'report.docx',
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      updatedAt: '2026-10-29T00:00:00Z',
    },
    {
      file_id: 'up-5',
      filename: 'minutes.docx',
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      hasCompleteText: true,
      text: 'Meeting minutes',
      updatedAt: '2026-10-29T00:00:00Z',
    },
    ...extra,
  ]);
  const [read, save, patch] = createFileAuthoringTools(store.deps);
  return { ...store, read, save, patch };
}

describe('read_attachment', () => {
  it('returns the complete text of a file read in full', async () => {
    const { read } = setup();
    const { content } = await call(read, { filename: 'SCAN.py' });
    expect(content).toContain('lines 1-5 of 5');
    expect(content).toContain('print("hi")');
  });

  it('falls back to the stored original for a searched file', async () => {
    const { read } = setup();
    expect((await call(read, { filename: 'big.ts' })).content).toContain('const a = 1;');
  });

  it('reads a line range and says where to continue', async () => {
    const { read } = setup();
    const { content } = await call(read, { filename: 'scan.py', start_line: 1, end_line: 2 });
    expect(content).toContain('lines 1-2 of 5. Read on with start_line 3.');
    expect(content).not.toContain('def main');
  });

  it('caps a long file and points to the next line', async () => {
    const long = Array.from({ length: 20_000 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n');
    const { read } = setup([
      {
        file_id: 'up-4',
        filename: 'long.txt',
        type: 'text/plain',
        hasCompleteText: true,
        text: long,
      },
    ]);
    const { content } = await call(read, { filename: 'long.txt' });
    expect(content.length).toBeLessThan(MAX_READ_CHARS + 200);
    expect(content).toMatch(/Read on with start_line \d+\./);
  });

  it('lists the available files when the name is unknown', async () => {
    const { read } = setup();
    const { content } = await call(read, { filename: 'missing.py' });
    expect(content).toContain('No file named "missing.py"');
    expect(content).toContain('"scan.py"');
  });

  it('refuses a binary office file', async () => {
    const { read } = setup();
    expect((await call(read, { filename: 'report.docx' })).content).toContain('not a text file');
  });
});

describe('patch_file', () => {
  it('saves an edited copy in the same format and leaves the original alone', async () => {
    const { patch, saved, read } = setup();
    const { content, artifact } = await call(patch, {
      filename: 'scan.py',
      edits: [{ old: 'print("hi")', new: 'print("hello")' }],
    });
    expect(content).toContain('Saved "scan-edited.py"');
    expect(saved).toEqual([
      {
        filename: 'scan-edited.py',
        type: 'text/x-python',
        content: 'import os\n\ndef main():\n    print("hello")\n',
      },
    ]);
    expect(artifact?.[SAVED_FILE_ARTIFACT_KEY]?.filename).toBe('scan-edited.py');
    expect((await call(read, { filename: 'scan.py' })).content).toContain('print("hi")');
  });

  it('can edit its own output, numbering the next copy', async () => {
    const { patch } = setup();
    await call(patch, { filename: 'scan.py', edits: [{ old: 'hi', new: 'one' }] });
    const second = await call(patch, {
      filename: 'scan-edited.py',
      edits: [{ old: 'one', new: 'two' }],
    });
    expect(second.content).toContain('Saved "scan-edited-2.py"');
  });

  it('keeps the extension when the model asks for another one', async () => {
    const { patch, saved } = setup();
    await call(patch, {
      filename: 'scan.py',
      edits: [{ old: 'hi', new: 'x' }],
      new_filename: 'fixed.txt',
    });
    expect(saved[0].filename).toBe('fixed.py');
  });

  it('saves nothing when an edit does not match', async () => {
    const { patch, saved } = setup();
    const { content, artifact } = await call(patch, {
      filename: 'scan.py',
      edits: [{ old: 'nope', new: 'x' }],
    });
    expect(content).toContain('Not saved.');
    expect(artifact).toBeUndefined();
    expect(saved).toHaveLength(0);
  });

  it('reads but never patches an office file whose text was extracted in full', async () => {
    const { read, patch, saved } = setup();
    expect((await call(read, { filename: 'minutes.docx' })).content).toContain('Meeting minutes');
    const { content } = await call(patch, {
      filename: 'minutes.docx',
      edits: [{ old: 'Meeting', new: 'Board' }],
    });
    expect(content).toContain('Office Assistant');
    expect(saved).toHaveLength(0);
  });

  it('sends office files to the Office Assistant', async () => {
    const { patch } = setup();
    const { content } = await call(patch, {
      filename: 'report.docx',
      edits: [{ old: 'a', new: 'b' }],
    });
    expect(content).toContain('Office Assistant');
  });
});

describe('save_file', () => {
  it('creates a new file with a type from its extension', async () => {
    const { save, saved } = setup();
    const { artifact } = await call(save, { filename: 'notes.md', content: '# Notes\n' });
    expect(saved[0]).toEqual({ filename: 'notes.md', type: 'text/markdown', content: '# Notes\n' });
    expect(artifact?.[SAVED_FILE_ARTIFACT_KEY]?.file_id).toBe('saved-1');
  });

  it('never overwrites a name in use and cleans unsafe names', async () => {
    const { save, saved } = setup();
    await call(save, { filename: '../scan.py', content: 'x' });
    await call(save, { filename: 'notes', content: 'y' });
    expect(saved.map((s) => s.filename)).toEqual(['scan-2.py', 'notes.txt']);
  });

  it('refuses content over the size limit', async () => {
    const { save, saved } = setup();
    const { content } = await call(save, {
      filename: 'huge.txt',
      content: 'x'.repeat(3 * 1024 * 1024),
    });
    expect(content).toContain('Not saved');
    expect(saved).toHaveLength(0);
  });

  it('reports a storage failure instead of throwing', async () => {
    const { deps } = createStore([]);
    deps.saveFile = async () => {
      throw new Error('disk full');
    };
    const [, save] = createFileAuthoringTools(deps);
    const { content } = await call(save, { filename: 'a.txt', content: 'x' });
    expect(content).toContain('storage error');
  });
});
