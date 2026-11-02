import { createHash } from 'crypto';
import { logger } from '@librechat/data-schemas';
import { tool } from '@librechat/agents/langchain/tools';
import { defaultAutoPreparation, extractEnvVariable } from 'librechat-data-provider';
import type { DynamicStructuredTool } from '@librechat/agents/langchain/tools';
import type { TDocumentOcrConfig } from 'librechat-data-provider';
import type { UnstructuredClient } from './client';
import type { UnstructuredClientOptions, UnstructuredElement } from './types';
import { READ_DOCUMENT_TOOL_NAME, documentReadToolDefinition } from './definitions';
import { elementsToMarkdown, mergePages } from './merge';
import { readPdfPages } from '../scan/read';
import { subsetPdf } from './pages';

/** Most characters returned to the model; the full text is in the sandbox file. */
export const MAX_RETURN_CHARS: number = 60_000;

const IMAGE_TYPES = /^image\/(jpeg|png|tiff|bmp|heic)$/;

export interface DocumentFile {
  file_id: string;
  filename: string;
  type: string;
  updatedAt?: Date | string;
}

export interface SandboxFileRef {
  id: string;
  name: string;
  storage_session_id: string;
  kind: 'user';
}

/** A finished read, kept so that later requests on the same file are not charged again. */
export interface DocumentReading {
  elements: UnstructuredElement[];
  pagesRead: number[];
  pagesSkipped: number[];
}

export interface DocumentReadDeps {
  client: UnstructuredClient;
  maxPages: number;
  /** Files the current user may use in this conversation. Must never return another user's file. */
  listFiles: () => Promise<DocumentFile[]>;
  readBytes: (file: DocumentFile) => Promise<Buffer | null>;
  getCached: (key: string) => Promise<DocumentReading | undefined>;
  setCached: (key: string, reading: DocumentReading) => Promise<void>;
  uploadToSandbox: (name: string, content: string) => Promise<SandboxFileRef>;
}

type ToolOutput = [string, { session_id: string; files: SandboxFileRef[] } | undefined];

/** Whether this assistant, for this institution, may send documents out. Denies unless both are listed. */
export function isDocumentOcrAllowed({
  config,
  tenantId,
  agentId,
}: {
  config?: Partial<TDocumentOcrConfig>;
  tenantId?: string;
  agentId?: string;
}): boolean {
  if (!config?.apiUrl || !config.apiKey || !agentId || !tenantId) {
    return false;
  }
  return (
    config.agents?.includes(agentId) === true && config.enabledTenants?.includes(tenantId) === true
  );
}

export const resolveDocumentOcrClientOptions = (
  config: TDocumentOcrConfig,
): UnstructuredClientOptions => ({
  apiUrl: extractEnvVariable(config.apiUrl),
  apiKey: extractEnvVariable(config.apiKey),
  profile: config.profile,
  concurrency: config.concurrency,
});

interface ClassifiedFile {
  file_id?: string;
  filename?: string;
  metadata?: { preparation?: { scan?: { ocrPages?: number[]; garbledPages?: number[] } } } | null;
}

/**
 * Tells the assistant which attached files the upload's classifier found need OCR. Without this it
 * cannot know a PDF is a scan, and searches it first (seen in a real run).
 */
export function buildDocumentReadContext(files: ClassifiedFile[]): string | undefined {
  const seen = new Set<string | undefined>();
  const lines: string[] = [];
  const digital: string[] = [];
  for (const file of files) {
    const scan = file.metadata?.preparation?.scan;
    const pages = scan?.ocrPages;
    if (!pages?.length || seen.has(file.file_id)) {
      continue;
    }
    seen.add(file.file_id);
    lines.push(`- "${file.filename}": pages ${describeRange(pages)}`);
    if (scan?.garbledPages?.length === pages.length) {
      digital.push(`"${file.filename}"`);
    }
  }
  if (lines.length === 0) {
    return undefined;
  }
  const reading = `These attached files are scanned or have damaged text on these pages, so file_search and pdftotext cannot read them:\n${lines.join('\n')}\nWhen the user wants anything done with one of them, call read_document on it first, before file_search or any skill.`;
  if (digital.length === 0) {
    return reading;
  }
  return `${reading}\nException: ${digital.join(', ')} are digital PDFs, not scans. To turn one into Word, use the pdf-to-docx skill without read_document: it repairs the text for free and keeps the original pictures. If its gate fails on the text, do not ask the user: call read_document and follow its note.`;
}

/** Sandbox names are ASCII and short: a long Bangla file name once broke every sandbox run. */
const sandboxBase = (file: DocumentFile): string => `document-${file.file_id.slice(0, 8)}`;

/** A PDF whose text was extracted at upload is recorded as text/plain; its stored bytes are the PDF. */
const isPdf = (file: DocumentFile): boolean =>
  file.type === 'application/pdf' || /\.pdf$/i.test(file.filename);

const describeRange = (pages: number[]): string => pages.join(', ');

async function readDocument(
  file: DocumentFile,
  buffer: Buffer,
  deps: Pick<DocumentReadDeps, 'client' | 'maxPages'>,
): Promise<DocumentReading> {
  if (IMAGE_TYPES.test(file.type)) {
    const ocrElements = await deps.client.partition({
      buffer,
      filename: file.filename,
      type: file.type,
    });
    return {
      elements: mergePages({ ocrElements, ocrPages: [1], texts: [] }),
      pagesRead: [1],
      pagesSkipped: [],
    };
  }

  const { texts, kinds } = await readPdfPages(
    new Uint8Array(buffer),
    defaultAutoPreparation.ocrMinCharsPerPage,
  );
  const needed = kinds.flatMap((kind, index) => (kind === 'text' ? [] : [index + 1]));
  const pagesRead = needed.slice(0, deps.maxPages);
  const pagesSkipped = needed.slice(deps.maxPages);
  const ocrElements =
    pagesRead.length > 0
      ? await deps.client.partition({
          buffer: await subsetPdf(buffer, pagesRead),
          filename: `${sandboxBase(file)}.pdf`,
          type: 'application/pdf',
        })
      : [];
  /* A skipped page's parser text is damaged or empty, so it is left out rather than passed on. */
  const usable = texts.map((text, index) => (pagesSkipped.includes(index + 1) ? '' : text));
  return {
    elements: mergePages({ ocrElements, ocrPages: pagesRead, texts: usable }),
    pagesRead,
    pagesSkipped,
  };
}

/**
 * Creates the Office Assistant's document reader. A failure comes back as a message saying what to
 * do instead, so the assistant falls back to its sandbox recipe rather than failing the turn.
 */
export function createDocumentReadTool(deps: DocumentReadDeps): DynamicStructuredTool {
  const run = async (
    { filename }: { filename: string },
    config?: { toolCall?: { session_id?: string } },
  ): Promise<ToolOutput> => {
    const fallback =
      'Follow your sandbox recipe for scans instead, and tell the user the page text may need checking.';
    try {
      const files = await deps.listFiles();
      const wanted = filename.trim().toLowerCase();
      const file = files.find((candidate) => candidate.filename.toLowerCase() === wanted);
      if (!file) {
        const names = files.map((candidate) => `"${candidate.filename}"`).join(', ') || 'none';
        return [`No file named "${filename}" in this conversation. Files: ${names}.`, undefined];
      }
      if (!isPdf(file) && !IMAGE_TYPES.test(file.type)) {
        return [
          `"${file.filename}" is not a PDF or an image, so this tool cannot read it.`,
          undefined,
        ];
      }
      const buffer = await deps.readBytes(file);
      if (!buffer) {
        return [`The stored copy of "${file.filename}" could not be read. ${fallback}`, undefined];
      }

      const key = createHash('sha256').update(buffer).digest('hex');
      const cached = await deps.getCached(key);
      const reading = cached ?? (await readDocument(file, buffer, deps));
      if (!cached) {
        await deps.setCached(key, reading);
      }

      const markdown = elementsToMarkdown(reading.elements);
      const base = sandboxBase(file);
      const [elementsRef, markdownRef] = await Promise.all([
        deps.uploadToSandbox(`${base}.elements.json`, JSON.stringify(reading.elements)),
        deps.uploadToSandbox(`${base}.md`, markdown),
      ]);

      const notes = [
        `Read "${file.filename}". Saved as /mnt/data/${elementsRef.name} and /mnt/data/${markdownRef.name} for this request only; on a later request call read_document again, which is free. For Word, load the docx skill and run: cd /mnt/data && python3 /mnt/data/skills/docx/scripts/scan_to_docx.py ${elementsRef.name} <source file> /mnt/data/<name>.docx`,
      ];
      if (reading.pagesSkipped.length > 0) {
        notes.push(
          `Pages ${describeRange(reading.pagesSkipped)} were NOT read: only ${deps.maxPages} pages are read per document. Tell the user.`,
        );
      }
      if (markdown.length > MAX_RETURN_CHARS) {
        notes.push(`Text cut at ${MAX_RETURN_CHARS} characters; the rest is in the .md file.`);
      }
      return [
        `${notes.join('\n')}\n\n${markdown.slice(0, MAX_RETURN_CHARS)}`,
        {
          session_id: config?.toolCall?.session_id || elementsRef.storage_session_id,
          files: [elementsRef, markdownRef],
        },
      ];
    } catch (error) {
      logger.error('[read_document] failed', error);
      return [`Could not read "${filename}" with this tool. ${fallback}`, undefined];
    }
  };
  return tool(
    run as never,
    {
      name: READ_DOCUMENT_TOOL_NAME,
      description: documentReadToolDefinition.description,
      schema: documentReadToolDefinition.schema,
      responseFormat: 'content_and_artifact',
    } as never,
  ) as unknown as DynamicStructuredTool;
}
