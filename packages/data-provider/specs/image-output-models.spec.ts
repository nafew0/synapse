import { isImageOutputModel, validateVisionModel } from '../src/config';

describe('isImageOutputModel', () => {
  it.each([
    'google/gemini-3.1-flash-image',
    'gemini-2.5-flash-image',
    'gemini-2.5-flash-image-preview',
  ])('recognizes %s as returning images inline', (model) => {
    expect(isImageOutputModel(model)).toBe(true);
  });

  it.each(['openai/gpt-5.6-luna', 'anthropic/claude-3-haiku', 'z-ai/glm-5.2', 'gemini-2.5-pro'])(
    'treats %s as a text model',
    (model) => {
      expect(isImageOutputModel(model)).toBe(false);
    },
  );

  it('returns false when no model is known', () => {
    expect(isImageOutputModel(undefined)).toBe(false);
    expect(isImageOutputModel(null)).toBe(false);
    expect(isImageOutputModel('')).toBe(false);
  });

  it('is independent of vision input — an image model still reads images', () => {
    const model = 'google/gemini-3.1-flash-image';
    expect(isImageOutputModel(model)).toBe(true);
    expect(validateVisionModel({ model })).toBe(true);
  });
});
