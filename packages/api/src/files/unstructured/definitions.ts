import type { ExtendedJsonSchema } from '~/tools/registry/schema';

export const READ_DOCUMENT_TOOL_NAME = 'read_document';

const schema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    filename: {
      type: 'string',
      minLength: 1,
      maxLength: 255,
      description: 'The file name exactly as attached, e.g. "order.pdf".',
    },
  },
  required: ['filename'],
};

export const documentReadToolDefinition: {
  name: string;
  description: string;
  schema: ExtendedJsonSchema;
} = {
  name: READ_DOCUMENT_TOOL_NAME,
  description:
    'Reads a scanned or photographed document, or a PDF whose text is damaged, with its headings, lists and tables. Use it first whenever the user wants anything done with such a file: answering from it, editing it, or converting it. Returns the text and saves <name>.elements.json and <name>.md in /mnt/data for this request. Calling it again for the same file is free and restores those files.',
  schema,
};
