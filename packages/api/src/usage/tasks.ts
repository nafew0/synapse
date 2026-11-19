import mongoose from 'mongoose';
import { Constants } from '@librechat/agents';
import { logger, runAsSystem } from '@librechat/data-schemas';
import type { TaskType } from '@librechat/data-schemas';

/** What a request did, read from its settled content. */
export interface TaskSignals {
  toolNames: string[];
  skillNames: string[];
  /** The user attached files to this request or the conversation holds some. */
  hasFiles?: boolean;
}

interface ToolCallPart {
  type?: string;
  tool_call?: { name?: string; args?: string | Record<string, unknown> };
}

const READ_DOCUMENT_TOOL = 'read_document';
const WEB_TOOLS = new Set(['search_web', 'read_web_page']);
const FILE_TOOLS = new Set(['file_search', 'execute_code', 'bash_tool', READ_DOCUMENT_TOOL]);
const IMAGE_TOOL = /image_(gen|edit)|gemini_image|^dalle$|^flux$|stable-diffusion/i;
const MAIL_TOOL = /mail/i;
const DOCUMENT_SKILLS = new Set(['docx', 'pptx', 'xlsx', 'pdf', 'pdf-to-docx']);

function parseArgs(call: NonNullable<ToolCallPart['tool_call']>): string {
  return typeof call.args === 'string' ? call.args : JSON.stringify(call.args ?? {});
}

function skillNameOf(args: string): string | undefined {
  try {
    const parsed = JSON.parse(args) as { skillName?: unknown };
    return typeof parsed.skillName === 'string' ? parsed.skillName.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/** Collects the tools a request called and the skills it loaded from its content parts. */
export function extractTaskSignals(
  contentParts: ReadonlyArray<ToolCallPart | undefined> | undefined,
  hasFiles = false,
): TaskSignals {
  const tools = new Set<string>();
  const skills = new Set<string>();
  for (const part of contentParts ?? []) {
    const call = part?.type === 'tool_call' ? part.tool_call : undefined;
    if (!call?.name) {
      continue;
    }
    tools.add(call.name);
    if (call.name === Constants.SKILL_TOOL) {
      const skill = skillNameOf(parseArgs(call));
      if (skill) {
        skills.add(skill);
      }
      continue;
    }
    if (call.name === Constants.SUBAGENT && MAIL_TOOL.test(parseArgs(call))) {
      tools.add('mail_agent');
    }
  }
  return { toolNames: [...tools], skillNames: [...skills], hasFiles };
}

/**
 * Decides the task type, most specific first: research that ends in a document, a scan rebuilt as
 * Word, a document skill, mail, an image, web search, a question about a file, and plain chat last.
 */
export function classifyTask(signals: TaskSignals): TaskType {
  const tools = new Set(signals.toolNames);
  const skills = new Set(signals.skillNames);
  const names = [...tools];
  const usedWeb = names.some((name) => WEB_TOOLS.has(name));
  const producedDocument = [...skills].some((skill) => DOCUMENT_SKILLS.has(skill));
  const rebuiltAsWord = skills.has('docx') || skills.has('pdf-to-docx');

  if (usedWeb && producedDocument) {
    return 'research_document';
  }
  if (tools.has(READ_DOCUMENT_TOOL) && rebuiltAsWord) {
    return 'scan_to_word';
  }
  if (skills.has('pdf-to-docx')) {
    return 'pdf_to_word';
  }
  if (skills.has('pptx')) {
    return 'powerpoint';
  }
  if (skills.has('docx')) {
    return 'word';
  }
  if (skills.has('xlsx')) {
    return 'excel';
  }
  if (skills.has('pdf')) {
    return 'pdf_edit';
  }
  if (names.some((name) => MAIL_TOOL.test(name))) {
    return 'email';
  }
  if (names.some((name) => IMAGE_TOOL.test(name))) {
    return 'image';
  }
  if (usedWeb) {
    return 'web_search';
  }
  if (signals.hasFiles || names.some((name) => FILE_TOOLS.has(name))) {
    return 'file_question';
  }
  return 'chat';
}

export interface TagRequestInput {
  user: string;
  conversationId: string;
  messageId: string;
  taskType: TaskType;
  /** When the request began. Charges written without a message id (scan reads) are claimed from here. */
  since: Date;
}

/**
 * Stamps the request's ledger rows with its task type. Rows carrying the reply's message id are
 * tagged; charges recorded without one (OCR reads) in the same conversation since the request began
 * are claimed for it. Never throws, so a failed tag cannot fail the request.
 */
export async function tagRequestTaskType(input: TagRequestInput): Promise<number> {
  const { user, conversationId, messageId, taskType, since } = input;
  try {
    return await runAsSystem(async () => {
      const Transaction = mongoose.models.Transaction;
      const tagged = await Transaction.updateMany(
        { user, conversationId, messageId },
        { $set: { taskType } },
      );
      const claimed = await Transaction.updateMany(
        {
          user,
          conversationId,
          messageId: { $exists: false },
          service: 'unstructured',
          taskType: { $exists: false },
          createdAt: { $gte: since },
        },
        { $set: { taskType, messageId } },
      );
      return tagged.modifiedCount + claimed.modifiedCount;
    });
  } catch (error) {
    logger.error('[Usage] Failed to tag the request with its task type', error);
    return 0;
  }
}
