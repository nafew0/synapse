const { Readable } = require('stream');
const { Time, CacheKeys } = require('librechat-data-provider');
const {
  getStorageSource,
  createDocumentReadTool,
  isDocumentOcrAllowed,
  createUnstructuredClient,
  resolveDocumentOcrClientOptions,
} = require('@librechat/api');
const { FileSources } = require('librechat-data-provider');
const getLogStores = require('~/cache/getLogStores');
const { getStrategyFunctions } = require('./strategies');
const db = require('~/models');

/** One client per process, so its concurrency cap holds across requests. */
let sharedClient;
const getClient = (config) => {
  sharedClient ??= createUnstructuredClient(resolveDocumentOcrClientOptions(config));
  return sharedClient;
};

const streamToBuffer = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

/**
 * Creates `read_document` for this request, or `null` when this assistant or institution may not
 * send documents out. Lookups are scoped to the requesting user.
 *
 * @param {ServerRequest} req
 * @param {string} [agentId]
 */
function createDocumentReader(req, agentId) {
  const config = req.config?.documentOcr;
  if (!isDocumentOcrAllowed({ config, tenantId: req.user?.tenantId, agentId })) {
    return null;
  }
  const userId = req.user.id;
  const { conversationId } = req.body ?? {};
  const requestFileIds = (req.body?.files ?? []).map((file) => file.file_id).filter(Boolean);
  const cache = getLogStores(CacheKeys.DOCUMENT_OCR);
  const cacheKey = (hash) => `${userId}:${config.profile}:${hash}`;

  const { handleFileUpload: uploadCodeEnvFile } = getStrategyFunctions(FileSources.execute_code);

  return createDocumentReadTool({
    client: getClient(config),
    maxPages: config.maxPages,
    listFiles: async () => {
      const convoFileIds = conversationId ? ((await db.getConvoFiles(conversationId)) ?? []) : [];
      const fileIds = [...new Set([...requestFileIds, ...convoFileIds])];
      return (
        (await db.getFiles({ user: userId, file_id: { $in: fileIds } }, null, { text: 0 })) ?? []
      );
    },
    readBytes: async (file) => {
      const { getDownloadStream } = getStrategyFunctions(getStorageSource(file));
      if (!getDownloadStream) {
        return null;
      }
      return streamToBuffer(await getDownloadStream(req, file.filepath));
    },
    getCached: (hash) => cache.get(cacheKey(hash)),
    setCached: (hash, reading) => cache.set(cacheKey(hash), reading, Time.ONE_DAY * 7),
    uploadToSandbox: async (name, content) => {
      const uploaded = await uploadCodeEnvFile({
        req,
        stream: Readable.from(Buffer.from(content, 'utf8')),
        filename: name,
        kind: 'user',
        id: userId,
      });
      return {
        id: uploaded.file_id,
        name,
        storage_session_id: uploaded.storage_session_id,
        kind: 'user',
      };
    },
  });
}

module.exports = { createDocumentReader };
