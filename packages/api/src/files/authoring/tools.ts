import { logger } from '@librechat/data-schemas';
import { inferMimeType } from 'librechat-data-provider';
import { tool } from '@librechat/agents/langchain/tools';
import type { DynamicStructuredTool } from '@librechat/agents/langchain/tools';
import type { FileEdit } from './patch';
import {
  SAVED_FILE_ARTIFACT_KEY,
  READ_ATTACHMENT_TOOL_NAME,
  PATCH_FILE_TOOL_NAME,
  SAVE_FILE_TOOL_NAME,
  fileAuthoringToolkit,
} from './definitions';
import { cleanFileName, editedName, splitName, uniqueName } from './name';
import { applyEdits } from './patch';

/** Most characters `read_attachment` returns in one call; longer files are read by line range. */
export const MAX_READ_CHARS: number = 60_000;
/** Largest file `save_file` or `patch_file` will write. */
export const MAX_SAVE_BYTES: number = 2 * 1024 * 1024;

/** A file the tools can see: an upload in this conversation or a file they saved earlier. */
export interface AuthoringFile {
  file_id: string;
  filename: string;
  type: string;
  /** The stored text is the whole file (a file read in full, or one these tools saved). */
  hasCompleteText?: boolean;
  /** Newer files win when two share a name. */
  updatedAt?: Date | string;
}

export interface SavedFileInput {
  filename: string;
  content: string;
  type: string;
}

export interface FileAuthoringDeps {
  /** Files the current user may use in this conversation. Must never return another user's file. */
  listFiles: () => Promise<AuthoringFile[]>;
  /**
   * Reads the whole file as UTF-8: its stored text when that is complete, otherwise the stored
   * original. `null` when neither exists.
   */
  readContent: (file: AuthoringFile) => Promise<string | null>;
  /** Stores the content and creates the file record; returns the record the user downloads. */
  saveFile: (input: SavedFileInput) => Promise<AuthoringFile & Record<string, unknown>>;
}

type ToolOutput = [string, Record<string, unknown> | undefined];
type ReadInput = { filename: string; start_line?: number; end_line?: number };
type SaveInput = { filename: string; content: string };
type PatchInput = { filename: string; edits: FileEdit[]; new_filename?: string };

/** Turns a storage failure into a message the model can act on rather than a failed turn. */
function guarded<T>(
  name: string,
  run: (input: T) => Promise<ToolOutput>,
): (input: T) => Promise<ToolOutput> {
  return async (input: T) => {
    try {
      return await run(input);
    } catch (error) {
      logger.error(`[file_authoring] ${name} failed`, error);
      return [
        `Could not complete ${name} because of a storage error. Tell the user to try again.`,
        undefined,
      ];
    }
  };
}

const TEXT_APPLICATION_TYPES =
  /^application\/(json|xml|csv|javascript|x-javascript|typescript|x-sh|x-tex|sql|yaml|x-yaml)$/;

/** Whether a file's content is plain text the tools can read and edit as-is. */
export const isTextType = (type: string): boolean =>
  type.startsWith('text/') || TEXT_APPLICATION_TYPES.test(type);

const typeForName = (filename: string): string => inferMimeType(filename, '') || 'text/plain';

const byNewest = (a: AuthoringFile, b: AuthoringFile): number =>
  new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime();

function findFile(files: AuthoringFile[], filename: string): AuthoringFile | undefined {
  const wanted = filename.trim().toLowerCase();
  return [...files].sort(byNewest).find((file) => file.filename.toLowerCase() === wanted);
}

const listNames = (files: AuthoringFile[]): string =>
  files.length > 0 ? files.map((file) => `"${file.filename}"`).join(', ') : 'none';

const takenNames = (files: AuthoringFile[]): Set<string> =>
  new Set(files.map((file) => file.filename.toLowerCase()));

/** Selects lines `start`..`end` (1-based, inclusive), cut at {@link MAX_READ_CHARS}. */
function sliceLines(
  content: string,
  start = 1,
  end?: number,
): { text: string; first: number; last: number; total: number } {
  const lines = content.split('\n');
  const total = lines.length;
  const first = Math.min(Math.max(start, 1), total);
  let last = Math.min(end ?? total, total);
  let text = lines.slice(first - 1, last).join('\n');
  while (text.length > MAX_READ_CHARS && last > first) {
    last = first + Math.floor((last - first) / 2);
    text = lines.slice(first - 1, last).join('\n');
  }
  return { text: text.slice(0, MAX_READ_CHARS), first, last, total };
}

/**
 * Creates the chat-model file tools. They touch only Synapse's own file storage through `deps`:
 * nothing here runs code or reaches the sandbox, so they are safe for assistants without one.
 */
export function createFileAuthoringTools(deps: FileAuthoringDeps): DynamicStructuredTool[] {
  const readContent = (file: AuthoringFile): Promise<string | null> =>
    file.hasCompleteText || isTextType(file.type) ? deps.readContent(file) : Promise.resolve(null);

  const save = async (filename: string, content: string): Promise<ToolOutput> => {
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_SAVE_BYTES) {
      return [
        `Not saved: "${filename}" would be ${bytes} bytes; the limit is ${MAX_SAVE_BYTES}.`,
        undefined,
      ];
    }
    const saved = await deps.saveFile({
      filename,
      content,
      type: typeForName(filename),
    });
    return [
      `Saved "${saved.filename}" (${bytes} bytes). It is shown to the user as a download; do not paste its content in your reply.`,
      { [SAVED_FILE_ARTIFACT_KEY]: saved },
    ];
  };

  const readAttachment = tool(
    guarded(READ_ATTACHMENT_TOOL_NAME, async (input: ReadInput): Promise<ToolOutput> => {
      const files = await deps.listFiles();
      const file = findFile(files, input.filename);
      if (!file) {
        return [
          `No file named "${input.filename}" in this conversation. Files: ${listNames(files)}.`,
          undefined,
        ];
      }
      const content = await readContent(file);
      if (content == null) {
        return [
          `"${file.filename}" (${file.type}) is not a text file, so it cannot be read here. Answer from the text included in the message, or use file_search.`,
          undefined,
        ];
      }
      const { text, first, last, total } = sliceLines(content, input.start_line, input.end_line);
      const more = last < total ? ` Read on with start_line ${last + 1}.` : '';
      return [
        `File "${file.filename}", lines ${first}-${last} of ${total}.${more}\n\n${text}`,
        undefined,
      ];
    }),
    { ...fileAuthoringToolkit.read_attachment, responseFormat: 'content_and_artifact' },
  ) as DynamicStructuredTool;

  const saveFile = tool(
    guarded(SAVE_FILE_TOOL_NAME, async (input: SaveInput): Promise<ToolOutput> => {
      const files = await deps.listFiles();
      const cleaned = cleanFileName(input.filename);
      const named = splitName(cleaned).ext ? cleaned : `${cleaned || 'file'}.txt`;
      return save(uniqueName(named, takenNames(files)), input.content);
    }),
    { ...fileAuthoringToolkit.save_file, responseFormat: 'content_and_artifact' },
  ) as DynamicStructuredTool;

  const patchFile = tool(
    guarded(PATCH_FILE_TOOL_NAME, async (input: PatchInput): Promise<ToolOutput> => {
      const files = await deps.listFiles();
      const file = findFile(files, input.filename);
      if (!file) {
        return [
          `No file named "${input.filename}" in this conversation. Files: ${listNames(files)}.`,
          undefined,
        ];
      }
      const content = isTextType(file.type) ? await readContent(file) : null;
      if (content == null) {
        return [
          `"${file.filename}" (${file.type}) is not a text file, so it cannot be edited here. Tell the user the Office Assistant can return an edited copy of this file.`,
          undefined,
        ];
      }
      const patched = applyEdits(content, input.edits);
      if (!patched.ok) {
        return [`Not saved. ${patched.error}`, undefined];
      }
      const filename = editedName({
        source: file.filename,
        requested: input.new_filename,
        taken: takenNames(files),
      });
      return save(filename, patched.content);
    }),
    { ...fileAuthoringToolkit.patch_file, responseFormat: 'content_and_artifact' },
  ) as DynamicStructuredTool;

  return [readAttachment, saveFile, patchFile];
}

/** Creates the one named file tool; throws for a name that is not a file tool. */
export function createFileAuthoringTool(
  toolName: string,
  deps: FileAuthoringDeps,
): DynamicStructuredTool {
  const found = createFileAuthoringTools(deps).find((created) => created.name === toolName);
  if (!found) {
    throw new Error(`Unknown file tool: ${toolName}`);
  }
  return found;
}
