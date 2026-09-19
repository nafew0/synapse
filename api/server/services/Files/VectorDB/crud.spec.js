const fs = require('fs');
const axios = require('axios');

jest.mock('axios');
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  createReadStream: jest.fn(() => 'stream'),
}));

const { uploadVectors } = require('./crud');

describe('uploadVectors', () => {
  const req = { user: { id: 'user-1' } };

  beforeAll(() => {
    process.env.RAG_API_URL = 'http://rag.test';
    process.env.JWT_SECRET = 'secret';
  });

  beforeEach(() => {
    jest.clearAllMocks();
    axios.post.mockResolvedValue({ data: { status: true, known_type: true } });
  });

  /**
   * `processAgentFileUpload` and `processFileUpload` both overwrite the storage strategy's
   * sanitized filename with whatever comes back from here, so a raw `originalname` becomes the
   * record's filename — spelled differently from the sandbox copy, which is uploaded under
   * `sanitizeFilename(originalname)`. The model is then handed `/mnt/data/<spaced name>` for a
   * file mounted under the underscored one, and the sandbox's echo of that input arrives as a
   * second ref for one stored object, which codeapi rejects as conflicting destinations.
   */
  it('returns the sanitized filename, not the raw one', async () => {
    const result = await uploadVectors({
      req,
      file_id: 'file-1',
      file: {
        path: '/tmp/upload',
        size: 1024,
        originalname: '527. Dr. Md. Tarikat Islam- Office Order.pdf',
      },
    });

    expect(result.filename).toBe('527._Dr._Md._Tarikat_Islam-_Office_Order.pdf');
    expect(fs.createReadStream).toHaveBeenCalledWith('/tmp/upload');
  });

  it('leaves an already-safe filename alone', async () => {
    const result = await uploadVectors({
      req,
      file_id: 'file-2',
      file: { path: '/tmp/upload', size: 12, originalname: 'notes.txt' },
    });

    expect(result.filename).toBe('notes.txt');
  });
});
