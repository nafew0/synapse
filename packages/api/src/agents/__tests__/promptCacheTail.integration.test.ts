import { z } from 'zod';
import { tool } from '@langchain/core/tools';
import { Run, Providers } from '@librechat/agents';
import { HumanMessage } from '@langchain/core/messages';

interface CacheControl {
  type: string;
}
interface WireBlock {
  type?: string;
  cache_control?: CacheControl;
}
interface WireMessage {
  role: string;
  content?: string | WireBlock[] | null;
  cache_control?: CacheControl;
}
interface WireTool {
  cache_control?: CacheControl;
}
interface WireBody {
  messages: WireMessage[];
  tools?: WireTool[];
}

const DYNAMIC_TAIL = 'Today is a test day.';
const encoder = new TextEncoder();

function sseResponse(events: object[]): Response {
  chunkSeq += 1;
  const payload = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(payload));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

let chunkSeq = 0;
function chunk(delta: object, finish: string | null = null): object {
  return {
    id: `gen-${chunkSeq}`,
    object: 'chat.completion.chunk',
    created: 1,
    model: 'anthropic/claude-sonnet-4.5',
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}),
  };
}

function toolCallResponse(callId: string): Response {
  return sseResponse([
    chunk({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          index: 0,
          id: callId,
          type: 'function',
          function: { name: 'lookup', arguments: JSON.stringify({ query: `q-${callId}` }) },
        },
      ],
    }),
    chunk({}, 'tool_calls'),
  ]);
}

function textResponse(): Response {
  return sseResponse([chunk({ role: 'assistant', content: 'done' }), chunk({}, 'stop')]);
}

const countBlockMarkers = (message: WireMessage): number => {
  const own = message.cache_control != null ? 1 : 0;
  if (!Array.isArray(message.content)) {
    return own;
  }
  return own + message.content.filter((b) => b.cache_control != null).length;
};

const countMarkers = (body: WireBody): number =>
  body.messages.reduce((sum, m) => sum + countBlockMarkers(m), 0) +
  (body.tools ?? []).filter((t) => t.cache_control != null).length;

const hasMarker = (message: WireMessage): boolean => countBlockMarkers(message) > 0;

async function runThreeSteps(promptCache: boolean): Promise<WireBody[]> {
  const bodies: WireBody[] = [];
  const responses = [toolCallResponse('call_1'), toolCallResponse('call_2'), textResponse()];
  const fetchMock = jest.fn(async (_url: unknown, init?: { body?: unknown }) => {
    bodies.push(JSON.parse(String(init?.body)) as WireBody);
    return responses[bodies.length - 1];
  });

  const lookup = tool(async () => 'result '.repeat(50), {
    name: 'lookup',
    description: 'Look something up',
    schema: z.object({ query: z.string() }),
  });

  const run = await Run.create({
    runId: 'cache-tail-test',
    graphConfig: {
      type: 'standard',
      llmConfig: {
        provider: Providers.OPENROUTER,
        model: 'anthropic/claude-sonnet-4.5',
        apiKey: 'test-key',
        streaming: true,
        promptCache,
        configuration: {
          baseURL: 'http://openrouter.invalid/api/v1',
          fetch: fetchMock as unknown as typeof fetch,
        },
      },
      tools: [lookup],
      instructions: 'You are a careful assistant. '.repeat(40),
      additional_instructions: DYNAMIC_TAIL,
    },
    returnContent: true,
  });

  await run.processStream(
    { messages: [new HumanMessage('Edit the document please')] },
    { configurable: { thread_id: 'cache-tail-thread' }, streamMode: 'values', version: 'v2' },
  );
  return bodies;
}

describe('OpenRouter prompt cache markers across a multi-step turn', () => {
  it('marks the newest message at every step and keeps system/tool markers', async () => {
    const bodies = await runThreeSteps(true);
    expect(bodies).toHaveLength(3);

    bodies.forEach((body, step) => {
      expect(countMarkers(body)).toBeLessThanOrEqual(4);
      const tailMessage = body.messages.find((m) => m.content === DYNAMIC_TAIL);
      expect(tailMessage).toBeDefined();
      expect(hasMarker(tailMessage as WireMessage)).toBe(false);
      if (step === 0) {
        return;
      }
      const newest = body.messages[body.messages.length - 1];
      expect(newest.role).toBe('tool');
      expect(hasMarker(newest)).toBe(true);
    });

    const systemMarkers = bodies.map((b) => countBlockMarkers(b.messages[0]));
    expect(new Set(systemMarkers).size).toBe(1);
    expect(systemMarkers[0]).toBeGreaterThan(0);

    const toolMarkers = bodies.map((b) => (b.tools ?? []).filter((t) => t.cache_control).length);
    expect(new Set(toolMarkers).size).toBe(1);
  });

  it('adds no markers when prompt cache is off', async () => {
    const bodies = await runThreeSteps(false);
    expect(bodies).toHaveLength(3);
    for (const body of bodies) {
      expect(countMarkers(body)).toBe(0);
    }
  });
});
