import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Account, Attachment, Question, Session, ToolCall } from './types.ts';

const POLL_MS = 4000;
const NO_PARENT = '00000000-0000-0000-0000-000000000000';
/** What the composer's "Upload file" sends: the server picks sandbox, search or context per file. */
const AUTO_TOOL_RESOURCE = 'auto';
const FALLBACK_ANSWER = 'Use your best judgement and proceed without asking again.';
/** Upload routes reject clients that are not browsers (uaParser) and log a violation for each. */
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 SynapseOfficeEval';

const MIME: Record<string, string> = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

/** Where a turn is sent: the variant's enforced spec and master agent. */
export interface Target {
  spec: string;
  agentId: string;
}

interface UploadedFile {
  file_id: string;
  filepath: string;
  filename: string;
  type: string;
  width?: number;
  height?: number;
}

interface ContentPart {
  type?: string;
  text?: string | { value?: string };
  tool_call?: { name?: string; args?: string | object; output?: string };
}

interface RawAttachment {
  file_id?: string;
  filename?: string;
  filepath?: string;
  type?: string;
}

export interface Message {
  messageId: string;
  parentMessageId?: string;
  isCreatedByUser?: boolean;
  unfinished?: boolean;
  error?: boolean;
  text?: string;
  content?: ContentPart[];
  attachments?: RawAttachment[];
  files?: RawAttachment[];
}

type AskOption = string | { label?: string; value?: string };

interface AskQuestion {
  id?: string;
  question?: string;
  header?: string;
  options?: AskOption[];
}

interface StatusResponse {
  active?: boolean;
  status?: string;
  createdAt?: number;
  pendingAction?: {
    actionId: string;
    payload?: {
      type?: string;
      question?: string;
      options?: AskOption[];
      questions?: AskQuestion[];
    };
  };
}

export interface TurnOutcome {
  conversationId: string;
  message?: Message;
  questions: Question[];
  seconds: number;
  finished: boolean;
  error?: string;
}

export interface SendOptions {
  text: string;
  files: UploadedFile[];
  conversationId?: string;
  parentMessageId?: string;
  timeoutSeconds: number;
  /** Scripted answers to ask_user_question, consumed in order. */
  answers: string[];
  /** Receives one line per status change, for the run's poll log. */
  log?: (line: string) => void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class Client {
  readonly base: string;
  readonly session: Session;

  private constructor(base: string, session: Session) {
    this.base = base;
    this.session = session;
  }

  static async login(base: string, account: Account): Promise<Client> {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
      body: JSON.stringify({ email: account.email, password: account.password }),
    });
    if (!res.ok) {
      throw new ApiError(
        res.status,
        `login as ${account.email} failed: ${res.status} ${await res.text()}`,
      );
    }
    const body = (await res.json()) as { token?: string; user?: { _id?: string; id?: string } };
    const userId = body.user?._id ?? body.user?.id;
    if (!body.token || !userId) {
      throw new Error(`login as ${account.email} returned no token or user`);
    }
    return new Client(base, { token: body.token, userId, email: account.email });
  }

  private async request<T>(method: string, route: string, body?: object | FormData): Promise<T> {
    const isForm = body instanceof FormData;
    const res = await fetch(`${this.base}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.session.token}`,
        'User-Agent': USER_AGENT,
        ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}),
      },
      body: isForm || body == null ? body : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new ApiError(res.status, `${method} ${route}: ${res.status} ${text.slice(0, 300)}`);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApiError(
        res.status,
        `${method} ${route}: unexpected response ${text.slice(0, 500)}`,
      );
    }
  }

  async upload(file: string, target: Target): Promise<UploadedFile> {
    const ext = path.extname(file).toLowerCase();
    const type = MIME[ext] ?? 'application/octet-stream';
    const isImage = type.startsWith('image/');
    const size = isImage ? imageSize(file) : undefined;
    const form = new FormData();
    form.append('endpoint', 'agents');
    form.append('endpointType', '');
    form.append(
      'file',
      await fs.openAsBlob(file, { type }),
      encodeURIComponent(path.basename(file)),
    );
    form.append('file_id', randomUUID());
    form.append('agent_id', target.agentId);
    form.append('spec', target.spec);
    form.append('tool_resource', AUTO_TOOL_RESOURCE);
    form.append('message_file', 'true');
    if (size) {
      form.append('width', String(size.width));
      form.append('height', String(size.height));
    }
    const uploaded = await this.request<UploadedFile>('POST', '/api/files', form);
    return { ...uploaded, ...size };
  }

  /** Sends one turn and waits for it, answering any ask_user_question pause along the way. */
  async send(target: Target, options: SendOptions): Promise<TurnOutcome> {
    const messageId = randomUUID();
    const turnParentId = options.parentMessageId ?? NO_PARENT;
    const base = {
      endpoint: 'agents',
      endpointType: undefined,
      spec: target.spec,
      agent_id: target.agentId,
      ephemeralAgent: {
        mcp: [],
        web_search: false,
        file_search: false,
        execute_code: false,
        memory: false,
        artifacts: '',
      },
    };
    const start = await this.request<{ conversationId?: string }>(
      'POST',
      '/api/agents/chat/agents',
      {
        ...base,
        text: options.text,
        sender: 'User',
        clientTimestamp: new Date().toISOString().slice(0, 19),
        isCreatedByUser: true,
        parentMessageId: turnParentId,
        messageId,
        error: false,
        key: new Date().toISOString(),
        isTemporary: false,
        isRegenerate: false,
        isContinued: false,
        timezone: 'Asia/Dhaka',
        clientRequestId: randomUUID(),
        generationProtocolVersion: 2,
        files: options.files.map(({ file_id, filepath, filename, type, width, height }) => ({
          file_id,
          filepath,
          filename,
          type,
          ...(width ? { width, height } : {}),
        })),
        ...(options.conversationId ? { conversationId: options.conversationId } : {}),
      },
    );
    const conversationId = start.conversationId ?? options.conversationId;
    if (!conversationId || conversationId === 'new') {
      throw new Error(
        `the chat admission named no conversation: ${JSON.stringify(start).slice(0, 200)}`,
      );
    }

    const began = Date.now();
    const questions: Question[] = [];
    const answered = new Set<string>();
    const scripted = [...options.answers];
    const elapsed = () => Math.round((Date.now() - began) / 1000);
    let lastState = '';
    let settled: string | undefined;

    while (elapsed() < options.timeoutSeconds) {
      await sleep(POLL_MS);
      const status = await this.status(conversationId);
      const action = status?.pendingAction;
      if (
        action &&
        action.payload?.type === 'ask_user_question' &&
        !answered.has(action.actionId)
      ) {
        answered.add(action.actionId);
        const asked = toQuestions(
          action.payload.questions,
          action.payload.question,
          action.payload.options,
          scripted,
        );
        questions.push(...asked);
        await this.request('POST', '/api/agents/chat/resume', {
          ...base,
          conversationId,
          generationCreatedAt: status?.createdAt,
          actionId: action.actionId,
          ...(action.payload.questions
            ? { answers: Object.fromEntries(asked.map((q) => [q.id ?? '', q.answer])) }
            : { answer: asked[0]?.answer ?? FALLBACK_ANSWER }),
        });
        continue;
      }
      const state = `active=${status?.active ?? 'none'} status=${status?.status ?? 'none'}`;
      if (state !== lastState) {
        options.log?.(`${elapsed()}s ${state}`);
        lastState = state;
      }
      const message = await this.reply(conversationId, turnParentId);
      if (!message || message.unfinished || !(message.content?.length || message.text)) {
        settled = undefined;
        continue;
      }
      /** Normally the job goes inactive once the reply is saved; a finished reply that stays
       *  unchanged across two polls also ends the turn, so a lagging status cannot stall a run. */
      const signature = `${message.messageId}:${message.content?.length}:${message.attachments?.length}`;
      if (!status?.active || signature === settled) {
        options.log?.(`${elapsed()}s done (${status?.active ? 'reply settled' : 'job inactive'})`);
        return { conversationId, message, questions, seconds: elapsed(), finished: true };
      }
      settled = signature;
    }

    options.log?.(`${elapsed()}s timed out, aborting`);
    await this.request('POST', '/api/agents/chat/abort', { conversationId }).catch(() => undefined);
    const message = await this.reply(conversationId, turnParentId).catch(() => undefined);
    return {
      conversationId,
      message,
      questions,
      seconds: elapsed(),
      finished: false,
      error: `no reply within ${options.timeoutSeconds}s`,
    };
  }

  private async status(conversationId: string): Promise<StatusResponse | undefined> {
    try {
      return await this.request<StatusResponse>(
        'GET',
        `/api/agents/chat/status/${encodeURIComponent(conversationId)}`,
      );
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.status === 503)) {
        return undefined;
      }
      throw error;
    }
  }

  async messages(conversationId: string): Promise<Message[]> {
    return this.request<Message[]>('GET', `/api/messages/${encodeURIComponent(conversationId)}`);
  }

  /**
   * The newest assistant message answering this turn. The server assigns the user message its own
   * id, so the turn is found as the newest user message under the turn's parent (the conversation
   * root or the previous reply), then followed through any continuation chain.
   */
  private async reply(conversationId: string, turnParentId: string): Promise<Message | undefined> {
    const messages = await this.messages(conversationId);
    const asked = messages.filter((m) => m.isCreatedByUser && m.parentMessageId === turnParentId);
    let parent = asked[asked.length - 1]?.messageId;
    let reply: Message | undefined;
    while (parent) {
      const next = messages.find((m) => !m.isCreatedByUser && m.parentMessageId === parent);
      if (!next) {
        return reply;
      }
      reply = next;
      parent = next.messageId;
    }
    return reply;
  }

  /** Saves a delivered file, trying the download route first and the stored path second. */
  async download(attachment: RawAttachment, dir: string): Promise<Attachment> {
    const filename = path.basename(attachment.filename ?? attachment.file_id ?? 'file');
    const result: Attachment = { fileId: attachment.file_id, filename, type: attachment.type };
    const urls = [
      attachment.file_id
        ? `${this.base}/api/files/download/${this.session.userId}/${encodeURIComponent(attachment.file_id)}`
        : undefined,
      attachment.filepath?.startsWith('http') ? attachment.filepath : undefined,
      attachment.filepath?.startsWith('/') ? `${this.base}${attachment.filepath}` : undefined,
    ].filter((url): url is string => url != null);
    const errors: string[] = [];
    for (const url of urls) {
      const res = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          ...(url.startsWith(this.base) ? { Authorization: `Bearer ${this.session.token}` } : {}),
        },
      }).catch((error: Error) => error);
      if (res instanceof Error || !res.ok) {
        errors.push(
          res instanceof Error ? res.message : `${res.status} from ${url.replace(this.base, '')}`,
        );
        continue;
      }
      fs.mkdirSync(dir, { recursive: true });
      const target = uniquePath(dir, filename);
      fs.writeFileSync(target, Buffer.from(await res.arrayBuffer()));
      return { ...result, path: target };
    }
    return { ...result, error: errors.join('; ') || 'no download location' };
  }
}

function uniquePath(dir: string, filename: string): string {
  const parsed = path.parse(filename);
  let candidate = path.join(dir, filename);
  for (let i = 2; fs.existsSync(candidate); i++) {
    candidate = path.join(dir, `${parsed.name}-${i}${parsed.ext}`);
  }
  return candidate;
}

const optionLabel = (option: AskOption): string =>
  typeof option === 'string' ? option : (option.label ?? option.value ?? '');

function toQuestions(
  batch: AskQuestion[] | undefined,
  single: string | undefined,
  singleOptions: AskOption[] | undefined,
  scripted: string[],
): Question[] {
  const items: AskQuestion[] = batch ?? [{ question: single, options: singleOptions }];
  return items.map((item) => {
    const options = (item.options ?? []).map(optionLabel).filter(Boolean);
    return {
      id: item.id,
      question: item.question ?? item.header ?? '',
      options,
      answer: scripted.shift() ?? options[0] ?? FALLBACK_ANSWER,
    };
  });
}

/** Reads width and height from a PNG or JPEG header; other formats upload without them. */
function imageSize(file: string): { width: number; height: number } | undefined {
  const data = fs.readFileSync(file);
  if (data.readUInt32BE(0) === 0x89504e47) {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (data[0] !== 0xff || data[1] !== 0xd8) {
    return undefined;
  }
  let offset = 2;
  while (offset + 9 < data.length) {
    const marker = data[offset + 1];
    const length = data.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return undefined;
}

const textOf = (part: ContentPart): string =>
  typeof part.text === 'string' ? part.text : (part.text?.value ?? '');

export function replyText(message: Message | undefined): string {
  const parts = (message?.content ?? []).filter((part) => part.type === 'text').map(textOf);
  return parts.join('\n').trim() || message?.text || '';
}

export function toolCalls(message: Message | undefined): ToolCall[] {
  return (message?.content ?? [])
    .filter((part) => part.type === 'tool_call' && part.tool_call)
    .map(({ tool_call }) => ({
      name: tool_call?.name ?? '?',
      args:
        typeof tool_call?.args === 'string'
          ? tool_call.args
          : JSON.stringify(tool_call?.args ?? ''),
      output: tool_call?.output ?? '',
    }));
}

export function deliveredFiles(message: Message | undefined): RawAttachment[] {
  return (message?.attachments ?? []).filter((item) => item.filename || item.file_id);
}
