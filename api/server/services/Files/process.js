const fs = require('fs');
const path = require('path');
const mime = require('mime');
const { v4 } = require('uuid');
const {
  isUUID,
  Tools,
  megabyte,
  Constants,
  FileContext,
  FileSources,
  imageExtRegex,
  EModelEndpoint,
  EToolResources,
  mergeCodeEnvRef,
  mergeFileConfig,
  AgentCapabilities,
  checkOpenAIStorage,
  AUTO_TOOL_RESOURCE,
  removeNullishValues,
  isAssistantsEndpoint,
  isEphemeralAgentId,
  stripAgentIdSuffix,
  getEndpointFileConfig,
  documentParserMimeTypes,
  defaultAutoPreparation,
  isPermissiveMimeConfig,
} = require('librechat-data-provider');
const { logger, runAsSystem } = require('@librechat/data-schemas');
const {
  parseText,
  UploadStage,
  countTokens,
  DeliveryMethod,
  FileCategory,
  categorizeFile,
  planPreparation,
  sanitizeFilename,
  processAudioFile,
  sendUploadSuccess,
  getStorageMetadata,
  shouldEscalateToOcr,
  processTextWithTokenLimit,
  sweepExpiredFiles: sweepExpiredFilesWithDeps,
  startExpiredFileSweep: startExpiredFileSweepWithDeps,
} = require('@librechat/api');
const {
  convertImage,
  resizeAndConvert,
  resizeImageBuffer,
} = require('~/server/services/Files/images');
const { addResourceFileId, deleteResourceFileId } = require('~/server/controllers/assistants/v2');
const { getOpenAIClient } = require('~/server/controllers/assistants/helpers');
const { loadAuthValues } = require('~/server/services/Tools/credentials');
const { getFileStrategy } = require('~/server/utils/getFileStrategy');
const { checkCapability } = require('~/server/services/Config');
const { LB_QueueAsyncCall } = require('~/server/utils/queue');
const { getRetentionExpiry, getAgentFileRetentionExpiry } = require('./retention');
const { getStrategyFunctions } = require('./strategies');
const { determineFileType } = require('~/server/utils');
const { STTService } = require('./Audio/STTService');
const db = require('~/models');

/**
 * Creates a modular file upload wrapper that ensures filename sanitization
 * across all storage strategies. This prevents storage-specific implementations
 * from having to handle sanitization individually.
 *
 * @param {Function} uploadFunction - The storage strategy's upload function
 * @returns {Function} - Wrapped upload function with sanitization
 */
const createSanitizedUploadWrapper = (uploadFunction) => {
  return async (params) => {
    const { req, file, file_id, ...restParams } = params;

    // Create a modified file object with sanitized original name
    // This ensures consistent filename handling across all storage strategies
    const sanitizedFile = {
      ...file,
      originalname: sanitizeFilename(file.originalname),
    };

    return uploadFunction({ req, file: sanitizedFile, file_id, ...restParams });
  };
};

const hasCodeEnvRef = (file) =>
  file?.metadata?.codeEnvRef != null || file?.metadata?.codeEnvRefs != null;

const isMissingStorageError = (err) => {
  const code = err?.code ?? err?.status ?? err?.statusCode ?? err?.response?.status;
  if ([404, '404', 'ENOENT', 'NoSuchKey', 'NotFound', 'ResourceNotFound'].includes(code)) {
    return true;
  }

  return /(?:file|object|blob|key|resource) (?:not found|does not exist)|no such (?:file|key)/i.test(
    String(err?.message ?? ''),
  );
};

/**
 * Enqueues the delete operation to the leaky bucket queue if necessary, or adds it directly to promises.
 *
 * @param {object} params - The passed parameters.
 * @param {ServerRequest} params.req - The express request object.
 * @param {MongoFile} params.file - The file object to delete.
 * @param {Function} params.deleteFile - The delete file function.
 * @param {Promise[]} params.promises - The array of promises to await.
 * @param {Set<string>} params.resolvedFileIds - File IDs whose storage delete succeeded.
 * @param {Set<string>} params.failedFileIds - File IDs whose storage delete failed.
 * @param {OpenAI | undefined} [params.openai] - If an OpenAI file, the initialized OpenAI client.
 */
function enqueueDeleteOperation({
  req,
  file,
  deleteFile,
  promises,
  resolvedFileIds,
  failedFileIds,
  openai,
}) {
  if (checkOpenAIStorage(file.source)) {
    // Enqueue to leaky bucket
    promises.push(
      new Promise((resolve, reject) => {
        LB_QueueAsyncCall(
          () => deleteFile(req, file, openai),
          [],
          (err, result) => {
            if (err) {
              if (isMissingStorageError(err)) {
                resolvedFileIds.add(file.file_id);
                logger.warn('File storage was already missing during delete', err);
                resolve(result);
                return;
              }
              failedFileIds.add(file.file_id);
              logger.error('Error deleting file from OpenAI source', err);
              reject(err);
            } else {
              resolvedFileIds.add(file.file_id);
              resolve(result);
            }
          },
        );
      }),
    );
  } else {
    // Add directly to promises
    promises.push(
      deleteFile(req, file)
        .then(() => resolvedFileIds.add(file.file_id))
        .catch((err) => {
          if (isMissingStorageError(err)) {
            resolvedFileIds.add(file.file_id);
            logger.warn('File storage was already missing during delete', err);
            return;
          }
          failedFileIds.add(file.file_id);
          logger.error('Error deleting file', err);
          return Promise.reject(err);
        }),
    );
  }
}

const getDeleteMethod = ({ source, deletionMethods }) => {
  if (deletionMethods[source]) {
    return deletionMethods[source];
  }

  const { deleteFile } = getStrategyFunctions(source);
  if (!deleteFile) {
    throw new Error(`Delete function not implemented for ${source}`);
  }

  deletionMethods[source] = deleteFile;
  return deleteFile;
};

const createDeleteFileWithSecondaryStorage = ({ source, deleteFile, deletionMethods }) => {
  return async (req, file, openai) => {
    const secondaryDeleteMethods = [];
    if (file.embedded === true && source !== FileSources.vectordb) {
      secondaryDeleteMethods.push(
        getDeleteMethod({ source: FileSources.vectordb, deletionMethods }),
      );
    }
    if (hasCodeEnvRef(file) && source !== FileSources.execute_code) {
      secondaryDeleteMethods.push(
        getDeleteMethod({ source: FileSources.execute_code, deletionMethods }),
      );
    }

    try {
      await deleteFile(req, file, openai);
    } catch (err) {
      if (!isMissingStorageError(err)) {
        throw err;
      }
      logger.warn('Primary file storage was already missing during delete', err);
    }

    await Promise.all(
      secondaryDeleteMethods.map((secondaryDeleteFile) => secondaryDeleteFile(req, file)),
    );
  };
};

// TODO: refactor as currently only image files can be deleted this way
// as other filetypes will not reside in public path
/**
 * Deletes a list of files from the server filesystem and the database.
 *
 * @param {Object} params - The params object.
 * @param {MongoFile[]} params.files - The file objects to delete.
 * @param {ServerRequest} params.req - The express request object.
 * @param {DeleteFilesBody} params.req.body - The request body.
 * @param {string} [params.req.body.agent_id] - The agent ID if file uploaded is associated to an agent.
 * @param {string} [params.req.body.assistant_id] - The assistant ID if file uploaded is associated to an assistant.
 * @param {string} [params.req.body.tool_resource] - The tool resource if assistant file uploaded is associated to a tool resource.
 *
 * @returns {Promise<{ deletedFileIds: string[], failedFileIds: string[] }>}
 * @throws {Error} When storage deletion cannot be scheduled or file metadata cleanup fails.
 */
const processDeleteRequest = async ({ req, files }) => {
  const appConfig = req.config;
  const resolvedFileIds = new Set();
  const failedFileIds = new Set();
  const deletionMethods = {};
  const promises = [];

  /** @type {Record<string, OpenAI | undefined>} */
  const client = { [FileSources.openai]: undefined, [FileSources.azure]: undefined };
  const initializeClients = async () => {
    if (appConfig.endpoints?.[EModelEndpoint.assistants]) {
      const openAIClient = await getOpenAIClient({
        req,
        overrideEndpoint: EModelEndpoint.assistants,
      });
      client[FileSources.openai] = openAIClient.openai;
    }

    if (!appConfig.endpoints?.[EModelEndpoint.azureOpenAI]?.assistants) {
      return;
    }

    const azureClient = await getOpenAIClient({
      req,
      overrideEndpoint: EModelEndpoint.azureAssistants,
    });
    client[FileSources.azure] = azureClient.openai;
  };

  if (req.body.assistant_id !== undefined) {
    await initializeClients();
  }

  const agentFiles = [];

  for (const file of files) {
    const source = file.source ?? FileSources.local;
    if (req.body.agent_id && req.body.tool_resource) {
      agentFiles.push({
        tool_resource: req.body.tool_resource,
        file_id: file.file_id,
      });
    }

    if (source === FileSources.text) {
      resolvedFileIds.add(file.file_id);
      continue;
    }

    if (checkOpenAIStorage(source) && !client[source]) {
      await initializeClients();
    }

    const openai = client[source];

    if (req.body.assistant_id && req.body.tool_resource) {
      promises.push(
        deleteResourceFileId({
          req,
          openai,
          file_id: file.file_id,
          assistant_id: req.body.assistant_id,
          tool_resource: req.body.tool_resource,
        }),
      );
    } else if (req.body.assistant_id) {
      promises.push(openai.beta.assistants.files.del(req.body.assistant_id, file.file_id));
    }

    const deleteFile = getDeleteMethod({ source, deletionMethods });
    enqueueDeleteOperation({
      req,
      file,
      deleteFile: createDeleteFileWithSecondaryStorage({ source, deleteFile, deletionMethods }),
      promises,
      resolvedFileIds,
      failedFileIds,
      openai,
    });
  }

  if (agentFiles.length > 0) {
    promises.push(
      db.removeAgentResourceFiles({
        agent_id: req.body.agent_id,
        files: agentFiles,
      }),
    );
  }

  await Promise.allSettled(promises);
  const deletedFileIds = [...resolvedFileIds];
  let metadataDeletedFileIds = deletedFileIds;
  if (deletedFileIds.length > 0) {
    try {
      await db.deleteFiles(deletedFileIds);
    } catch (error) {
      logger.error('Error deleting file metadata after storage deletion', error);
      deletedFileIds.forEach((fileId) => failedFileIds.add(fileId));
      metadataDeletedFileIds = [];
      throw error;
    }
    if (metadataDeletedFileIds.length > 0) {
      try {
        await db.removeAgentResourceFilesFromAllAgents({ file_ids: metadataDeletedFileIds });
      } catch (error) {
        logger.error('Error cleaning up orphaned agent file references', error);
      }
    }
  }

  return {
    deletedFileIds: metadataDeletedFileIds,
    failedFileIds: [...failedFileIds],
  };
};

/**
 * Deletes expired file storage before removing the corresponding File records.
 *
 * Mongo TTL indexes delete only the metadata document, so file retention uses
 * this application sweep for records with `expiredAt` instead.
 *
 * @param {object} params
 * @param {AppConfig} params.appConfig
 * @param {number} [params.limit]
 * @param {() => Promise<AppConfig>} [params.loadAppConfig]
 * @returns {Promise<{ scanned: number, deleted: number, failed: number }>}
 */
async function sweepExpiredFiles(options = {}) {
  return sweepExpiredFilesWithDeps(options, {
    getExpiredFiles: db.getExpiredFiles,
    processDeleteRequest,
    logger,
  });
}

function startExpiredFileSweep(options = {}) {
  return startExpiredFileSweepWithDeps(options, {
    sweepExpiredFiles,
    runAsSystem,
    logger,
  });
}

/**
 * Processes a file URL using a specified file handling strategy. This function accepts a strategy name,
 * fetches the corresponding file processing functions (for saving and retrieving file URLs), and then
 * executes these functions in sequence. It first saves the file using the provided URL and then retrieves
 * the URL of the saved file. If any error occurs during this process, it logs the error and throws an
 * exception with an appropriate message.
 *
 * @param {Object} params - The parameters object.
 * @param {FileSources} params.fileStrategy - The file handling strategy to use.
 * Must be a value from the `FileSources` enum, which defines different file
 * handling strategies (like saving to Firebase, local storage, etc.).
 * @param {string} params.userId - The user's unique identifier. Used for creating user-specific paths or
 * references in the file handling process.
 * @param {string} params.URL - The URL of the file to be processed.
 * @param {string} params.fileName - The name that will be used to save the file (including extension)
 * @param {string} params.basePath - The base path or directory where the file will be saved or retrieved from.
 * @param {FileContext} params.context - The context of the file (e.g., 'avatar', 'image_generation', etc.)
 * @param {string} [params.tenantId] - Optional tenant identifier for tenant-prefixed storage paths.
 * @param {ServerRequest} [params.req] - Request context used to apply data retention metadata.
 * @returns {Promise<MongoFile>} A promise that resolves to the DB representation (MongoFile)
 *  of the processed file. It throws an error if the file processing fails at any stage.
 */
const processFileURL = async ({
  fileStrategy,
  userId,
  URL,
  fileName,
  basePath,
  context,
  tenantId,
  req,
}) => {
  const { saveURL, getFileURL } = getStrategyFunctions(fileStrategy);
  try {
    const savedFile = await saveURL({ userId, URL, fileName, basePath, tenantId });
    if (!savedFile) {
      throw new Error(`Strategy "${fileStrategy}" did not save "${fileName}"`);
    }

    const {
      bytes = 0,
      type = '',
      dimensions = {},
    } = typeof savedFile === 'string' ? {} : savedFile;
    const fallbackFileName =
      fileStrategy === FileSources.local || fileStrategy === FileSources.firebase
        ? `${userId}/${fileName}`
        : fileName;
    const filepath =
      typeof savedFile === 'string'
        ? savedFile
        : (savedFile.filepath ??
          (await getFileURL({ userId, fileName: fallbackFileName, basePath, tenantId })));
    if (!filepath) {
      throw new Error(`Strategy "${fileStrategy}" did not return a file URL for "${fileName}"`);
    }
    const storageMetadata = getStorageMetadata({
      filepath,
      source: fileStrategy,
      storageKey: typeof savedFile === 'string' ? undefined : savedFile.storageKey,
      storageRegion: typeof savedFile === 'string' ? undefined : savedFile.storageRegion,
    });

    return await db.createFile(
      {
        user: userId,
        file_id: v4(),
        bytes,
        filepath,
        ...storageMetadata,
        filename: fileName,
        source: fileStrategy,
        type,
        context,
        ...(await getRetentionExpiry(req)),
        tenantId,
        width: dimensions.width,
        height: dimensions.height,
      },
      true,
    );
  } catch (error) {
    logger.error(`Error while processing the image with ${fileStrategy}:`, error);
    throw new Error(`Failed to process the image with ${fileStrategy}. ${error.message}`);
  }
};

/**
 * Applies the current strategy for image uploads.
 * Saves file metadata to the database with an expiry TTL.
 *
 * @param {Object} params - The parameters object.
 * @param {ServerRequest} params.req - The Express request object.
 * @param {Express.Response} [params.res] - The Express response object.
 * @param {ImageMetadata} params.metadata - Additional metadata for the file.
 * @param {boolean} params.returnFile - Whether to return the file metadata or return response as normal.
 * @param {import('@librechat/api').UploadSseStream | null} [params.sseStream] - Active upload SSE stream, if enabled.
 * @returns {Promise<void>}
 */
const processImageFile = async ({ req, res, metadata, returnFile = false, sseStream }) => {
  const { file } = req;
  const appConfig = req.config;
  const source = getFileStrategy(appConfig, { isImage: true });
  const { handleImageUpload } = getStrategyFunctions(source);
  const { file_id, temp_file_id, endpoint } = metadata;

  const { filepath, bytes, width, height, storageKey, storageRegion } = await handleImageUpload({
    req,
    file,
    file_id,
    endpoint,
  });
  const storageMetadata = getStorageMetadata({ filepath, source, storageKey, storageRegion });

  const result = await db.createFile(
    {
      user: req.user.id,
      file_id,
      temp_file_id,
      bytes,
      filepath,
      ...storageMetadata,
      filename: file.originalname,
      context: FileContext.message_attachment,
      source,
      type: `image/${appConfig.imageOutputType}`,
      ...(await getRetentionExpiry(req)),
      width,
      height,
      tenantId: req.user.tenantId,
    },
    true,
  );

  if (returnFile) {
    return result;
  }
  sendUploadSuccess(res, sseStream, 'File uploaded and processed successfully', result);
};

/**
 * Applies the current strategy for image uploads and
 * returns minimal file metadata, without saving to the database.
 *
 * @param {Object} params - The parameters object.
 * @param {ServerRequest} params.req - The Express request object.
 * @param {FileContext} params.context - The context of the file (e.g., 'avatar', 'image_generation', etc.)
 * @param {boolean} [params.resize=true] - Whether to resize and convert the image to target format. Default is `true`.
 * @param {{ buffer: Buffer, width: number, height: number, bytes: number, filename: string, type: string, file_id: string }} [params.metadata] - Required metadata for the file if resize is false.
 * @returns {Promise<{ filepath: string, filename: string, source: string, type: string}>}
 */
const uploadImageBuffer = async ({ req, context, metadata = {}, resize = true }) => {
  const appConfig = req.config;
  const source = getFileStrategy(appConfig, { isImage: true });
  const { saveBuffer } = getStrategyFunctions(source);
  let { buffer, width, height, bytes, filename, file_id, type } = metadata;
  if (resize) {
    file_id = v4();
    type = `image/${appConfig.imageOutputType}`;
    ({ buffer, width, height, bytes } = await resizeAndConvert({
      inputBuffer: buffer,
      desiredFormat: appConfig.imageOutputType,
    }));
    filename = `${path.basename(req.file.originalname, path.extname(req.file.originalname))}.${
      appConfig.imageOutputType
    }`;
  }
  const fileName = `${file_id}-${filename}`;
  const filepath = await saveBuffer({
    userId: req.user.id,
    fileName,
    buffer,
    tenantId: req.user.tenantId,
  });
  const storageMetadata = getStorageMetadata({ filepath, source });
  return await db.createFile(
    {
      user: req.user.id,
      file_id,
      bytes,
      filepath,
      ...storageMetadata,
      filename,
      context,
      source,
      type,
      width,
      ...(await getRetentionExpiry(req)),
      height,
      tenantId: req.user.tenantId,
    },
    true,
  );
};

/**
 * Applies the current strategy for file uploads.
 * Saves file metadata to the database with an expiry TTL.
 * Files must be deleted from the server filesystem manually.
 *
 * @param {Object} params - The parameters object.
 * @param {ServerRequest} params.req - The Express request object.
 * @param {Express.Response} params.res - The Express response object.
 * @param {FileMetadata} params.metadata - Additional metadata for the file.
 * @param {import('@librechat/api').UploadSseStream | null} [params.sseStream] - Active upload SSE stream, if enabled.
 * @returns {Promise<void>}
 */
const processFileUpload = async ({ req, res, metadata, sseStream }) => {
  const appConfig = req.config;
  const isAssistantUpload = isAssistantsEndpoint(metadata.endpoint);
  const assistantSource =
    metadata.endpoint === EModelEndpoint.azureAssistants ? FileSources.azure : FileSources.openai;
  // Use the configured file strategy for regular file uploads (not vectordb)
  const source = isAssistantUpload ? assistantSource : appConfig.fileStrategy;
  const { handleFileUpload } = getStrategyFunctions(source);
  const { file_id, temp_file_id = null } = metadata;

  /** @type {OpenAI | undefined} */
  let openai;
  if (checkOpenAIStorage(source)) {
    ({ openai } = await getOpenAIClient({ req }));
  }

  const { file } = req;
  const sanitizedUploadFn = createSanitizedUploadWrapper(handleFileUpload);
  const {
    id,
    bytes,
    filename,
    filepath: _filepath,
    storageKey: _storageKey,
    storageRegion: _storageRegion,
    embedded,
    height,
    width,
  } = await sanitizedUploadFn({
    req,
    file,
    file_id,
    openai,
  });

  if (isAssistantUpload && !metadata.message_file && !metadata.tool_resource) {
    await openai.beta.assistants.files.create(metadata.assistant_id, {
      file_id: id,
    });
  } else if (isAssistantUpload && !metadata.message_file) {
    await addResourceFileId({
      req,
      openai,
      file_id: id,
      assistant_id: metadata.assistant_id,
      tool_resource: metadata.tool_resource,
    });
  }

  let filepath = isAssistantUpload ? `${openai.baseURL}/files/${id}` : _filepath;
  let storageMetadata = getStorageMetadata({
    filepath,
    source,
    storageKey: _storageKey,
    storageRegion: _storageRegion,
  });
  if (isAssistantUpload && file.mimetype.startsWith('image')) {
    const result = await processImageFile({
      req,
      file,
      metadata: { file_id: v4() },
      returnFile: true,
    });
    filepath = result.filepath;
    storageMetadata = getStorageMetadata({
      filepath,
      source: result.source,
      storageKey: result.storageKey,
      storageRegion: result.storageRegion,
    });
  }

  const result = await db.createFile(
    {
      user: req.user.id,
      file_id: id ?? file_id,
      temp_file_id,
      bytes,
      filepath,
      ...storageMetadata,
      filename: filename ?? sanitizeFilename(file.originalname),
      context: isAssistantUpload ? FileContext.assistants : FileContext.message_attachment,
      model: isAssistantUpload ? req.body.model : undefined,
      type: file.mimetype,
      ...(await getRetentionExpiry(req)),
      embedded,
      source,
      height,
      width,
      tenantId: req.user.tenantId,
    },
    true,
  );
  sendUploadSuccess(res, sseStream, 'File uploaded and processed successfully', result);
};

/** Whether the free built-in parser can open this type without a paid OCR call. */
const isDocumentParserType = (mimetype) =>
  documentParserMimeTypes.some((regex) => regex.test(mimetype));

/**
 * Copies an upload into the code interpreter's file store and returns the `codeEnvRef` metadata
 * that points at it. Chat attachments bucket per user, agent setup files per agent.
 *
 * @param {object} params
 * @param {ServerRequest} params.req
 * @param {Express.Multer.File} params.file
 * @param {string} [params.agent_id]
 * @param {boolean} params.messageAttachment
 * @returns {Promise<object>} `metadata` carrying the structured `codeEnvRef`.
 */
const uploadToCodeEnvironment = async ({ req, file, agent_id, messageAttachment }) => {
  const { handleFileUpload: uploadCodeEnvFile } = getStrategyFunctions(FileSources.execute_code);
  const stream = fs.createReadStream(file.path);
  /** A read stream that fails to open emits `error` with no listener attached, which takes the
   * process down instead of failing this one upload. The uploader surfaces the real failure. */
  stream.once('error', (err) => {
    logger.error(
      `[processAgentFileUpload] Could not read "${file.originalname}" for the code sandbox:`,
      err,
    );
  });
  /* Resource identity for codeapi's sessionKey:
   * - chat attachments (messageAttachment=true): `kind: 'user'`, codeapi
   *   buckets under `<tenant>:user:<authContext.userId>` regardless of `id`.
   * - agent setup files (messageAttachment=false): `kind: 'agent'`, shared
   *   per agent identity. `id` carries the agent id. */
  const codeKind = messageAttachment === true ? 'user' : 'agent';
  const codeId = messageAttachment === true ? req.user.id : agent_id;
  /* Upload under the same sanitized filename LC stores in its DB
   * (`fileInfo.filename` below uses `sanitizeFilename(originalname)`).
   * Codeapi/file_server use this as the on-disk name in the sandbox
   * — `/mnt/data/<filename>` — and `primeFiles`'s `toolContext` text
   * + `_injected_files.name` both reference `file.filename`. Sending
   * the unsanitized `file.originalname` here makes the sandbox path
   * (with spaces / special chars) drift from what LC tells the model
   * is available, causing FileNotFoundError on the first reference. */
  const sandboxFilename = sanitizeFilename(file.originalname);
  const uploaded = await uploadCodeEnvFile({
    req,
    stream,
    filename: sandboxFilename,
    kind: codeKind,
    id: codeId,
  });
  /* Persist under the structured `codeEnvRef` shape — the only key the
   * post-cutover schema (`metadata.codeEnvRef`) and downstream readers
   * (`primeFiles`, `getCodeFilesByIds`, `categorizeFileForToolResources`,
   * controller filtering) accept. Storing under the legacy
   * `fileIdentifier` key would be silently dropped by mongoose strict
   * mode and the file would lose its sandbox reference on subsequent
   * priming turns. */
  return mergeCodeEnvRef(undefined, {
    kind: codeKind,
    id: codeId,
    storage_session_id: uploaded.storage_session_id,
    file_id: uploaded.file_id,
    executionProfile: 'default',
  });
};

/**
 * Extracts a document's text, free parser first. OCR bills per page, so it runs only when the
 * parser found nothing, or so little text per page that the file reads as a scan. This reverses
 * the historical order, where a configured OCR ran on every matching file.
 *
 * @param {object} params
 * @param {ServerRequest} params.req
 * @param {Express.Multer.File} params.file
 * @param {boolean} params.ocrAvailable - A configured OCR service may be used for this file.
 * @param {number} params.ocrMinCharsPerPage
 * @param {() => void} [params.onRecognize] - Called just before the OCR request goes out.
 * @returns {Promise<{ text: string, bytes: number, filepath?: string, pages?: number, ocrApplied: boolean } | undefined>}
 */
const extractDocumentText = async ({
  req,
  file,
  ocrAvailable,
  ocrMinCharsPerPage,
  onRecognize,
}) => {
  let parsed;
  if (isDocumentParserType(file.mimetype)) {
    try {
      const { handleFileUpload } = getStrategyFunctions(FileSources.document_parser);
      parsed = await handleFileUpload({ req, file, loadAuthValues });
    } catch (err) {
      logger.warn(
        `[processAgentFileUpload] Document parser found no text in "${file.originalname}":`,
        err,
      );
    }
  }

  const readsAsScan = shouldEscalateToOcr({
    text: parsed?.text,
    pageCount: parsed?.pages,
    ocrMinCharsPerPage,
  });

  const ocrStrategy = req.config?.ocr?.strategy ?? FileSources.document_parser;
  const wouldRepeatTheParser = ocrStrategy === FileSources.document_parser && parsed != null;

  if (!ocrAvailable || !readsAsScan || wouldRepeatTheParser) {
    return parsed ? { ...parsed, ocrApplied: false } : undefined;
  }

  onRecognize?.();
  try {
    const { handleFileUpload } = getStrategyFunctions(ocrStrategy);
    const recognized = await handleFileUpload({ req, file, loadAuthValues });
    if (recognized?.text?.trim()) {
      return { ...recognized, ocrApplied: ocrStrategy !== FileSources.document_parser };
    }
  } catch (err) {
    logger.error(
      `[processAgentFileUpload] Text recognition failed for "${file.originalname}":`,
      err,
    );
  }

  return parsed ? { ...parsed, ocrApplied: false } : undefined;
};

/**
 * Resolves the text for a `context` upload: document extraction, speech-to-text, or a text parse,
 * in the order the file's type and the admin's configuration allow.
 *
 * @returns {Promise<{ text: string, bytes: number, filepath?: string, type?: string, ocrApplied: boolean, pages?: number }>}
 */
const resolveContextExtraction = async ({ req, file, metadata, appConfig, onRecognize }) => {
  const fileConfig = mergeFileConfig(appConfig.fileConfig);
  const { file_id } = metadata;

  const isOcrConfigured =
    appConfig?.ocr != null &&
    fileConfig.checkType(file.mimetype, fileConfig.ocr?.supportedMimeTypes || []);

  if (isOcrConfigured && !(await checkCapability(req, AgentCapabilities.ocr))) {
    throw new Error('OCR capability is not enabled for Agents');
  }

  const isDocumentParserEligible = isDocumentParserType(file.mimetype);

  /**
   * When an admin narrows `fileConfig.text.supportedMimeTypes` to a non-permissive allowlist that
   * includes a document type and a RAG API is configured, honor that intent by sending the file to
   * RAG `/text` instead of the built-in document parser. The permissive default catch-all is
   * excluded via `isPermissiveMimeConfig`, so RAG deployments that never customized text handling
   * keep the built-in parser introduced in #11900.
   */
  const shouldUseConfiguredText =
    !!process.env.RAG_API_URL &&
    isDocumentParserEligible &&
    !isPermissiveMimeConfig(fileConfig.text?.supportedMimeTypes) &&
    fileConfig.checkType(file.mimetype, fileConfig.text?.supportedMimeTypes || []);

  const shouldExtractDocument =
    isOcrConfigured || (!shouldUseConfiguredText && isDocumentParserEligible);

  const autoConfig = fileConfig.autoPreparation ?? defaultAutoPreparation;

  if (shouldExtractDocument) {
    const extracted = await extractDocumentText({
      req,
      file,
      ocrAvailable: isOcrConfigured,
      ocrMinCharsPerPage: autoConfig.ocrMinCharsPerPage,
      onRecognize,
    });
    if (extracted) {
      return extracted;
    }
    throw new Error(
      `Unable to extract text from "${file.originalname}". The document may be image-based and requires an OCR service to process.`,
    );
  }

  const shouldUseSTT = fileConfig.checkType(
    file.mimetype,
    fileConfig.stt?.supportedMimeTypes || [],
  );

  if (shouldUseSTT) {
    const sttService = await STTService.getInstance();
    const { text, bytes } = await processAudioFile({ req, file, sttService });
    return { text, bytes, ocrApplied: false };
  }

  const shouldUseText = fileConfig.checkType(
    file.mimetype,
    fileConfig.text?.supportedMimeTypes || [],
  );

  if (!shouldUseText) {
    throw new Error(`File type ${file.mimetype} is not supported for text parsing.`);
  }

  /**
   * A document type the admin routed to configured text extraction: prefer RAG `/text`, but fall
   * back to the built-in document parser (not raw native text) when RAG is unavailable, so a
   * transient outage doesn't degrade a docx/pdf to unreadable bytes. Only the RAG extraction is
   * inside the fallback catch: a downstream persistence failure (size guard, DB, agent-resource
   * mutation) must surface as itself, not trigger a second extraction attempt.
   */
  if (shouldUseConfiguredText) {
    try {
      const configuredText = await parseText({ req, file, file_id, allowNativeFallback: false });
      return {
        text: configuredText.text,
        bytes: configuredText.bytes,
        type: file.mimetype,
        ocrApplied: false,
      };
    } catch (err) {
      logger.warn(
        `[processAgentFileUpload] Configured RAG text extraction unavailable for "${file.originalname}", using built-in document parser:`,
        err,
      );
      const documentText = await extractDocumentText({
        req,
        file,
        ocrAvailable: isOcrConfigured,
        ocrMinCharsPerPage: autoConfig.ocrMinCharsPerPage,
        onRecognize,
      });
      if (!documentText) {
        throw new Error(
          `Unable to extract text from "${file.originalname}". RAG text extraction was unavailable and the built-in parser produced no result.`,
        );
      }
      return documentText;
    }
  }

  const { text, bytes } = await parseText({ req, file, file_id });
  return { text, bytes, type: file.mimetype, ocrApplied: false };
};

/**
 * Persists extracted text as a file record. Shared by the `context` branch and by automatic
 * preparation, which additionally records how the file was prepared so the attachment chip and
 * the conversation's full-text budget can read it back.
 *
 * @returns {Promise<MongoFile>} The created file record.
 */
const persistExtractedText = async ({
  req,
  file,
  metadata,
  messageAttachment,
  tool_resource,
  agent_id,
  text,
  bytes,
  filepath,
  type = 'text/plain',
  source = FileSources.text,
  embedded,
  fileMetadata,
  storageMetadata,
}) => {
  const { file_id, temp_file_id = null, conversationId } = metadata;
  const textBytes = Buffer.byteLength(text, 'utf8');
  if (textBytes > 15 * megabyte) {
    throw new Error(
      `Extracted text from "${file.originalname}" exceeds the 15MB storage limit (${Math.round(textBytes / megabyte)}MB). Try a shorter document.`,
    );
  }
  const retentionExpiry = await getAgentFileRetentionExpiry({
    req,
    messageAttachment,
    tool_resource,
  });
  const fileInfo = {
    ...removeNullishValues({
      text,
      bytes,
      file_id,
      temp_file_id,
      user: req.user.id,
      type,
      filepath: filepath ?? file.path,
      source,
      embedded,
      metadata: fileMetadata,
      ...storageMetadata,
      filename: file.originalname,
      conversationId: messageAttachment ? conversationId : undefined,
      model: messageAttachment ? undefined : req.body.model,
      context: messageAttachment ? FileContext.message_attachment : FileContext.agents,
      tenantId: req.user.tenantId,
    }),
    ...retentionExpiry,
  };

  if (!messageAttachment && tool_resource) {
    await db.addAgentResourceFile({
      file_id,
      agent_id,
      tool_resource,
      updatingUserId: req?.user?.id,
    });
  }

  return db.createFile(fileInfo, true);
};

/**
 * Full-text tokens this conversation has already committed. Later documents switch to retrieval
 * once the shared budget is spent, so a handful of individually small files cannot become a large
 * payload re-sent on every turn.
 *
 * @returns {Promise<number>}
 */
const getConversationTextTokens = async ({ req, conversationId }) => {
  if (!conversationId || conversationId === Constants.NEW_CONVO) {
    return 0;
  }
  try {
    const files = await db.getFiles(
      {
        user: req.user.id,
        conversationId,
        'metadata.preparation.contextTokens': { $gt: 0 },
      },
      null,
      { metadata: 1 },
    );
    return (files ?? []).reduce(
      (total, record) => total + (record.metadata?.preparation?.contextTokens ?? 0),
      0,
    );
  } catch (err) {
    logger.warn('[processAgentFileUpload] Could not read the conversation text budget:', err);
    return 0;
  }
};

/**
 * Sends the file to the vector store. When Synapse has already extracted text, that text is what
 * gets embedded: the RAG API has no OCR of its own, so a scan would otherwise index as nothing.
 * Either way it is embedded under the same `file_id`, so citations and deletion keep working.
 *
 * @returns {Promise<{ embedded: boolean, filename?: string }>}
 */
const embedForSearch = async ({ req, file, file_id, entity_id, text, storageMetadata }) => {
  const { uploadVectors } = require('./VectorDB/crud');
  if (!text) {
    return await uploadVectors({ req, file, file_id, entity_id, storageMetadata });
  }

  const textPath = `${file.path}.extracted.txt`;
  await fs.promises.writeFile(textPath, text, 'utf8');
  try {
    return await uploadVectors({
      req,
      file: {
        ...file,
        path: textPath,
        mimetype: 'text/plain',
        size: Buffer.byteLength(text, 'utf8'),
        originalname: `${path.parse(file.originalname).name}.txt`,
      },
      file_id,
      entity_id,
      storageMetadata,
    });
  } finally {
    await fs.promises.unlink(textPath).catch(() => undefined);
  }
};

/**
 * Registers a sandbox copy as an agent resource. Chat attachments need no registration — the file
 * is categorized from its own `codeEnvRef` on every turn — but a file saved to an agent does.
 */
const registerSandboxResource = async ({
  req,
  agent_id,
  metadata,
  messageAttachment,
  sandboxRef,
}) => {
  if (messageAttachment || !sandboxRef || !agent_id) {
    return;
  }
  await db.addAgentResourceFile({
    file_id: metadata.file_id,
    agent_id,
    tool_resource: EToolResources.execute_code,
    updatingUserId: req?.user?.id,
  });
};

/**
 * Stores the original bytes and creates the record for a prepared file that keeps its own format:
 * a searchable document or a spreadsheet in the sandbox. One record can hold several roles at
 * once — a sandbox reference for editing, the vector-store flag for search, and a short preview
 * the model reads in the conversation.
 *
 * @returns {Promise<MongoFile>} The created file record.
 */
const persistPreparedFile = async ({
  req,
  file,
  metadata,
  messageAttachment,
  agent_id,
  entity_id,
  tool_resource,
  previewText,
  searchable,
  searchText,
  sandboxRef,
  preparation,
}) => {
  const appConfig = req.config;
  const { file_id, temp_file_id = null, conversationId } = metadata;
  const source = getFileStrategy(appConfig, { isImage: false });
  const { handleFileUpload } = getStrategyFunctions(source);
  const sanitizedUploadFn = createSanitizedUploadWrapper(handleFileUpload);
  const storageResult = await sanitizedUploadFn({
    req,
    file,
    file_id,
    basePath: 'uploads',
    entity_id,
  });

  const storageMetadata = getStorageMetadata({
    filepath: storageResult.filepath,
    source,
    storageKey: storageResult.storageKey,
    storageRegion: storageResult.storageRegion,
  });

  let embedded;
  let filename = storageResult.filename;
  if (searchable) {
    const embedding = await embedForSearch({
      req,
      file,
      file_id,
      entity_id,
      text: searchText,
      storageMetadata,
    });
    embedded = embedding?.embedded;
    filename = embedding?.filename || filename;
  }

  if (!messageAttachment && tool_resource) {
    await db.addAgentResourceFile({
      file_id,
      agent_id,
      tool_resource,
      updatingUserId: req?.user?.id,
    });
  }

  const retentionExpiry = await getAgentFileRetentionExpiry({
    req,
    messageAttachment,
    tool_resource,
  });

  const fileInfo = {
    ...removeNullishValues({
      user: req.user.id,
      file_id,
      temp_file_id,
      bytes: storageResult.bytes,
      filepath: storageResult.filepath,
      ...storageMetadata,
      filename: filename ?? sanitizeFilename(file.originalname),
      conversationId: messageAttachment ? conversationId : undefined,
      context: messageAttachment ? FileContext.message_attachment : FileContext.agents,
      model: messageAttachment ? undefined : req.body.model,
      metadata: { ...sandboxRef, preparation },
      text: previewText,
      type: file.mimetype,
      embedded,
      source,
      tenantId: req.user.tenantId,
    }),
    ...retentionExpiry,
  };

  return db.createFile(fileInfo, true);
};

/**
 * Extracts whatever text the upload can give up, in the order that costs least: speech-to-text
 * for audio, the free document parser (escalating to OCR only for scans) for documents, and a
 * plain text parse for everything else. Returns `undefined` when the file has no readable text,
 * which is a valid outcome — the caller then falls back on a route that does not need any.
 *
 * @returns {Promise<{ text: string, bytes: number, filepath?: string, type?: string, pages?: number, ocrApplied: boolean } | undefined>}
 */
const extractPreparedText = async ({
  req,
  file,
  metadata,
  fileConfig,
  availability,
  autoConfig,
  category,
  sseStream,
}) => {
  if (category === FileCategory.audio) {
    if (!fileConfig.checkType(file.mimetype, fileConfig.stt?.supportedMimeTypes || [])) {
      return undefined;
    }
    const sttService = await STTService.getInstance();
    const { text, bytes } = await processAudioFile({ req, file, sttService });
    return { text, bytes, ocrApplied: false };
  }

  if (isDocumentParserType(file.mimetype) || availability.ocr) {
    const extracted = await extractDocumentText({
      req,
      file,
      ocrAvailable: availability.ocr,
      ocrMinCharsPerPage: autoConfig.ocrMinCharsPerPage,
      onRecognize: () => sseStream?.sendProgress(UploadStage.recognizing),
    });
    if (extracted?.text?.trim()) {
      return extracted;
    }
  }

  if (!fileConfig.checkType(file.mimetype, fileConfig.text?.supportedMimeTypes || [])) {
    return undefined;
  }

  try {
    const { text, bytes } = await parseText({ req, file, file_id: metadata.file_id });
    return text?.trim() ? { text, bytes, type: file.mimetype, ocrApplied: false } : undefined;
  } catch (err) {
    logger.warn(
      `[processAgentFileUpload] Text extraction found nothing in "${file.originalname}":`,
      err,
    );
    return undefined;
  }
};

/**
 * IDs of the agents a saved agent can hand a conversation to.
 * @param {{ id: string, edges?: Array<{ to?: string | string[] }> }} agent
 * @returns {string[]}
 */
const getHandoffTargetIds = (agent) => {
  const targets = new Set();
  for (const edge of agent.edges ?? []) {
    for (const to of [].concat(edge?.to ?? [])) {
      if (typeof to === 'string' && to !== agent.id) {
        targets.add(to);
      }
    }
  }
  return [...targets];
};

/**
 * The tools this chat's assistant will actually be handed, or `null` when that cannot be
 * determined and preparation should not narrow itself.
 *
 * `checkCapability` answers the deployment-wide question ("is file search enabled for Agents?"),
 * but `ToolService` equips `file_search` and `execute_code` only when they appear in the
 * assistant's own tool list. Preparing a file for a tool the model never receives is worse than
 * not preparing it at all: a long document would be embedded and billed, then be unreadable.
 *
 * An orchestrator receives the request's files and passes them to the specialists it hands off
 * to, so its specialists' tools count as well: a router without `execute_code` must still get a
 * sandbox copy for the Presentation Assistant that edits the deck.
 *
 * @returns {Promise<Set<string> | null>}
 */
/**
 * IDs of the agents a saved agent can hand a conversation to.
 * @param {{ id: string, edges?: Array<{ to?: string | string[] }> }} agent
 * @returns {string[]}
 */
const getHandoffTargetIds = (agent) => {
  const targets = new Set();
  for (const edge of agent.edges ?? []) {
    for (const to of [].concat(edge?.to ?? [])) {
      if (typeof to === 'string' && to !== agent.id) {
        targets.add(to);
      }
    }
  }
  return [...targets];
};

const resolveAssistantTools = async ({ req, metadata }) => {
  const { agent_id, spec } = metadata;

  if (agent_id && !isEphemeralAgentId(agent_id)) {
    try {
      const agent = await db.getAgent({ id: stripAgentIdSuffix(agent_id) });
      if (!Array.isArray(agent?.tools)) {
        return null;
      }
      const targetIds = getHandoffTargetIds(agent);
      if (targetIds.length === 0) {
        return new Set(agent.tools);
      }
      const targets = await db.getAgents({ id: { $in: targetIds } });
      return new Set(agent.tools.concat(...targets.map((target) => target.tools ?? [])));
    } catch (err) {
      logger.warn(`[processAgentFileUpload] Could not read tools for agent "${agent_id}":`, err);
      return null;
    }
  }

  /** Ephemeral chats take their tools from the model spec (`loadEphemeralAgent`). */
  const modelSpecs = req.config?.modelSpecs?.list;
  const modelSpec = spec ? modelSpecs?.find((entry) => entry.name === spec) : undefined;
  if (!modelSpec) {
    return null;
  }

  const tools = new Set();
  if (modelSpec.executeCode === true) {
    tools.add(Tools.execute_code);
  }
  if (modelSpec.fileSearch === true) {
    tools.add(Tools.file_search);
  }
  return tools;
};

/**
 * Handles an upload the user attached without choosing a destination. Extraction and delivery are
 * decided here rather than in the composer: the browser knows a file's bytes but not how much text
 * it holds, whether a PDF is a scan, or how much of the conversation's budget is already spent.
 *
 * @param {Object} params - The parameters object.
 * @param {ServerRequest} params.req - The Express request object.
 * @param {Express.Response} params.res - The Express response object.
 * @param {FileMetadata} params.metadata - Additional metadata for the file.
 * @param {import('@librechat/api').UploadSseStream | null} [params.sseStream] - Active upload SSE stream, if enabled.
 * @returns {Promise<void>}
 */
const prepareUploadAutomatically = async ({ req, res, metadata, sseStream }) => {
  const { file } = req;
  const appConfig = req.config;
  const { agent_id } = metadata;
  const messageAttachment = !!metadata.message_file;
  const category = categorizeFile(file.mimetype);

  /** Images have nothing to extract and nothing to search: the model simply looks at them. */
  const deliverToProvider = () =>
    processAgentFileUpload({
      req,
      res,
      sseStream,
      metadata: { ...metadata, tool_resource: undefined },
    });

  if (category === FileCategory.image) {
    return await deliverToProvider();
  }

  const fileConfig = mergeFileConfig(appConfig.fileConfig);
  const autoConfig = fileConfig.autoPreparation ?? defaultAutoPreparation;
  const isOcrConfigured =
    appConfig?.ocr != null &&
    fileConfig.checkType(file.mimetype, fileConfig.ocr?.supportedMimeTypes || []);

  const [fullText, fileSearch, codeExecution, ocr, assistantTools] = await Promise.all([
    checkCapability(req, AgentCapabilities.context),
    checkCapability(req, AgentCapabilities.file_search),
    checkCapability(req, AgentCapabilities.execute_code),
    isOcrConfigured ? checkCapability(req, AgentCapabilities.ocr) : Promise.resolve(false),
    resolveAssistantTools({ req, metadata }),
  ]);

  /** Reading text in full needs no tool, so only the tool-backed routes are narrowed. */
  const equipped = (tool) => assistantTools == null || assistantTools.has(tool);

  const availability = {
    fullText,
    search: fileSearch && !!process.env.RAG_API_URL && equipped(Tools.file_search),
    sandbox: codeExecution && equipped(Tools.execute_code),
    ocr: isOcrConfigured && ocr,
  };

  sseStream?.sendProgress(UploadStage.reading);
  const extracted = await extractPreparedText({
    req,
    file,
    metadata,
    fileConfig,
    availability,
    autoConfig,
    category,
    sseStream,
  });

  const [textTokens, conversationUsedTokens] = await Promise.all([
    extracted?.text ? countTokens(extracted.text) : 0,
    getConversationTextTokens({ req, conversationId: metadata.conversationId }),
  ]);

  const plan = planPreparation({
    mimetype: file.mimetype,
    textTokens,
    conversationUsedTokens,
    availability,
    config: autoConfig,
    ocrApplied: extracted?.ocrApplied === true,
  });

  /* Why a file went where it did. Without this, a document that quietly lands on the wrong
   * route looks identical to one that was routed correctly — the only visible difference is
   * a worse answer several turns later. */
  logger.debug('[processAgentFileUpload] prepared upload', {
    filename: file.originalname,
    mimetype: file.mimetype,
    textTokens,
    conversationUsedTokens,
    availability,
    assistantTools: assistantTools == null ? 'not narrowed' : Array.from(assistantTools),
    spec: metadata.spec ?? null,
    agent_id: agent_id ?? null,
    delivery: plan.delivery,
  });

  if (plan.delivery === DeliveryMethod.provider) {
    return await deliverToProvider();
  }

  const entity_id = messageAttachment === true ? undefined : agent_id;
  const needsSandboxCopy = plan.sandboxCopy || plan.delivery === DeliveryMethod.sandbox;
  const sandboxRef = needsSandboxCopy
    ? await uploadToCodeEnvironment({ req, file, agent_id, messageAttachment })
    : undefined;

  const preparation = {
    delivery: plan.delivery,
    label: plan.label,
    ocrApplied: plan.ocrApplied,
    pageCount: extracted?.pages,
  };

  if (plan.delivery === DeliveryMethod.full_text) {
    const result = await persistExtractedText({
      req,
      file,
      metadata,
      messageAttachment,
      tool_resource: EToolResources.context,
      agent_id,
      text: extracted.text,
      bytes: extracted.bytes,
      filepath: extracted.filepath,
      type: extracted.type,
      fileMetadata: {
        ...sandboxRef,
        preparation: { ...preparation, contextText: true, contextTokens: textTokens },
      },
    });
    await registerSandboxResource({ req, agent_id, metadata, messageAttachment, sandboxRef });
    sseStream?.sendProgress(UploadStage.ready);
    return sendUploadSuccess(
      res,
      sseStream,
      'Agent file uploaded and processed successfully',
      result,
    );
  }

  const searchable = plan.delivery === DeliveryMethod.search;
  if (searchable) {
    sseStream?.sendProgress(UploadStage.indexing);
  }

  /** A data file the model works on with code still gets a short preview, so it can see the
   * column names and shape before writing a single line. */
  const previewText =
    plan.delivery === DeliveryMethod.sandbox && availability.fullText && extracted?.text
      ? (
          await processTextWithTokenLimit({
            text: extracted.text,
            tokenLimit: autoConfig.previewTokens,
            tokenCountFn: countTokens,
          })
        ).text
      : undefined;

  const result = await persistPreparedFile({
    req,
    file,
    metadata,
    messageAttachment,
    agent_id,
    entity_id,
    tool_resource: plan.toolResource,
    previewText,
    searchable,
    searchText: extracted?.text,
    sandboxRef,
    preparation: {
      ...preparation,
      contextText: previewText != null,
      contextTokens: previewText != null ? Math.min(textTokens, autoConfig.previewTokens) : 0,
    },
  });

  if (plan.delivery === DeliveryMethod.search) {
    await registerSandboxResource({ req, agent_id, metadata, messageAttachment, sandboxRef });
  }

  sseStream?.sendProgress(UploadStage.ready);
  return sendUploadSuccess(
    res,
    sseStream,
    'Agent file uploaded and processed successfully',
    result,
  );
};

/**
 * Applies the current strategy for file uploads.
 * Saves file metadata to the database with an expiry TTL.
 * Files must be deleted from the server filesystem manually.
 *
 * @param {Object} params - The parameters object.
 * @param {ServerRequest} params.req - The Express request object.
 * @param {Express.Response} params.res - The Express response object.
 * @param {FileMetadata} params.metadata - Additional metadata for the file.
 * @param {import('@librechat/api').UploadSseStream | null} [params.sseStream] - Active upload SSE stream, if enabled.
 * @returns {Promise<void>}
 */
const processAgentFileUpload = async ({ req, res, metadata, sseStream }) => {
  if (metadata.tool_resource === AUTO_TOOL_RESOURCE) {
    return await prepareUploadAutomatically({ req, res, metadata, sseStream });
  }

  const { file } = req;
  const appConfig = req.config;
  const { agent_id, tool_resource, file_id, temp_file_id = null } = metadata;

  let messageAttachment = !!metadata.message_file;

  if (agent_id && !tool_resource && !messageAttachment) {
    throw new Error('No tool resource provided for agent file upload');
  }

  if (tool_resource === EToolResources.file_search && file.mimetype.startsWith('image')) {
    throw new Error('Image uploads are not supported for file search tool resources');
  }

  if (!messageAttachment && !agent_id) {
    throw new Error('No agent ID provided for agent file upload');
  }

  const isImage = file.mimetype.startsWith('image');
  let fileInfoMetadata;
  const entity_id = messageAttachment === true ? undefined : agent_id;
  const basePath = mime.getType(file.originalname)?.startsWith('image') ? 'images' : 'uploads';
  if (tool_resource === EToolResources.execute_code) {
    const isCodeEnabled = await checkCapability(req, AgentCapabilities.execute_code);
    if (!isCodeEnabled) {
      throw new Error('Code execution is not enabled for Agents');
    }
    fileInfoMetadata = await uploadToCodeEnvironment({
      req,
      file,
      agent_id,
      messageAttachment,
    });
  } else if (tool_resource === EToolResources.file_search) {
    const isFileSearchEnabled = await checkCapability(req, AgentCapabilities.file_search);
    if (!isFileSearchEnabled) {
      throw new Error('File search is not enabled for Agents');
    }
    // Note: File search processing continues to dual storage logic below
  } else if (tool_resource === EToolResources.context) {
    const extracted = await resolveContextExtraction({
      req,
      file,
      metadata,
      appConfig,
      onRecognize: () => sseStream?.sendProgress(UploadStage.recognizing),
    });
    const result = await persistExtractedText({
      req,
      file,
      metadata,
      messageAttachment,
      tool_resource,
      agent_id,
      text: extracted.text,
      bytes: extracted.bytes,
      filepath: extracted.filepath,
      type: extracted.type,
      fileMetadata: {
        preparation: {
          delivery: DeliveryMethod.full_text,
          ocrApplied: extracted.ocrApplied === true,
          pageCount: extracted.pages,
        },
      },
    });
    return sendUploadSuccess(
      res,
      sseStream,
      'Agent file uploaded and processed successfully',
      result,
    );
  }

  // Dual storage pattern for RAG files: Storage + Vector DB
  let storageResult, embeddingResult;
  const isImageFile = file.mimetype.startsWith('image');
  const source = getFileStrategy(appConfig, { isImage: isImageFile });

  if (tool_resource === EToolResources.file_search) {
    // FIRST: Upload to Storage for permanent backup (S3/local/etc.)
    const { handleFileUpload } = getStrategyFunctions(source);
    const sanitizedUploadFn = createSanitizedUploadWrapper(handleFileUpload);
    storageResult = await sanitizedUploadFn({
      req,
      file,
      file_id,
      basePath,
      entity_id,
    });

    // SECOND: Upload to Vector DB
    const { uploadVectors } = require('./VectorDB/crud');

    embeddingResult = await uploadVectors({
      req,
      file,
      file_id,
      entity_id,
    });

    // Vector status will be stored at root level, no need for metadata
    fileInfoMetadata = {};
  } else {
    // Standard single storage for non-RAG files
    const { handleFileUpload } = getStrategyFunctions(source);
    const sanitizedUploadFn = createSanitizedUploadWrapper(handleFileUpload);
    storageResult = await sanitizedUploadFn({
      req,
      file,
      file_id,
      basePath,
      entity_id,
    });
  }

  let {
    bytes,
    filename,
    filepath: _filepath,
    storageKey: _storageKey,
    storageRegion: _storageRegion,
    height,
    width,
  } = storageResult;
  // For RAG files, use embedding result; for others, use storage result
  let embedded = storageResult.embedded;
  if (tool_resource === EToolResources.file_search) {
    embedded = embeddingResult?.embedded;
    filename = embeddingResult?.filename || filename;
  }

  let filepath = _filepath;
  let storageMetadata = getStorageMetadata({
    filepath,
    source,
    storageKey: _storageKey,
    storageRegion: _storageRegion,
  });

  if (!messageAttachment && tool_resource) {
    await db.addAgentResourceFile({
      file_id,
      agent_id,
      tool_resource,
      updatingUserId: req?.user?.id,
    });
  }

  if (isImage) {
    const result = await processImageFile({
      req,
      file,
      metadata: { file_id: v4() },
      returnFile: true,
    });
    filepath = result.filepath;
    storageMetadata = getStorageMetadata({
      filepath,
      source: result.source,
      storageKey: result.storageKey,
      storageRegion: result.storageRegion,
    });
  }

  const retentionExpiry = await getAgentFileRetentionExpiry({
    req,
    messageAttachment,
    tool_resource,
  });
  const fileInfo = {
    ...removeNullishValues({
      user: req.user.id,
      file_id,
      temp_file_id,
      bytes,
      filepath,
      ...storageMetadata,
      filename: filename ?? sanitizeFilename(file.originalname),
      context: messageAttachment ? FileContext.message_attachment : FileContext.agents,
      model: messageAttachment ? undefined : req.body.model,
      metadata: fileInfoMetadata,
      type: file.mimetype,
      embedded,
      source,
      height,
      width,
      tenantId: req.user.tenantId,
    }),
    ...retentionExpiry,
  };

  const result = await db.createFile(fileInfo, true);

  sendUploadSuccess(res, sseStream, 'Agent file uploaded and processed successfully', result);
};

/**
 * @param {object} params - The params object.
 * @param {OpenAI} params.openai - The OpenAI client instance.
 * @param {string} params.file_id - The ID of the file to retrieve.
 * @param {string} params.userId - The user ID.
 * @param {string} [params.filename] - The name of the file. `undefined` for `file_citation` annotations.
 * @param {boolean} [params.saveFile=false] - Whether to save the file metadata to the database.
 * @param {boolean} [params.updateUsage=false] - Whether to update file usage in database.
 */
const processOpenAIFile = async ({
  openai,
  file_id,
  userId,
  filename,
  saveFile = false,
  updateUsage = false,
}) => {
  const _file = await openai.files.retrieve(file_id);
  const originalName = filename ?? (_file.filename ? path.basename(_file.filename) : undefined);
  const filepath = `${openai.baseURL}/files/${userId}/${file_id}${
    originalName ? `/${originalName}` : ''
  }`;
  const type = mime.getType(originalName ?? file_id);
  const source =
    openai.req.body.endpoint === EModelEndpoint.azureAssistants
      ? FileSources.azure
      : FileSources.openai;
  const file = {
    ..._file,
    type,
    file_id,
    filepath,
    usage: 1,
    user: userId,
    context: _file.purpose,
    source,
    model: openai.req.body.model,
    filename: originalName ?? file_id,
    ...(await getRetentionExpiry(openai.req)),
    tenantId: openai.req?.user?.tenantId,
  };

  if (saveFile) {
    await db.createFile(file, true);
  } else if (updateUsage) {
    try {
      await db.updateFileUsage({
        file_id,
        user: userId,
        tenantId: openai.req?.user?.tenantId,
      });
    } catch (error) {
      logger.error('Error updating file usage', error);
    }
  }

  return file;
};

/**
 * Process OpenAI image files, convert to target format, save and return file metadata.
 * @param {object} params - The params object.
 * @param {ServerRequest} params.req - The Express request object.
 * @param {Buffer} params.buffer - The image buffer.
 * @param {string} params.file_id - The file ID.
 * @param {string} params.filename - The filename.
 * @param {string} params.fileExt - The file extension.
 * @returns {Promise<MongoFile>} The file metadata.
 */
const processOpenAIImageOutput = async ({ req, buffer, file_id, filename, fileExt }) => {
  const currentDate = new Date();
  const formattedDate = currentDate.toISOString();
  const appConfig = req.config;
  const _file = await convertImage(req, buffer, undefined, `${file_id}${fileExt}`);

  // Create only one file record with the correct information
  const file = {
    ..._file,
    usage: 1,
    user: req.user.id,
    type: mime.getType(fileExt),
    createdAt: formattedDate,
    updatedAt: formattedDate,
    source: getFileStrategy(appConfig, { isImage: true }),
    context: FileContext.assistants_output,
    file_id,
    filename,
    ...(await getRetentionExpiry(req)),
    tenantId: req.user.tenantId,
  };
  try {
    await db.createFile(file, true);
  } catch (error) {
    logger.warn('Error saving OpenAI image output file metadata', error);
  }
  return file;
};

/**
 * Retrieves and processes an OpenAI file based on its type.
 *
 * @param {Object} params - The params passed to the function.
 * @param {OpenAIClient} params.openai - The OpenAI client instance.
 * @param {RunClient} params.client - The LibreChat client instance: either refers to `openai` or `streamRunManager`.
 * @param {string} params.file_id - The ID of the file to retrieve.
 * @param {string} [params.basename] - The basename of the file (if image); e.g., 'image.jpg'. `undefined` for `file_citation` annotations.
 * @param {boolean} [params.unknownType] - Whether the file type is unknown.
 * @returns {Promise<{file_id: string, filepath: string, source: string, bytes?: number, width?: number, height?: number} | null>}
 * - Returns null if `file_id` is not defined; else, the file metadata if successfully retrieved and processed.
 */
async function retrieveAndProcessFile({
  openai,
  client,
  file_id,
  basename: _basename,
  unknownType,
}) {
  if (!file_id) {
    return null;
  }

  let basename = _basename;
  const processArgs = { openai, file_id, filename: basename, userId: client.req.user.id };

  // If no basename provided, return only the file metadata
  if (!basename) {
    return await processOpenAIFile({ ...processArgs, saveFile: true });
  }

  const fileExt = path.extname(basename);
  if (client.attachedFileIds?.has(file_id) || client.processedFileIds?.has(file_id)) {
    return processOpenAIFile({ ...processArgs, updateUsage: true });
  }

  /**
   * @returns {Promise<Buffer>} The file data buffer.
   */
  const getDataBuffer = async () => {
    const response = await openai.files.content(file_id);
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  };

  let dataBuffer;
  if (unknownType || !fileExt || imageExtRegex.test(basename)) {
    try {
      dataBuffer = await getDataBuffer();
    } catch (error) {
      logger.error('Error downloading file from OpenAI:', error);
      dataBuffer = null;
    }
  }

  if (!dataBuffer) {
    return await processOpenAIFile({ ...processArgs, saveFile: true });
  }

  // If the filetype is unknown, inspect the file
  if (dataBuffer && (unknownType || !fileExt)) {
    const detectedExt = await determineFileType(dataBuffer);
    const isImageOutput = detectedExt && imageExtRegex.test('.' + detectedExt);

    if (!isImageOutput) {
      return await processOpenAIFile({ ...processArgs, saveFile: true });
    }

    return await processOpenAIImageOutput({
      file_id,
      req: client.req,
      buffer: dataBuffer,
      filename: basename,
      fileExt: detectedExt,
    });
  } else if (dataBuffer && imageExtRegex.test(basename)) {
    return await processOpenAIImageOutput({
      file_id,
      req: client.req,
      buffer: dataBuffer,
      filename: basename,
      fileExt,
    });
  } else {
    logger.debug(`[retrieveAndProcessFile] Non-image file type detected: ${basename}`);
    return await processOpenAIFile({ ...processArgs, saveFile: true });
  }
}

/**
 * Converts a base64 string to a buffer.
 * @param {string} base64String
 * @returns {Buffer<ArrayBufferLike>}
 */
function base64ToBuffer(base64String) {
  try {
    const typeMatch = base64String.match(/^data:([A-Za-z-+/]+);base64,/);
    const type = typeMatch ? typeMatch[1] : '';

    const base64Data = base64String.replace(/^data:([A-Za-z-+/]+);base64,/, '');

    if (!base64Data) {
      throw new Error('Invalid base64 string');
    }

    return {
      buffer: Buffer.from(base64Data, 'base64'),
      type,
    };
  } catch (error) {
    throw new Error(`Failed to convert base64 to buffer: ${error.message}`);
  }
}

async function saveBase64Image(
  url,
  { req, file_id: _file_id, filename: _filename, endpoint, context, resolution },
) {
  const appConfig = req.config;
  const effectiveResolution = resolution ?? appConfig.fileConfig?.imageGeneration ?? 'high';
  const file_id = _file_id ?? v4();
  let filename = `${file_id}-${_filename}`;
  const { buffer: inputBuffer, type } = base64ToBuffer(url);
  if (!path.extname(_filename)) {
    const extension = mime.getExtension(type);
    if (extension) {
      filename += `.${extension}`;
    } else {
      throw new Error(`Could not determine file extension from MIME type: ${type}`);
    }
  }

  const image = await resizeImageBuffer(inputBuffer, effectiveResolution, endpoint);
  const source = getFileStrategy(appConfig, { isImage: true });
  const { saveBuffer } = getStrategyFunctions(source);
  const filepath = await saveBuffer({
    userId: req.user.id,
    fileName: filename,
    buffer: image.buffer,
    tenantId: req.user.tenantId,
  });
  const storageMetadata = getStorageMetadata({ filepath, source });
  return await db.createFile(
    {
      type,
      source,
      context,
      file_id,
      filepath,
      ...storageMetadata,
      filename,
      user: req.user.id,
      bytes: image.bytes,
      width: image.width,
      ...(await getRetentionExpiry(req)),
      height: image.height,
      tenantId: req.user.tenantId,
    },
    true,
  );
}

/**
 * Filters a file based on its size and the endpoint origin.
 *
 * @param {Object} params - The parameters for the function.
 * @param {ServerRequest} params.req - The request object from Express.
 * @param {string} [params.req.endpoint]
 * @param {string} [params.req.file_id]
 * @param {number} [params.req.width]
 * @param {number} [params.req.height]
 * @param {number} [params.req.version]
 * @param {boolean} [params.image] - Whether the file expected is an image.
 * @param {boolean} [params.isAvatar] - Whether the file expected is a user or entity avatar.
 * @returns {void}
 *
 * @throws {Error} If a file exception is caught (invalid file size or type, lack of metadata).
 */
function filterFile({ req, image, isAvatar }) {
  const { file } = req;
  const { endpoint, endpointType, file_id, width, height } = req.body;

  if (!file_id && !isAvatar) {
    throw new Error('No file_id provided');
  }

  if (file.size === 0) {
    throw new Error('Empty file uploaded');
  }

  /* parse to validate api call, throws error on fail */
  if (!isAvatar) {
    isUUID.parse(file_id);
  }

  if (!endpoint && !isAvatar) {
    throw new Error('No endpoint provided');
  }

  const appConfig = req.config;
  const fileConfig = mergeFileConfig(appConfig.fileConfig);

  const endpointFileConfig = getEndpointFileConfig({
    endpoint,
    fileConfig,
    endpointType,
  });
  const fileSizeLimit =
    isAvatar === true ? fileConfig.avatarSizeLimit : endpointFileConfig.fileSizeLimit;

  if (file.size > fileSizeLimit) {
    throw new Error(
      `File size limit of ${fileSizeLimit / megabyte} MB exceeded for ${
        isAvatar ? 'avatar upload' : `${endpoint} endpoint`
      }`,
    );
  }

  const isSupportedMimeType = fileConfig.checkType(
    file.mimetype,
    endpointFileConfig.supportedMimeTypes,
  );

  if (!isSupportedMimeType) {
    throw new Error('Unsupported file type');
  }

  if (!image || isAvatar === true) {
    return;
  }

  if (!width) {
    throw new Error('No width provided');
  }

  if (!height) {
    throw new Error('No height provided');
  }
}

module.exports = {
  filterFile,
  processFileURL,
  saveBase64Image,
  processImageFile,
  uploadImageBuffer,
  sweepExpiredFiles,
  startExpiredFileSweep,
  processFileUpload,
  processDeleteRequest,
  processAgentFileUpload,
  retrieveAndProcessFile,
};
