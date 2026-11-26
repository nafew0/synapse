import sharp from 'sharp';
import { HARD_MAX_TOOL_RESULT_CHARS } from '@librechat/agents';

/**
 * The images read in one model turn share one {@link HARD_MAX_TOOL_RESULT_CHARS} budget (the
 * patched SDK projects them with twice that, and keeps half for images), and every image past
 * the total is dropped. A quarter each lets a turn read four images, such as a grid and two crops.
 * The configured `maxToolResultChars` caps tool text only, not these images.
 */
const MAX_IMAGE_BASE64_CHARS = Math.floor(HARD_MAX_TOOL_RESULT_CHARS / 4);

/** Vision providers downsample past this edge, so larger renders buy no detail. */
const MAX_IMAGE_EDGE = 1568;

const JPEG_STEPS: ReadonlyArray<{ edge: number; quality: number }> = [
  { edge: MAX_IMAGE_EDGE, quality: 80 },
  { edge: 1200, quality: 70 },
  { edge: 1000, quality: 60 },
  { edge: 800, quality: 55 },
];

export interface ModelImage {
  base64: string;
  mimeType: string;
  bytes: number;
}

/**
 * Returns an image small enough for the model to see. The agents SDK drops tool results over
 * {@link HARD_MAX_TOOL_RESULT_CHARS}, so a 435 KB scan (580K base64 chars) reached the model as
 * "[omitted 1 oversized atomic tool-content block: image_url]", and so did three 200% crops read
 * in one turn. Images under the per-image budget pass through untouched; larger ones are
 * re-encoded as JPEG on white, shrinking until they fit. Returns null when even the smallest step
 * is too large.
 */
export async function fitImageForModel(
  buffer: Buffer,
  mimeType: string,
): Promise<ModelImage | null> {
  const base64 = buffer.toString('base64');
  if (base64.length <= MAX_IMAGE_BASE64_CHARS) {
    return { base64, mimeType, bytes: buffer.length };
  }

  for (const { edge, quality } of JPEG_STEPS) {
    const jpeg = await sharp(buffer)
      .rotate()
      .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality })
      .toBuffer();
    const encoded = jpeg.toString('base64');
    if (encoded.length <= MAX_IMAGE_BASE64_CHARS) {
      return { base64: encoded, mimeType: 'image/jpeg', bytes: jpeg.length };
    }
  }
  return null;
}
