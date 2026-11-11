const { Readable } = require('stream');
const { logger, runAsSystem } = require('@librechat/data-schemas');
const { Time, CacheKeys, documentOcrSchema } = require('librechat-data-provider');
const {
  getStorageSource,
  bringDeferredCodeFile,
  createDocumentReadTool,
  isDocumentOcrAllowed,
  createStructureLabeller,
  resolveStructureOptions,
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
 * The institution's OCR switch, read at most once per request and denied on any failure. Only asked
 * for agents that have the tool, and read fresh so that switching off takes effect at once.
 *
 * @param {ServerRequest} req
 * @returns {Promise<boolean>}
 */
function getDocumentOcrAccess(req) {
  const tenantId = req.user?.tenantId;
  if (!tenantId || !req.config?.documentOcr) {
    return Promise.resolve(false);
  }
  if (!req.documentOcrAccess) {
    req.documentOcrAccess = runAsSystem(() => db.getInstitutionByTenantId(tenantId, 'ocrAccess'))
      .then((institution) => institution?.ocrAccess === true)
      .catch((error) => {
        logger.error('[read_document] could not read the institution switch', error);
        return false;
      });
  }
  return req.documentOcrAccess;
}

/**
 * Creates `read_document` for this request, or `null` when this assistant or institution may not
 * send documents out. Lookups are scoped to the requesting user.
 *
 * @param {ServerRequest} req
 * @param {string} [agentId]
 */
async function createDocumentReader(req, agentId) {
  const ocrAccess = await getDocumentOcrAccess(req);
  if (!isDocumentOcrAllowed({ config: req.config?.documentOcr, ocrAccess, agentId })) {
    return null;
  }
  /* The app config holds the YAML as written, so the schema's defaults are applied here. */
  const config = documentOcrSchema.parse(req.config.documentOcr);
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
    labelStructure: config.structure
      ? createStructureLabeller(resolveStructureOptions(config.structure))
      : undefined,
    getCached: (hash) => cache.get(cacheKey(hash)),
    setCached: (hash, reading) => cache.set(cacheKey(hash), reading, Time.ONE_DAY * 7),
    recordCharge: ({ file, pages, contentHash }) =>
      db.createOcrTransaction({
        user: userId,
        tenantId: req.user.tenantId,
        fileId: file.file_id,
        pages,
        contentHash,
        profile: config.profile,
        pricePerPageUsd: config.pricePerPageUsd,
      }),
    copySource: async (file, bytes) => {
      try {
        const deferred = bringDeferredCodeFile(req, file, bytes);
        if (deferred) {
          return await deferred;
        }
        const uploaded = await uploadCodeEnvFile({
          req,
          stream: Readable.from(bytes),
          filename: file.filename,
          kind: 'user',
          id: userId,
        });
        return {
          id: uploaded.file_id,
          name: file.filename,
          storage_session_id: uploaded.storage_session_id,
          kind: 'user',
          resource_id: userId,
        };
      } catch (error) {
        logger.warn(`[read_document] Could not copy "${file.filename}" to the sandbox:`, error);
        return null;
      }
    },
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

module.exports = { createDocumentReader, getDocumentOcrAccess };
