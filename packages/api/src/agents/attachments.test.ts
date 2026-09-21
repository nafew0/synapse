import { Tools, FileSources } from 'librechat-data-provider';
import type { IMongoFile } from '@librechat/data-schemas';
import type { ServerRequest } from '~/types';
import {
  collectFileIds,
  buildAgentScopedContext,
  getAgentContextAttachments,
  buildUnreachableAttachmentsNote,
  buildAgentContextAttachmentsByAgentId,
} from './attachments';

const makeTextFile = (file_id: string, filename: string, text: string): IMongoFile =>
  ({
    file_id,
    filename,
    text,
    source: FileSources.text,
  }) as IMongoFile;

describe('agent attachment helpers', () => {
  it('collects file ids from attachment-like files', () => {
    const fileIds = collectFileIds([
      { file_id: 'file-1' },
      null,
      { file_id: '' },
      { file_id: 'file-2' },
      { file_id: 'file-1' },
    ]);

    expect(Array.from(fileIds)).toEqual(['file-1', 'file-2']);
  });

  it('builds an agent context attachment map from initialized configs', () => {
    const file = makeTextFile('context-file', 'context.txt', 'context');
    const attachmentsByAgentId = buildAgentContextAttachmentsByAgentId([
      { id: 'agent-a', agentContextAttachments: [file] },
      { id: 'agent-b', agentContextAttachments: [] },
      { id: null, agentContextAttachments: [file] },
      undefined,
    ]);

    expect(attachmentsByAgentId.size).toBe(1);
    expect(attachmentsByAgentId.get('agent-a')).toEqual([file]);
  });

  it('collects attachments from nested graph members', () => {
    const memberFile = makeTextFile('member-file', 'member.txt', 'member context');
    const attachmentsByAgentId = buildAgentContextAttachmentsByAgentId([
      {
        id: 'parent',
        subagentGraphConfigs: [
          {
            memberConfigs: [{ id: 'graph-member', agentContextAttachments: [memberFile] }],
          },
        ],
      },
    ]);

    expect(attachmentsByAgentId.get('graph-member')).toEqual([memberFile]);
  });

  it('filters shared request files out of scoped context attachments', () => {
    const shared = makeTextFile('shared-file', 'shared.txt', 'shared');
    const scoped = makeTextFile('scoped-file', 'scoped.txt', 'scoped');

    const attachments = getAgentContextAttachments({
      agentId: 'agent-a',
      attachmentsByAgentId: new Map([['agent-a', [shared, scoped]]]),
      excludeFileIds: new Set(['shared-file']),
    });

    expect(attachments).toEqual([scoped]);
  });

  it('builds scoped context only from non-shared context documents', async () => {
    const shared = makeTextFile('shared-file', 'shared.txt', 'Shared duplicate context');
    const scoped = makeTextFile('scoped-file', 'scoped.txt', 'Scoped private context');
    const req = {
      body: { fileTokenLimit: 1000 },
      config: {},
    } as ServerRequest;

    const scopedContext = await buildAgentScopedContext({
      agentIds: ['agent-a', 'agent-b'],
      attachmentsByAgentId: new Map([
        ['agent-a', [shared, scoped]],
        ['agent-b', [shared]],
      ]),
      sharedRunAttachmentIds: new Set(['shared-file']),
      req,
      tokenCountFn: (text) => text.length,
    });

    expect(scopedContext.get('agent-a')).toContain('Scoped private context');
    expect(scopedContext.get('agent-a')).not.toContain('Shared duplicate context');
    expect(scopedContext.has('agent-b')).toBe(false);
  });
});

describe('buildUnreachableAttachmentsNote', () => {
  const codeEnvRef = {
    kind: 'user',
    id: 'user-1',
    storage_session_id: 'session-1',
    file_id: 'code-file-1',
  };

  /** A long document as automatic preparation stores it: indexed for search, copied to the
   * sandbox, and none of its text in the conversation. */
  const makeSearchedDocument = (filename: string): IMongoFile =>
    ({
      file_id: `id-${filename}`,
      filename,
      type: 'application/pdf',
      source: FileSources.local,
      embedded: true,
      metadata: { codeEnvRef, preparation: { delivery: 'search', contextText: false } },
    }) as unknown as IMongoFile;

  it('names a searched document for an agent with neither file_search nor execute_code', () => {
    const note = buildUnreachableAttachmentsNote({
      attachments: [makeSearchedDocument('1788428549_6a994105719e0.pdf')],
      tools: ['ask_user_question'],
    });

    expect(note).toContain(
      '- 1788428549_6a994105719e0.pdf (indexed for search, in the code sandbox)',
    );
    expect(note).toContain('never tell the user that nothing is attached');
  });

  it('stays silent when the agent can search the document itself', () => {
    const note = buildUnreachableAttachmentsNote({
      attachments: [makeSearchedDocument('paper.docx')],
      tools: [Tools.file_search],
    });

    expect(note).toBeUndefined();
  });

  it('stays silent when the agent can open the sandbox copy', () => {
    const note = buildUnreachableAttachmentsNote({
      attachments: [makeSearchedDocument('paper.docx')],
      tools: [Tools.execute_code],
    });

    expect(note).toBeUndefined();
  });

  it('skips files whose contents are already in the conversation', () => {
    const readInFull = makeTextFile('file-1', 'order.pdf', 'Office order text');
    const spreadsheetWithPreview = {
      file_id: 'file-2',
      filename: 'budget.xlsx',
      source: FileSources.local,
      metadata: { codeEnvRef, preparation: { delivery: 'sandbox', contextText: true } },
    } as unknown as IMongoFile;
    const image = {
      file_id: 'file-3',
      filename: 'photo.png',
      type: 'image/png',
      source: FileSources.local,
    } as IMongoFile;

    const note = buildUnreachableAttachmentsNote({
      attachments: [readInFull, spreadsheetWithPreview, image],
      tools: [],
    });

    expect(note).toBeUndefined();
  });

  it('lists only the attachments the agent cannot reach', () => {
    const note = buildUnreachableAttachmentsNote({
      attachments: [
        makeTextFile('file-1', 'order.pdf', 'Office order text'),
        makeSearchedDocument('manuscript.docx'),
      ],
      tools: [],
    });

    expect(note).toContain('- manuscript.docx');
    expect(note).not.toContain('order.pdf');
  });
});
