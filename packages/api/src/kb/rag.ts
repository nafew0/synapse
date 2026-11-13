import type { KbChunk } from './types';
import { createAxiosInstance } from '~/utils/axios';
import { generateKbToken } from '~/crypto/jwt';

const axios = createAxiosInstance();

const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
/** Chunks per request: one embedding call each, kept well under provider batch limits. */
export const KB_UPLOAD_BATCH = 64;

export interface KbIndexTarget {
  tenantId: string;
  documentId: string;
  version: number;
}

export interface KbIndexUpload extends KbIndexTarget {
  title: string;
  docType: string;
  chunks: KbChunk[];
}

export interface KbIndexClient {
  /** Embeds and stores a version's chunks without making them searchable yet. */
  upload(input: KbIndexUpload): Promise<void>;
  /** Makes this version the searchable one and drops every other version's chunks. */
  activate(target: KbIndexTarget): Promise<void>;
  remove(target: Omit<KbIndexTarget, 'version'>): Promise<void>;
}

const toPayload = (chunk: KbChunk) => ({
  chunk_index: chunk.index,
  kind: chunk.kind,
  section_path: chunk.sectionPath,
  page_start: chunk.pageStart,
  page_end: chunk.pageEnd,
  text: chunk.text,
  embed_text: chunk.embedText,
});

/** Calls the RAG API's `/kb` routes with a token that names the tenant. */
export function createKbIndexClient(baseUrl: string): KbIndexClient {
  const base = baseUrl.replace(/\/+$/, '');
  const auth = (tenantId: string) => ({
    headers: { Authorization: `Bearer ${generateKbToken(tenantId)}` },
    timeout: REQUEST_TIMEOUT_MS,
  });

  const upload = async ({
    tenantId,
    documentId,
    version,
    title,
    docType,
    chunks,
  }: KbIndexUpload) => {
    for (let start = 0; start < chunks.length; start += KB_UPLOAD_BATCH) {
      await axios.post(
        `${base}/kb/chunks`,
        {
          doc_id: documentId,
          version,
          title,
          doc_type: docType,
          chunks: chunks.slice(start, start + KB_UPLOAD_BATCH).map(toPayload),
        },
        auth(tenantId),
      );
    }
  };

  const activate = async ({ tenantId, documentId, version }: KbIndexTarget) => {
    await axios.post(`${base}/kb/activate`, { doc_id: documentId, version }, auth(tenantId));
  };

  const remove = async ({ tenantId, documentId }: Omit<KbIndexTarget, 'version'>) => {
    await axios.delete(`${base}/kb/documents/${encodeURIComponent(documentId)}`, auth(tenantId));
  };

  return { upload, activate, remove };
}
