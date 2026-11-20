const TTL_MS = 60_000;

/**
 * The RAG API holding the knowledge base index. `KB_RAG_API_URL` lets it differ from the one
 * used for file search, e.g. a dev server that shares production's file search.
 */
export const getKbRagApiUrl = (): string | undefined =>
  process.env.KB_RAG_API_URL || process.env.RAG_API_URL || undefined;

export interface KbCatalogItem {
  id: string;
  title: string;
  docType: string;
}

const cache = new Map<string, { catalog: KbCatalogItem[]; expires: number }>();

/**
 * A tenant's searchable documents, cached for a minute: read on every chat turn, and a document
 * that just became ready can wait that long to be offered. Empty means no knowledge base.
 */
export async function getInstitutionKbCatalog(
  tenantId: string | undefined | null,
  load: (tenantId: string) => Promise<KbCatalogItem[]>,
  now: number = Date.now(),
): Promise<KbCatalogItem[]> {
  if (!tenantId) {
    return [];
  }
  const hit = cache.get(tenantId);
  if (hit && hit.expires > now) {
    return hit.catalog;
  }
  const catalog = await load(tenantId);
  cache.set(tenantId, { catalog, expires: now + TTL_MS });
  return catalog;
}

/** Drops a tenant's cached catalog, e.g. right after a document becomes ready or is deleted. */
export function forgetInstitutionKb(tenantId: string): void {
  cache.delete(tenantId);
}
