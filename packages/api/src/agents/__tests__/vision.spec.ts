import sharp from 'sharp';
import { HARD_MAX_TOOL_RESULT_CHARS } from '@librechat/agents';
import { fitImageForModel } from '../vision';

/** Random pixels compress badly, so this stands in for a large scan. */
async function noisyPng(width: number, height: number): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i++) {
    raw[i] = Math.floor(Math.random() * 256);
  }
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

describe('fitImageForModel', () => {
  it('passes a small image through untouched', async () => {
    const png = await sharp({
      create: { width: 40, height: 40, channels: 3, background: '#ffffff' },
    })
      .png()
      .toBuffer();

    const image = await fitImageForModel(png, 'image/png');

    expect(image).toEqual({
      base64: png.toString('base64'),
      mimeType: 'image/png',
      bytes: png.length,
    });
  });

  it('shrinks an image the SDK would drop until it fits the tool-result cap', async () => {
    const png = await noisyPng(768, 1086);
    expect(png.toString('base64').length).toBeGreaterThan(HARD_MAX_TOOL_RESULT_CHARS);

    const image = await fitImageForModel(png, 'image/png');

    expect(image?.mimeType).toBe('image/jpeg');
    expect(image?.base64.length).toBeLessThan(HARD_MAX_TOOL_RESULT_CHARS);
    const meta = await sharp(Buffer.from(image?.base64 ?? '', 'base64')).metadata();
    expect(meta.format).toBe('jpeg');
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(1568);
  });
});
