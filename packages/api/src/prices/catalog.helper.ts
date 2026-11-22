import { createServer } from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import embeddings from './fixtures/embeddings.json';
import models from './fixtures/models.json';

export type CatalogBody = { data: Array<Record<string, unknown>> };
export type CatalogMode = 'ok' | 'error' | 'garbage' | 'hang';

export interface CatalogServer {
  baseUrl: string;
  hits: string[];
  mode: CatalogMode;
  chat: CatalogBody;
  embeddings: CatalogBody;
  close: () => Promise<void>;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** A real local HTTP server standing in for OpenRouter's two catalog endpoints. */
export async function startCatalogServer(): Promise<CatalogServer> {
  const state = {
    hits: [] as string[],
    mode: 'ok' as CatalogMode,
    chat: clone(models) as CatalogBody,
    embeddings: clone(embeddings) as CatalogBody,
  };
  const sockets = new Set<import('net').Socket>();
  const server: Server = createServer((req, res) => {
    state.hits.push(req.url ?? '');
    if (state.mode === 'hang') {
      return;
    }
    if (state.mode === 'error') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":"boom"}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (state.mode === 'garbage') {
      res.end('{"data":"not a list"}');
      return;
    }
    res.end(
      JSON.stringify(req.url?.endsWith('/embeddings/models') ? state.embeddings : state.chat),
    );
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return Object.defineProperties(
    { baseUrl, close: async () => closeServer(server, sockets) } as CatalogServer,
    {
      hits: { get: () => state.hits },
      mode: { get: () => state.mode, set: (value: CatalogMode) => void (state.mode = value) },
      chat: { get: () => state.chat, set: (value: CatalogBody) => void (state.chat = value) },
      embeddings: {
        get: () => state.embeddings,
        set: (value: CatalogBody) => void (state.embeddings = value),
      },
    },
  );
}

function closeServer(server: Server, sockets: Set<import('net').Socket>): Promise<void> {
  sockets.forEach((socket) => socket.destroy());
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Sets one chat model's per-token prompt/completion price strings in a catalog body. */
export function setChatPrice(
  body: CatalogBody,
  id: string,
  pricing: { prompt?: string; completion?: string },
): void {
  const model = body.data.find((m) => m.id === id) as { pricing: Record<string, string> };
  Object.assign(model.pricing, pricing);
}

export const fixtureChat = (): CatalogBody => clone(models) as CatalogBody;
export const fixtureEmbeddings = (): CatalogBody => clone(embeddings) as CatalogBody;
