import mongoose from 'mongoose';
import { createServer } from 'http';
import { createModels } from '@librechat/data-schemas';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { ServiceMeter } from '~/bdren/meter';
import type { FirecrawlConfig } from './client';
import { SERVICE_REFUSAL } from '~/bdren/meter';
import { createFirecrawlTool } from './tool';

const PRICE = 0.0038;

describe('Firecrawl tool and the allowance meter', () => {
  let mongo: MongoMemoryServer;
  let server: Server;
  let config: FirecrawlConfig;
  let upstream: number;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    createModels(mongoose);
    await mongoose.models.Transaction.init();
    server = createServer((req, res) => {
      upstream += 1;
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            creditsUsed: 2,
            data: { web: [{ url: 'https://e.org', title: 'E', description: 'd' }] },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    config = {
      apiKey: 'fc-test',
      apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      maxChars: 500,
      timeoutMs: 5000,
      maxSearches: 5,
      maxScrapes: 5,
      pdfMaxPages: 3,
    };
  });

  afterAll(async () => {
    await new Promise((done) => server.close(done));
    await mongoose.disconnect();
    await mongo.stop();
  });

  beforeEach(async () => {
    upstream = 0;
    await mongoose.models.Transaction.deleteMany({});
  });

  function meterWith(affordable: boolean) {
    const charges: Array<{ key: string; credits: number; label: string }> = [];
    const asked: number[] = [];
    const meter: ServiceMeter = {
      canAfford: async (credits) => {
        asked.push(credits);
        return affordable;
      },
      charge: async (key, credits, label) => {
        charges.push({ key, credits, label });
      },
    };
    return { meter, charges, asked };
  }

  const toolWith = (meter: ServiceMeter | null) =>
    createFirecrawlTool('search_web', {
      config,
      ledger: {
        user: new mongoose.Types.ObjectId().toString(),
        tenantId: 'du',
        conversationId: 'c1',
        messageId: 'm1',
        pricePerCreditUsd: PRICE,
        meter,
      },
    });

  it('refuses a search the allowance cannot cover, without calling Firecrawl or writing a ledger row', async () => {
    const { meter, charges } = meterWith(false);

    const result = await toolWith(meter).invoke({ query: 'q' });

    expect(result).toBe(SERVICE_REFUSAL);
    expect(upstream).toBe(0);
    expect(charges).toHaveLength(0);
    expect(await mongoose.models.Transaction.countDocuments()).toBe(0);
  });

  it('checks the worst-case price first, then charges what Firecrawl reported once, under the ledger key', async () => {
    const { meter, charges, asked } = meterWith(true);

    await toolWith(meter).invoke({ query: 'q' });

    expect(upstream).toBe(1);
    expect(asked).toEqual([Math.round(2 * PRICE * 1_000_000)]);
    expect(charges).toHaveLength(1);
    expect(charges[0].credits).toBe(Math.round(2 * PRICE * 1_000_000));
    expect(charges[0].label).toBe('web_search');
    const row = await mongoose.models.Transaction.findOne({ service: 'firecrawl' }).lean<{
      requestKey: string;
    }>();
    expect(charges[0].key).toBe(row?.requestKey);
  });

  it('runs unmetered when there is no meter (a user nothing is metered for)', async () => {
    const result = await toolWith(null).invoke({ query: 'q' });
    expect(result).toContain('https://e.org');
    expect(upstream).toBe(1);
  });
});
