import type { ExtendedJsonSchema } from '~/tools/registry/schema';

export const READ_ATTACHMENT_TOOL_NAME = 'read_attachment';
export const SAVE_FILE_TOOL_NAME = 'save_file';
export const PATCH_FILE_TOOL_NAME = 'patch_file';

/** Artifact key a saved file travels under from the tool to the attachment callback. */
export const SAVED_FILE_ARTIFACT_KEY = 'saved_file';

export const fileAuthoringToolNames: ReadonlySet<string> = new Set([
  READ_ATTACHMENT_TOOL_NAME,
  SAVE_FILE_TOOL_NAME,
  PATCH_FILE_TOOL_NAME,
]);

export const isFileAuthoringTool = (toolName: string): boolean =>
  fileAuthoringToolNames.has(toolName);

const filenameProperty: ExtendedJsonSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 255,
  description:
    'The file name exactly as attached or as returned by an earlier save, e.g. "scan.py".',
};

const readAttachmentSchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    filename: filenameProperty,
    start_line: {
      type: 'integer',
      minimum: 1,
      description: 'First line to return, counting from 1. Defaults to 1.',
    },
    end_line: {
      type: 'integer',
      minimum: 1,
      description: 'Last line to return. Defaults to the end of the file, or as much as fits.',
    },
  },
  required: ['filename'],
};

const saveFileSchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    filename: {
      type: 'string',
      minLength: 1,
      maxLength: 255,
      description:
        'Name for the new file, with its extension, e.g. "report.md" or "scan-edited.py". A name already used in this conversation gets a number added.',
    },
    content: {
      type: 'string',
      description: 'The complete file content.',
    },
  },
  required: ['filename', 'content'],
};

const patchFileSchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    filename: filenameProperty,
    edits: {
      type: 'array',
      minItems: 1,
      maxItems: 50,
      description: 'Edits applied in order. Each "old" must match exactly one place in the file.',
      items: {
        type: 'object',
        properties: {
          old: {
            type: 'string',
            minLength: 1,
            description:
              'Exact text to replace, copied from the file with its spaces and indentation. Include enough lines to match one place only.',
          },
          new: { type: 'string', description: 'Replacement text. Empty deletes the old text.' },
        },
        required: ['old', 'new'],
      },
    },
    new_filename: {
      type: 'string',
      maxLength: 255,
      description:
        'Optional name for the edited copy. Defaults to "<name>-edited.<ext>". The original extension is always kept.',
    },
  },
  required: ['filename', 'edits'],
};

interface FileAuthoringToolDefinition {
  name: string;
  description: string;
  schema: ExtendedJsonSchema;
}

export const fileAuthoringToolkit: Record<
  'read_attachment' | 'save_file' | 'patch_file',
  FileAuthoringToolDefinition
> = {
  read_attachment: {
    name: READ_ATTACHMENT_TOOL_NAME,
    description:
      'Reads the exact text of a text or code file attached to this conversation, or of a file you saved earlier, optionally a range of lines. Use it before editing a file, and to read files too long to be included in the message.',
    schema: readAttachmentSchema,
  },
  save_file: {
    name: SAVE_FILE_TOOL_NAME,
    description:
      'Saves text as a new downloadable file and shows it to the user. Use it to create a file, or to return a short file you rewrote completely. To change part of an existing file, use patch_file instead.',
    schema: saveFileSchema,
  },
  patch_file: {
    name: PATCH_FILE_TOOL_NAME,
    description:
      'Edits a text or code file by exact find-and-replace and returns the result as a new downloadable file in the same format, named "<name>-edited.<ext>" unless you choose a name. The original is never changed. Send only the parts that change.',
    schema: patchFileSchema,
  },
};
