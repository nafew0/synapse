/**
 * @jest-environment @happy-dom/jest-environment
 */
import http from 'http';
import type { AddressInfo } from 'net';
import { xhrFetch } from './xhr';

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization');
    res.setHeader('Access-Control-Expose-Headers', 'X-Received, X-Auth');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    let received = 0;
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
    });
    req.on('end', () => {
      if (req.url === '/missing') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"message":"Not here"}');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'X-Received': String(received),
        'X-Auth': req.headers.authorization ?? '',
      });
      res.write('event:progress\ndata:{"stage":"reading"}\n\n');
      setTimeout(() => res.end('event:close\ndata:{}\n\n'), 20);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('xhrFetch', () => {
  it('sends the body and headers, then streams the whole response body', async () => {
    const body = 'x'.repeat(256 * 1024);
    const response = await xhrFetch(`${baseUrl}/upload`, {
      method: 'POST',
      body,
      headers: { Authorization: 'Bearer token' },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    expect(response.headers.get('X-Received')).toBe(String(body.length));
    expect(response.headers.get('X-Auth')).toBe('Bearer token');
    await expect(response.text()).resolves.toBe(
      'event:progress\ndata:{"stage":"reading"}\n\nevent:close\ndata:{}\n\n',
    );
  });

  it('resolves error statuses as responses, like fetch', async () => {
    const response = await xhrFetch(`${baseUrl}/missing`, { method: 'POST', body: 'x' });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ message: 'Not here' });
  });

  it('rejects with an AbortError when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      xhrFetch(`${baseUrl}/upload`, { method: 'POST', body: 'x', signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
