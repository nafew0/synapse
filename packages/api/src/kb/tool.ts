import { KbDocTypes } from 'librechat-data-provider';
import { tool } from '@librechat/agents/langchain/tools';
import type { DynamicStructuredTool } from '@librechat/agents/langchain/tools';
import type { ExtendedJsonSchema } from '~/tools/registry/schema';
import { createAxiosInstance } from '~/utils/axios';
import type { KbCatalogItem } from './availability';
import { generateKbToken } from '~/crypto/jwt';

const axios = createAxiosInstance();

export const INSTITUTION_KB_TOOL_NAME = 'institution_kb';
const QUERY_TIMEOUT_MS = 30_000;
const DEFAULT_RESULTS = 8;

const institutionKbSchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      minLength: 1,
      maxLength: 500,
      description:
        'What to look for, in the words the documents are likely to use. Bangla or English; include names, numbers or titles you know.',
    },
    doc_types: {
      type: 'array',
      items: { type: 'string', enum: [...KbDocTypes] },
      description: 'Only search these kinds of document. Leave out to search everything.',
    },
  },
  required: ['query'],
};

export const institutionKbToolDefinition: {
  name: string;
  description: string;
  schema: ExtendedJsonSchema;
} = {
  name: INSTITUTION_KB_TOOL_NAME,
  description:
    "Searches the user's own institution's knowledge base: the policies, circulars, notices, forms, templates, contact lists and reports its administrators uploaded. Call it when the request concerns the institution, its offices, people, rules, figures or formats, including when drafting a letter, email or message to one of its teams, to get exact names, designations, emails and phone numbers. Search it before web search or answering from memory; skip it only for plainly general questions. Use only details found in the results and name the document and page you used; if nothing relevant comes back, say so and leave placeholders such as [NOC email] instead of guessing. When the knowledge base, a web search and a file the user attached disagree, say what each source says.",
  schema: institutionKbSchema,
};

const MAX_LISTED = 40;
const MAX_TITLE = 120;

/** One line per document; titles are admin-written, so they are flattened and shortened. */
const listTitle = ({ title, docType }: KbCatalogItem): string =>
  `- ${title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE)} (${docType})`;

/**
 * System prompt addition for members whose institution has a knowledge base: search it before
 * any other source, and name what it holds so vague questions ("home office") find the right
 * document.
 */
export function buildInstitutionKbInstructions(catalog: KbCatalogItem[]): string {
  const listed = catalog.slice(0, MAX_LISTED).map(listTitle).join('\n');
  const more =
    catalog.length > MAX_LISTED ? `\n- …and ${catalog.length - MAX_LISTED} more documents` : '';
  return `## Institution knowledge base
The user's institution keeps its own documents in a knowledge base, searched with the \`${INSTITUTION_KB_TOOL_NAME}\` tool. It currently holds:
${listed}${more}

Look in the knowledge base first. Unless the request is plainly general knowledge or only about a file the user attached, call \`${INSTITUTION_KB_TOOL_NAME}\` before using web search or answering from memory, including when drafting letters, emails or documents. Read the user's words as being about their own institution: "home office", "leave", "apply for", "our policy" or a team name usually mean the institution's own rules, people and procedures. Search again with other wording (English and Bangla, synonyms such as "work from home") if the first search finds nothing relevant. Only when the knowledge base has nothing relevant, use other sources, and say that the institution's documents did not cover it.`;
}

interface KbResult {
  doc_id: string;
  title: string;
  doc_type: string;
  section_path: string;
  page_start: number | null;
  page_end: number | null;
  text: string;
}

interface KbToolInput {
  query: string;
  doc_types?: string[];
}

const pages = ({ page_start, page_end }: KbResult): string => {
  if (page_start == null) {
    return '';
  }
  return page_end != null && page_end !== page_start
    ? `, pages ${page_start}–${page_end}`
    : `, page ${page_start}`;
};

/** One numbered source per result, so the model can name the document and page it used. */
export function formatKbResults(results: KbResult[]): string {
  if (results.length === 0) {
    return 'Nothing relevant was found in the institution knowledge base.';
  }
  return results
    .map((result, i) => {
      const section = result.section_path ? ` › ${result.section_path}` : '';
      return `[${i + 1}] ${result.title}${section}${pages(result)}\n${result.text}`;
    })
    .join('\n\n');
}

export interface InstitutionKbToolOptions {
  ragApiUrl: string;
  /** Taken from the signed-in user on the server, never from the model. */
  tenantId: string;
  /**
   * Documents that still have a record. Chunks of any other document are leftovers of a
   * delete that did not reach the index, and are never shown to the model.
   */
  knownDocumentIds?: () => Promise<ReadonlySet<string>>;
}

export function createInstitutionKbTool({
  ragApiUrl,
  tenantId,
  knownDocumentIds,
}: InstitutionKbToolOptions): DynamicStructuredTool {
  const url = `${ragApiUrl.replace(/\/+$/, '')}/kb/query`;
  return tool(async ({ query, doc_types }: KbToolInput, runConfig?: { signal?: AbortSignal }) => {
    const { data } = await axios.post<{ results: KbResult[] }>(
      url,
      { query, k: DEFAULT_RESULTS, doc_types: doc_types?.length ? doc_types : undefined },
      {
        headers: { Authorization: `Bearer ${generateKbToken(tenantId)}` },
        timeout: QUERY_TIMEOUT_MS,
        signal: runConfig?.signal,
      },
    );
    const results = data.results ?? [];
    const known = knownDocumentIds ? await knownDocumentIds() : null;
    return formatKbResults(known ? results.filter((r) => known.has(r.doc_id)) : results);
  }, institutionKbToolDefinition) as DynamicStructuredTool;
}
