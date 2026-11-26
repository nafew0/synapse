import fs from 'fs';
import sharp from 'sharp';
import { ToolMessage, AIMessage, HumanMessage } from '@langchain/core/messages';
import { HARD_MAX_TOOL_RESULT_CHARS, projectArtifactPayload } from '@librechat/agents';
import type { BaseMessage } from '@langchain/core/messages';
import { fitImageForModel } from './vision';

const CONFIGURED_TOOL_RESULT_CHARS = 25000;
const PATCHED_ARTIFACT_PAYLOAD_CHARS = HARD_MAX_TOOL_RESULT_CHARS * 2;

/** A noisy page-sized render compresses like a real scan, so it lands near the per-image cap. */
async function scanLikeImage(seed: number): Promise<Buffer> {
  const width = 1700;
  const height = 2200;
  const pixels = Buffer.alloc(width * height * 3);
  let state = seed;
  for (let i = 0; i < pixels.length; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    pixels[i] = state % 256;
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 90 })
    .toBuffer();
}

async function readFileTurn(count: number): Promise<BaseMessage[]> {
  const ids = Array.from({ length: count }, (_, i) => `call_${i}`);
  const messages: BaseMessage[] = [
    new HumanMessage('Convert this scan to Word'),
    new AIMessage({
      content: '',
      tool_calls: ids.map((id, i) => ({ id, name: 'read_file', args: { path: `qa/${i}.jpg` } })),
    }),
  ];
  for (let i = 0; i < count; i++) {
    const fitted = await fitImageForModel(await scanLikeImage(i + 1), 'image/jpeg');
    if (fitted == null) {
      throw new Error('image did not fit');
    }
    messages.push(
      new ToolMessage({
        tool_call_id: ids[i],
        name: 'read_file',
        content: `Image: qa/${i}.jpg`,
        artifact: {
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:${fitted.mimeType};base64,${fitted.base64}` },
            },
          ],
        },
      }),
    );
  }
  return messages;
}

function imagesSentToModel(projected: BaseMessage[]): { images: number; text: string } {
  const last = projected[projected.length - 1];
  const blocks = Array.isArray(last.content) ? last.content : [];
  const images = blocks.filter((b) => typeof b === 'object' && b.type === 'image_url').length;
  const text = blocks
    .map((b) => (typeof b === 'object' && b.type === 'text' ? String(b.text) : ''))
    .join('\n');
  return { images, text };
}

describe('images read from the sandbox reach the model', () => {
  it('fits a page-sized scan under a quarter of the hard cap', async () => {
    const fitted = await fitImageForModel(await scanLikeImage(7), 'image/jpeg');
    expect(fitted).not.toBeNull();
    expect(fitted!.base64.length).toBeLessThanOrEqual(HARD_MAX_TOOL_RESULT_CHARS / 4);
  });

  it('drops every image under the configured tool-result cap (the dev failure)', async () => {
    const projected = projectArtifactPayload(await readFileTurn(3), CONFIGURED_TOOL_RESULT_CHARS);
    const { images, text } = imagesSentToModel(projected);
    expect(images).toBe(0);
    expect(text).toContain('oversized atomic tool-content block');
  });

  it('keeps four images read in one turn under the patched artifact budget', async () => {
    const projected = projectArtifactPayload(await readFileTurn(4), PATCHED_ARTIFACT_PAYLOAD_CHARS);
    const { images, text } = imagesSentToModel(projected);
    expect(images).toBe(4);
    expect(JSON.stringify(projected[projected.length - 1].content).length).toBeGreaterThan(
      HARD_MAX_TOOL_RESULT_CHARS / 2,
    );
    expect(text).not.toContain('oversized atomic');
  });

  it.each(['cjs/graphs/Graph.cjs', 'esm/graphs/Graph.mjs'])(
    'installed SDK %s projects images with the patched budget',
    (file) => {
      const main = require.resolve('@librechat/agents');
      const dist = main.slice(0, main.lastIndexOf('/dist/') + '/dist/'.length);
      const source = fs.readFileSync(`${dist}${file}`, 'utf8');
      expect(source).toContain('HARD_MAX_TOOL_RESULT_CHARS * 2');
      expect(source).toContain('projectArtifactPayload(finalMessages, maxArtifactPayloadChars)');
    },
  );
});
