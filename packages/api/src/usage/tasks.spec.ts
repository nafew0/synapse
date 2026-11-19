import mongoose from 'mongoose';
import { Constants } from '@librechat/agents';
import { createModels } from '@librechat/data-schemas';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { ITransaction, TaskType } from '@librechat/data-schemas';
import type { TaskSignals } from './tasks';
import { classifyTask, extractTaskSignals, tagRequestTaskType } from './tasks';

const skill = (skillName: string) => ({
  type: 'tool_call',
  tool_call: { name: Constants.SKILL_TOOL, args: JSON.stringify({ skillName }) },
});
const tool = (name: string, args: unknown = {}) => ({
  type: 'tool_call',
  tool_call: { name, args },
});

const classify = (parts: unknown[], hasFiles = false): TaskType =>
  classifyTask(extractTaskSignals(parts as never, hasFiles));

describe('classifyTask', () => {
  const cases: [string, unknown[], boolean, TaskType][] = [
    ['plain reply', [{ type: 'text', text: 'hi' }], false, 'chat'],
    ['an attached file and no tools', [], true, 'file_question'],
    ['file search', [tool('file_search')], false, 'file_question'],
    ['docx skill', [skill('docx'), tool('execute_code')], true, 'word'],
    ['xlsx skill', [skill('xlsx')], false, 'excel'],
    ['pptx skill', [skill('pptx'), tool('execute_code')], false, 'powerpoint'],
    [
      'pptx skill with generated images',
      [skill('pptx'), tool('gemini_image_gen')],
      false,
      'powerpoint',
    ],
    ['pdf skill', [skill('pdf')], true, 'pdf_edit'],
    ['pdf-to-docx skill', [skill('pdf-to-docx')], true, 'pdf_to_word'],
    [
      'pdf-to-docx after an OCR read',
      [tool('read_document'), skill('pdf-to-docx')],
      true,
      'scan_to_word',
    ],
    ['docx after an OCR read', [tool('read_document'), skill('docx')], true, 'scan_to_word'],
    ['OCR read and nothing built', [tool('read_document')], true, 'file_question'],
    ['search only', [tool('search_web'), tool('read_web_page')], false, 'web_search'],
    ['search then a Word file', [tool('search_web'), skill('docx')], false, 'research_document'],
    ['search then a deck', [tool('search_web'), skill('pptx')], false, 'research_document'],
    ['generated image', [tool('image_gen_oai')], false, 'image'],
    ['mail tool', [tool('draft_email')], true, 'email'],
    [
      'subagent that is the mail agent',
      [tool(Constants.SUBAGENT, { agent: 'Mail Agent' })],
      false,
      'email',
    ],
    ['subagent that is not', [tool(Constants.SUBAGENT, { agent: 'Researcher' })], false, 'chat'],
  ];

  it.each(cases)('%s', (_name, parts, hasFiles, expected) => {
    expect(classify(parts, hasFiles)).toBe(expected);
  });

  it('reads skill names whether the args arrive as JSON text or as an object', () => {
    const signals = extractTaskSignals([
      skill('XLSX'),
      { type: 'tool_call', tool_call: { name: Constants.SKILL_TOOL, args: { skillName: 'docx' } } },
      { type: 'tool_call', tool_call: { name: Constants.SKILL_TOOL, args: '{not json' } },
    ] as never);
    expect(signals.skillNames.sort()).toEqual(['docx', 'xlsx']);
  });

  it('takes the most specific type when signals overlap', () => {
    const signals: TaskSignals = {
      toolNames: ['search_web', 'read_document', 'image_gen_oai', 'draft_email'],
      skillNames: ['docx', 'xlsx'],
      hasFiles: true,
    };
    expect(classifyTask(signals)).toBe('research_document');
  });
});

describe('tagRequestTaskType', () => {
  let mongoServer: MongoMemoryServer;
  let Transaction: mongoose.Model<ITransaction>;
  const user = new mongoose.Types.ObjectId();
  const stranger = new mongoose.Types.ObjectId();
  const since = new Date('2026-11-14T01:00:00Z');

  const base = {
    tokenType: 'credits' as const,
    tokenValue: -1000,
    billable: true,
    conversationId: 'c1',
  };

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    Object.assign(mongoose.models, createModels(mongoose));
    Transaction = mongoose.models.Transaction;
    await Transaction.syncIndexes();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(() => Transaction.deleteMany({}));

  it('tags the reply, its title and web charges, and claims an OCR read made during the request', async () => {
    await Transaction.insertMany([
      { ...base, user, requestKey: 'a', messageId: 'reply', tokenType: 'prompt' },
      { ...base, user, requestKey: 'b', messageId: 'reply', tokenType: 'completion' },
      { ...base, user, requestKey: 'c', messageId: 'reply', service: 'firecrawl' },
      {
        ...base,
        user,
        requestKey: 'ocr',
        service: 'unstructured',
        createdAt: new Date('2026-11-14T01:00:05Z'),
      },
      {
        ...base,
        user,
        requestKey: 'old-ocr',
        service: 'unstructured',
        createdAt: new Date('2026-11-13T01:00:00Z'),
      },
      { ...base, user, requestKey: 'other-msg', messageId: 'earlier' },
      { ...base, user: stranger, requestKey: 'other-user', messageId: 'reply' },
      { ...base, user, requestKey: 'other-convo', messageId: 'reply', conversationId: 'c2' },
    ]);

    const changed = await tagRequestTaskType({
      user: user.toString(),
      conversationId: 'c1',
      messageId: 'reply',
      taskType: 'scan_to_word',
      since,
    });

    expect(changed).toBe(4);
    const tagged = await Transaction.find({ taskType: 'scan_to_word' }).lean();
    expect(tagged.map((tx) => tx.requestKey).sort()).toEqual(['a', 'b', 'c', 'ocr']);
    expect(tagged.every((tx) => tx.messageId === 'reply' && String(tx.user) === String(user))).toBe(
      true,
    );
  });

  it('does not take rows that already carry a type', async () => {
    await Transaction.insertMany([
      {
        ...base,
        user,
        requestKey: 'voice',
        service: 'stt',
        taskType: 'voice',
        createdAt: new Date('2026-11-14T01:00:05Z'),
      },
    ]);
    await tagRequestTaskType({
      user: user.toString(),
      conversationId: 'c1',
      messageId: 'reply',
      taskType: 'chat',
      since,
    });
    expect((await Transaction.findOne({ requestKey: 'voice' }).lean())?.taskType).toBe('voice');
  });

  it('is safe to repeat', async () => {
    await Transaction.insertMany([{ ...base, user, requestKey: 'a', messageId: 'reply' }]);
    const input = {
      user: user.toString(),
      conversationId: 'c1',
      messageId: 'reply',
      taskType: 'word' as const,
      since,
    };
    await tagRequestTaskType(input);
    await tagRequestTaskType(input);
    expect(await Transaction.countDocuments({ taskType: 'word' })).toBe(1);
  });
});
