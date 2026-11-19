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

/** A page of dark text lines on white, the shape of a scanned office order. */
async function textPage(width: number, height: number): Promise<Buffer> {
  const lines = Array.from(
    { length: 60 },
    (_, i) =>
      `<text x="80" y="${120 + i * 44}" font-size="30" fill="#111">Line ${i} of the office order, memo 32/06 and copy list ${i * 7}</text>`,
  ).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#fdfdf8"/>${lines}</svg>`;
  const page = await sharp(Buffer.from(svg)).png().toBuffer();
  const grain = await noisyPng(width, height);
  return sharp(page)
    .composite([{ input: grain, blend: 'multiply' }])
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

  it('shrinks a large page scan until three fit in one turn under the tool-result cap', async () => {
    const png = await textPage(2000, 2828);
    expect(png.toString('base64').length).toBeGreaterThan(HARD_MAX_TOOL_RESULT_CHARS / 4);

    const image = await fitImageForModel(png, 'image/png');

    expect(image?.mimeType).toBe('image/jpeg');
    expect(image?.base64.length).toBeLessThanOrEqual(HARD_MAX_TOOL_RESULT_CHARS / 4);
    const meta = await sharp(Buffer.from(image?.base64 ?? '', 'base64')).metadata();
    expect(meta.format).toBe('jpeg');
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(1568);
  });

  it('gives up on an image that cannot be compressed under the budget', async () => {
    const png = await noisyPng(1600, 1600);

    await expect(fitImageForModel(png, 'image/png')).resolves.toBeNull();
  });
});
