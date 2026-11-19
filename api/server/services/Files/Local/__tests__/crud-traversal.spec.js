jest.mock('@librechat/api', () => ({ deleteRagFile: jest.fn() }));
jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), error: jest.fn() },
}));

const mockTmpBase = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'crud-traversal-'),
);

jest.mock('~/config/paths', () => {
  const path = require('path');
  return {
    publicPath: path.join(mockTmpBase, 'public'),
    uploads: path.join(mockTmpBase, 'uploads'),
  };
});

const fs = require('fs');
const path = require('path');
const { saveLocalBuffer, getLocalFileStream } = require('../crud');

describe('saveLocalBuffer path containment', () => {
  beforeAll(() => {
    fs.mkdirSync(path.join(mockTmpBase, 'public', 'images'), { recursive: true });
    fs.mkdirSync(path.join(mockTmpBase, 'uploads'), { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(mockTmpBase, { recursive: true, force: true });
  });

  test('rejects filenames with path traversal sequences', async () => {
    await expect(
      saveLocalBuffer({
        userId: 'user1',
        buffer: Buffer.from('malicious'),
        fileName: '../../../etc/passwd',
        basePath: 'uploads',
      }),
    ).rejects.toThrow('Path traversal detected in filename');
  });

  test('rejects prefix-collision traversal (startsWith bypass)', async () => {
    fs.mkdirSync(path.join(mockTmpBase, 'uploads', 'user10'), { recursive: true });
    await expect(
      saveLocalBuffer({
        userId: 'user1',
        buffer: Buffer.from('malicious'),
        fileName: '../user10/evil',
        basePath: 'uploads',
      }),
    ).rejects.toThrow('Path traversal detected in filename');
  });

  test('allows normal filenames', async () => {
    const result = await saveLocalBuffer({
      userId: 'user1',
      buffer: Buffer.from('safe content'),
      fileName: 'file-id__output.csv',
      basePath: 'uploads',
    });

    expect(result).toBe('/uploads/user1/file-id__output.csv');

    const filePath = path.join(mockTmpBase, 'uploads', 'user1', 'file-id__output.csv');
    expect(fs.existsSync(filePath)).toBe(true);
    fs.unlinkSync(filePath);
  });
});

describe('getLocalFileStream', () => {
  const readStream = (stream) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString()));
      stream.on('error', reject);
    });

  const imageOutput = path.join(mockTmpBase, 'public', 'images');
  const req = { config: { paths: { imageOutput, uploads: path.join(mockTmpBase, 'uploads') } } };

  beforeAll(() => {
    fs.mkdirSync(path.join(imageOutput, 'user1'), { recursive: true });
    fs.writeFileSync(path.join(imageOutput, 'user1', 'img.png'), 'png bytes');
  });

  test('ignores a cache-busting query suffix on image paths', async () => {
    const stream = await getLocalFileStream(req, '/images/user1/img.png?v=1792030178871');
    await expect(readStream(stream)).resolves.toBe('png bytes');
  });

  test('reads image paths without a suffix', async () => {
    const stream = await getLocalFileStream(req, '/images/user1/img.png');
    await expect(readStream(stream)).resolves.toBe('png bytes');
  });
});
