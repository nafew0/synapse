const TTL_MS = 60_000;

/**
 * The RAG API holding the knowledge base index. `KB_RAG_API_URL` lets it differ from the one
 * used for file search, e.g. a dev server that shares production's file search.
 */
export const getKbRagApiUrl = (): string | undefined =>
  process.env.KB_RAG_API_URL || process.env.RAG_API_URL || undefined;

const cache = new Map<string, { ready: boolean; expires: number }>();

/**
 * Whether a tenant has a searchable document, cached for a minute: it is asked on every chat
 * turn, and a document that just became ready can wait that long to be offered.
 */
export async function hasInstitutionKb(
  tenantId: string | undefined | null,
  probe: (tenantId: string) => Promise<boolean>,
  now: number = Date.now(),
): Promise<boolean> {
  if (!tenantId) {
    return false;
  }
  const hit = cache.get(tenantId);
  if (hit && hit.expires > now) {
    return hit.ready;
  }
  const ready = await probe(tenantId);
  cache.set(tenantId, { ready, expires: now + TTL_MS });
  return ready;
}

/** Drops a tenant's cached answer, e.g. right after its first document becomes ready. */
export function forgetInstitutionKb(tenantId: string): void {
  cache.delete(tenantId);
}
