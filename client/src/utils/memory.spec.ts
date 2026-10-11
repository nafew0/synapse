import type { TranslationKeys } from '~/hooks/useLocalize';
import { getMemoryApiErrorMessage } from './memory';

const localize = (key: TranslationKeys): string => `localized:${key}`;

const apiError = (status: number, error: string) =>
  Object.assign(new Error('Request failed'), {
    response: { status, data: { error }, headers: {} },
  });

describe('getMemoryApiErrorMessage', () => {
  it('maps a duplicate key conflict to the localized key-exists message', () => {
    expect(
      getMemoryApiErrorMessage(apiError(409, 'Memory with this key already exists.'), localize),
    ).toBe('localized:com_ui_memory_key_exists');
  });

  it('maps validation failures to a localized message instead of the server text', () => {
    const message = getMemoryApiErrorMessage(
      apiError(
        400,
        'Value exceeds maximum length of 10000 characters. Current length: 12000 characters.',
      ),
      localize,
    );
    expect(message).toBe('localized:com_ui_memory_invalid');
    expect(message).not.toContain('characters');
  });

  it('never surfaces raw server errors', () => {
    const message = getMemoryApiErrorMessage(
      apiError(500, 'MongoServerError: E11000 duplicate key'),
      localize,
    );
    expect(message).toBe('localized:com_ui_memory_save_error');
  });

  it('falls back when there is no response', () => {
    expect(getMemoryApiErrorMessage(new Error('Request failed'), localize)).toBe(
      'localized:com_ui_memory_save_error',
    );
  });
});
