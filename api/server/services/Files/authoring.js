const {
  getStorageSource,
  getStorageMetadata,
  createFileAuthoringDeps,
  createFileAuthoringTool,
} = require('@librechat/api');
const { getFileStrategy } = require('~/server/utils/getFileStrategy');
const { getStrategyFunctions } = require('./strategies');
const { getRetentionExpiry } = require('./retention');
const db = require('~/models');

/** @param {NodeJS.ReadableStream} stream */
const streamToBuffer = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

/**
 * Creates one of the chat-model file tools (`read_attachment`, `save_file`, `patch_file`) for
 * this request. They read and write Synapse's own file storage only; nothing reaches the sandbox.
 *
 * @param {string} toolName
 * @param {ServerRequest} req
 */
function createChatFileTool(toolName, req) {
  const requestFileIds = (req.body?.files ?? []).map((file) => file.file_id).filter(Boolean);
  const deps = createFileAuthoringDeps({
    userId: req.user.id,
    tenantId: req.user.tenantId,
    conversationId: req.body?.conversationId,
    requestFileIds,
    getConvoFiles: db.getConvoFiles,
    getFiles: db.getFiles,
    createFile: db.createFile,
    readStored: async (file) => {
      const { getDownloadStream } = getStrategyFunctions(getStorageSource(file));
      if (!getDownloadStream) {
        return null;
      }
      return streamToBuffer(await getDownloadStream(req, file.filepath));
    },
    storeBuffer: async ({ fileName, buffer }) => {
      const source = getFileStrategy(req.config, { isImage: false });
      const { saveBuffer } = getStrategyFunctions(source);
      const filepath = await saveBuffer({
        userId: req.user.id,
        buffer,
        fileName,
        basePath: 'uploads',
        tenantId: req.user.tenantId,
      });
      return { ...getStorageMetadata({ filepath, source }), filepath, source };
    },
    getRetention: () => getRetentionExpiry(req),
  });
  return createFileAuthoringTool(toolName, deps);
}

module.exports = { createChatFileTool };
