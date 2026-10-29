import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { FileContext } from 'librechat-data-provider';
import { fileSchema, createMethods } from '@librechat/data-schemas';
import type { IMongoFile } from '@librechat/data-schemas';
import type { FileAuthoringContext } from './deps';
import { createFileAuthoringTools } from './tools';
import { createFileAuthoringDeps } from './deps';

const owner = new mongoose.Types.ObjectId().toString();
const stranger = new mongoose.Types.ObjectId().toString();
const conversationId = 'convo-1';

let methods: ReturnType<typeof createMethods>;
let mongoServer: MongoMemoryServer;

/** Storage stand-in: the strategy layer is outside this module, the database is real. */
const storage = new Map<string, Buffer>();

function context(overrides: Partial<FileAuthoringContext> = {}): FileAuthoringContext {
  return {
    userId: owner,
    conversationId,
    requestFileIds: [],
    getConvoFiles: async () => ['full-1', 'searched-1', 'foreign-1'],
    getFiles: (filter, sort, select) => methods.getFiles(filter, sort, select),
    createFile: (data, disableTTL) => methods.createFile(data, disableTTL),
    readStored: async (file) => storage.get(file.filepath) ?? null,
    storeBuffer: async ({ fileName, buffer }) => {
      const filepath = `/uploads/${owner}/${fileName}`;
      storage.set(filepath, buffer);
      return { filepath, source: 'local' };
    },
    getRetention: async () => ({}),
    ...overrides,
  };
}

async function seed(file: Partial<IMongoFile>) {
  await methods.createFile({ object: 'file', bytes: 1, usage: 0, ...file }, true);
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  if (!mongoose.models.File) {
    mongoose.model('File', fileSchema);
  }
  await mongoose.connect(mongoServer.getUri());
  methods = createMethods(mongoose);
}, 20000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.models.File.deleteMany({});
  storage.clear();
  await seed({
    file_id: 'full-1',
    user: new mongoose.Types.ObjectId(owner),
    filename: 'scan.py',
    type: 'text/x-python',
    text: 'print("hi")\n',
    metadata: { preparation: { delivery: 'full_text' } } as IMongoFile['metadata'],
  });
  storage.set('/uploads/searched.ts', Buffer.from('export const a = 1;\n'));
  await seed({
    file_id: 'searched-1',
    user: new mongoose.Types.ObjectId(owner),
    filename: 'big.ts',
    type: 'application/typescript',
    filepath: '/uploads/searched.ts',
    text: 'preview only',
    metadata: { preparation: { delivery: 'search' } } as IMongoFile['metadata'],
  });
  await seed({
    file_id: 'foreign-1',
    user: new mongoose.Types.ObjectId(stranger),
    filename: 'secret.py',
    type: 'text/x-python',
    text: 'TOKEN = "x"\n',
    metadata: { preparation: { delivery: 'full_text' } } as IMongoFile['metadata'],
  });
});

describe('createFileAuthoringDeps', () => {
  it("lists the user's conversation files and never another user's", async () => {
    const files = await createFileAuthoringDeps(context()).listFiles();
    expect(files.map((f) => f.filename).sort()).toEqual(['big.ts', 'scan.py']);
  });

  it('reads a file delivered in full from its stored text', async () => {
    const deps = createFileAuthoringDeps(context());
    const scan = (await deps.listFiles()).find((f) => f.filename === 'scan.py');
    expect(scan?.hasCompleteText).toBe(true);
    expect(await deps.readContent(scan!)).toBe('print("hi")\n');
  });

  it('reads a searched file from its stored original, not the preview', async () => {
    const deps = createFileAuthoringDeps(context());
    const big = (await deps.listFiles()).find((f) => f.filename === 'big.ts');
    expect(big?.hasCompleteText).toBe(false);
    expect(await deps.readContent(big!)).toBe('export const a = 1;\n');
  });

  it('includes files attached to the current message of a new conversation', async () => {
    const deps = createFileAuthoringDeps(
      context({ conversationId: undefined, requestFileIds: ['full-1'] }),
    );
    expect((await deps.listFiles()).map((f) => f.filename)).toEqual(['scan.py']);
  });

  it('saves a file the next turn can find and edit again', async () => {
    const tools = createFileAuthoringTools(createFileAuthoringDeps(context()));
    const patch = tools[2];
    const first = await patch.invoke({
      id: 'c1',
      name: patch.name,
      type: 'tool_call',
      args: { filename: 'scan.py', edits: [{ old: 'hi', new: 'hello' }] },
    });
    const saved = (first.artifact as { saved_file: IMongoFile }).saved_file;
    expect(saved).toMatchObject({
      filename: 'scan-edited.py',
      type: 'text/x-python',
      context: FileContext.file_authoring,
      conversationId,
      source: 'local',
    });
    expect(saved).not.toHaveProperty('text');

    const record = await mongoose.models.File.findOne({
      file_id: saved.file_id,
    }).lean<IMongoFile>();
    expect(record?.text).toBe('print("hello")\n');
    expect(record?.user.toString()).toBe(owner);
    expect(storage.get(record!.filepath)?.toString()).toBe('print("hello")\n');

    const nextTurn = createFileAuthoringTools(createFileAuthoringDeps(context()))[2];
    const second = await nextTurn.invoke({
      id: 'c2',
      name: nextTurn.name,
      type: 'tool_call',
      args: { filename: 'scan-edited.py', edits: [{ old: 'hello', new: 'bye' }] },
    });
    expect(String(second.content)).toContain('Saved "scan-edited-2.py"');
  });

  it("does not let another user's session see this conversation's saved files", async () => {
    const tools = createFileAuthoringTools(createFileAuthoringDeps(context()));
    await tools[1].invoke({
      id: 'c1',
      name: tools[1].name,
      type: 'tool_call',
      args: { filename: 'notes.md', content: '# mine' },
    });
    const theirs = await createFileAuthoringDeps(
      context({ userId: stranger, getConvoFiles: async () => [] }),
    ).listFiles();
    expect(theirs.map((f) => f.filename)).toEqual([]);
  });
});
