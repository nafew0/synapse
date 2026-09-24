// Mock all external dependencies so we can test getFileExtensionFromMime in isolation
jest.mock('axios');
jest.mock('form-data');
jest.mock('https-proxy-agent');
jest.mock('@librechat/data-schemas', () => ({ logger: { warn: jest.fn(), error: jest.fn() } }));
jest.mock('@librechat/api', () => ({
  genAzureEndpoint: jest.fn(),
  logAxiosError: jest.fn(),
  applyAxiosProxyConfig: jest.fn(),
  applySSRFSafeAgentIfDirect: jest.fn(),
  resolveConfigSecret: (value) => value,
}));
jest.mock('librechat-data-provider', () => ({
  extractEnvVariable: jest.fn(),
  STTProviders: { OPENAI: 'openai', AZURE_OPENAI: 'azureOpenAI' },
}));
jest.mock('~/server/services/Config', () => ({ getAppConfig: jest.fn() }));

const axios = require('axios');
const { logger } = require('@librechat/data-schemas');
const { STTService, getFileExtensionFromMime, MIME_TO_EXTENSION_MAP } = require('./STTService');

describe('getFileExtensionFromMime', () => {
  it('should normalize audio/x-m4a to m4a', () => {
    expect(getFileExtensionFromMime('audio/x-m4a')).toBe('m4a');
  });

  it('should normalize audio/mp4 to m4a', () => {
    expect(getFileExtensionFromMime('audio/mp4')).toBe('m4a');
  });

  it('should normalize audio/x-wav to wav', () => {
    expect(getFileExtensionFromMime('audio/x-wav')).toBe('wav');
  });

  it('should normalize audio/x-flac to flac', () => {
    expect(getFileExtensionFromMime('audio/x-flac')).toBe('flac');
  });

  it('should normalize audio/mpeg to mp3', () => {
    expect(getFileExtensionFromMime('audio/mpeg')).toBe('mp3');
  });

  it('should return webm for audio/webm', () => {
    expect(getFileExtensionFromMime('audio/webm')).toBe('webm');
  });

  it('should return ogg for audio/ogg', () => {
    expect(getFileExtensionFromMime('audio/ogg')).toBe('ogg');
  });

  it('should fall back to webm for unknown MIME types', () => {
    expect(getFileExtensionFromMime('audio/somethingelse')).toBe('webm');
  });

  it('should return webm for null/undefined input', () => {
    expect(getFileExtensionFromMime(null)).toBe('webm');
    expect(getFileExtensionFromMime(undefined)).toBe('webm');
  });
});

describe('STTService.getProviderSchema provider detection', () => {
  const service = new STTService();

  const buildReq = (stt) => ({ config: { speech: { stt } } });

  it('resolves exactly one provider when allowedAddresses is set alongside it', async () => {
    const req = buildReq({
      allowedAddresses: ['127.0.0.1:8080'],
      openai: { url: 'http://127.0.0.1:8080', apiKey: 'sk', model: 'whisper-1' },
    });
    const [provider, schema] = await service.getProviderSchema(req);
    expect(provider).toBe('openai');
    expect(schema.url).toBe('http://127.0.0.1:8080');
  });

  it('reports "No provider is set" when only allowedAddresses is present', async () => {
    const req = buildReq({ allowedAddresses: ['127.0.0.1:8080'] });
    await expect(service.getProviderSchema(req)).rejects.toThrow('No provider is set');
  });

  it('reports "Multiple providers" when two providers are set even with allowedAddresses', async () => {
    const req = buildReq({
      allowedAddresses: ['127.0.0.1:8080'],
      openai: { url: 'http://127.0.0.1:8080', apiKey: 'sk', model: 'whisper-1' },
      azureOpenAI: {
        instanceName: 'inst',
        apiKey: 'sk',
        deploymentName: 'dep',
        apiVersion: '2024',
      },
    });
    await expect(service.getProviderSchema(req)).rejects.toThrow('Multiple providers are set');
  });
});

describe('STT audio format validation with MIME normalization', () => {
  const acceptedFormats = ['flac', 'mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'ogg', 'wav', 'webm'];

  /**
   * Mirrors the format validation logic in azureOpenAIProvider.
   * Only uses MIME_TO_EXTENSION_MAP for normalization so unknown audio
   * subtypes are not silently accepted via the webm default fallback.
   * Raw subtype matching is gated on audio/video prefix to prevent
   * non-audio types like text/webm from passing.
   */
  function isFormatAccepted(mimetype) {
    const [mimePrefix, rawFormat = ''] = mimetype.split('/');
    const isAudioMime = mimePrefix === 'audio' || mimePrefix === 'video';
    const isKnownMime = mimetype in MIME_TO_EXTENSION_MAP;
    const normalizedFormat = isKnownMime ? MIME_TO_EXTENSION_MAP[mimetype] : null;
    return (
      acceptedFormats.includes(normalizedFormat) ||
      (isAudioMime && acceptedFormats.includes(rawFormat))
    );
  }

  it('should accept audio/x-m4a (browser MIME for .m4a files)', () => {
    expect(isFormatAccepted('audio/x-m4a')).toBe(true);
  });

  it('should accept audio/x-wav', () => {
    expect(isFormatAccepted('audio/x-wav')).toBe(true);
  });

  it('should accept audio/x-flac', () => {
    expect(isFormatAccepted('audio/x-flac')).toBe(true);
  });

  it('should accept standard formats directly', () => {
    expect(isFormatAccepted('audio/mpeg')).toBe(true);
    expect(isFormatAccepted('audio/wav')).toBe(true);
    expect(isFormatAccepted('audio/ogg')).toBe(true);
    expect(isFormatAccepted('audio/webm')).toBe(true);
    expect(isFormatAccepted('audio/flac')).toBe(true);
    expect(isFormatAccepted('audio/mp3')).toBe(true);
    expect(isFormatAccepted('audio/mp4')).toBe(true);
    expect(isFormatAccepted('audio/mpga')).toBe(true);
  });

  it('should reject unknown audio subtypes', () => {
    expect(isFormatAccepted('audio/aac')).toBe(false);
    expect(isFormatAccepted('audio/somethingelse')).toBe(false);
    expect(isFormatAccepted('video/unknown')).toBe(false);
  });

  it('should accept application/ogg (valid Ogg container MIME type in the map)', () => {
    expect(isFormatAccepted('application/ogg')).toBe(true);
  });

  it('should reject non-audio types even if subtype matches an accepted format', () => {
    expect(isFormatAccepted('text/webm')).toBe(false);
    expect(isFormatAccepted('text/plain')).toBe(false);
    expect(isFormatAccepted('application/json')).toBe(false);
  });
});

describe('STTService.sttRequest language fallback', () => {
  const service = new STTService();
  const schema = { url: 'https://stt.example/v1/audio/transcriptions', apiKey: 'sk', model: 'm' };
  const requestData = (language) => ({
    audioBuffer: Buffer.from('audio'),
    audioFile: { originalname: 'audio.webm', mimetype: 'audio/webm', size: 5 },
    language,
  });
  const rejected = Object.assign(new Error('Request failed with status code 400'), {
    response: { status: 400, data: { error: { message: 'Provider returned 400' } } },
  });
  const sentLanguages = () => axios.post.mock.calls.map(([, data]) => data.language);

  beforeEach(() => jest.clearAllMocks());

  it('retries without the language when the provider rejects it', async () => {
    axios.post
      .mockRejectedValueOnce(rejected)
      .mockResolvedValueOnce({ status: 200, data: { text: ' আমাকে ' } });

    await expect(service.sttRequest('openai', schema, requestData('bn-BD'))).resolves.toBe('আমাকে');
    expect(sentLanguages()).toEqual(['bn', undefined]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('does not retry a 400 when no language was sent', async () => {
    axios.post.mockRejectedValueOnce(rejected);

    await expect(service.sttRequest('openai', schema, requestData(''))).rejects.toBe(rejected);
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  it('sends the configured default language when the user chose none', async () => {
    axios.post.mockResolvedValueOnce({ status: 200, data: { text: 'হ্যাঁ' } });

    await service.sttRequest('openai', { ...schema, language: 'bn' }, requestData(''));
    expect(sentLanguages()).toEqual(['bn']);
  });

  it("prefers the user's language over the configured default", async () => {
    axios.post.mockResolvedValueOnce({ status: 200, data: { text: 'hello' } });

    await service.sttRequest('openai', { ...schema, language: 'bn' }, requestData('en-US'));
    expect(sentLanguages()).toEqual(['en']);
  });

  it('drops a rejected default language on retry', async () => {
    axios.post
      .mockRejectedValueOnce(rejected)
      .mockResolvedValueOnce({ status: 200, data: { text: 'hello' } });

    await service.sttRequest('openai', { ...schema, language: 'bn' }, requestData(''));
    expect(sentLanguages()).toEqual(['bn', undefined]);
  });

  it('does not retry errors other than 400', async () => {
    const serverError = Object.assign(new Error('boom'), { response: { status: 500 } });
    axios.post.mockRejectedValueOnce(serverError);

    await expect(service.sttRequest('openai', schema, requestData('en-US'))).rejects.toBe(
      serverError,
    );
    expect(axios.post).toHaveBeenCalledTimes(1);
  });
});
