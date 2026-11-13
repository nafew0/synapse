const {
  createKbIndexClient,
  createDoclingClient,
  startKbIngestWorker,
  createLocalKbFileStore,
  getKbRagApiUrl,
  createUnstructuredClient,
  resolveDocumentOcrClientOptions,
} = require('@librechat/api');
const { documentOcrSchema } = require('librechat-data-provider');
const { logger, runAsSystem, tenantStorage } = require('@librechat/data-schemas');
const paths = require('~/config/paths');
const db = require('~/models');

/** Originals live beside other uploads; see `createLocalKbFileStore` for the layout. */
const store = createLocalKbFileStore(paths.uploads);

const ragApiUrl = getKbRagApiUrl();
const index = ragApiUrl ? createKbIndexClient(ragApiUrl) : null;

const runAsTenant = (tenantId, fn) => tenantStorage.run({ tenantId }, fn);

/**
 * OCR for scanned and garbled PDF pages, when this deployment configures `documentOcr`. Each
 * institution must also have its OCR switch on; reads are recorded against it like the
 * Office Assistant's, under the admin who uploaded the version.
 */
function createKnowledgeBaseOcr(appConfig) {
  if (!appConfig?.documentOcr) {
    return undefined;
  }
  const config = documentOcrSchema.parse(appConfig.documentOcr);
  const client = createUnstructuredClient(resolveDocumentOcrClientOptions(config));
  return {
    maxPages: config.maxPages,
    partition: client.partition,
    allowed: (tenantId) =>
      runAsSystem(() => db.getInstitutionByTenantId(tenantId, 'ocrAccess'))
        .then((institution) => institution?.ocrAccess === true)
        .catch((error) => {
          logger.error('[kb] could not read the institution OCR switch', error);
          return false;
        }),
    recordCharge: async ({ tenantId, documentId, version, userId, pages, contentHash }) => {
      if (!userId) {
        logger.warn(`[kb] OCR read of ${documentId} v${version} has no uploader; not recorded`);
        return;
      }
      await db.createOcrTransaction({
        user: userId,
        tenantId,
        fileId: `kb:${documentId}:v${version}`,
        pages,
        contentHash,
        profile: config.profile,
        pricePerPageUsd: config.pricePerPageUsd,
      });
    },
  };
}

/**
 * Starts the ingestion worker when Docling and the RAG API are configured. Without them
 * uploads still queue, and they are processed once the worker runs.
 */
function startKnowledgeBaseWorker(appConfig) {
  const doclingUrl = process.env.KB_DOCLING_URL;
  const doclingKey = process.env.KB_DOCLING_API_KEY;
  if (!doclingUrl || !doclingKey || !index) {
    logger.info(
      '[kb] ingestion worker off: set KB_DOCLING_URL, KB_DOCLING_API_KEY and KB_RAG_API_URL or RAG_API_URL to run it',
    );
    return null;
  }
  const ocr = createKnowledgeBaseOcr(appConfig);
  logger.info(`[kb] ingestion worker started${ocr ? ', scanned pages read with OCR' : ''}`);
  return startKbIngestWorker({
    ocr,
    methods: db,
    docling: createDoclingClient({ baseUrl: doclingUrl, apiKey: doclingKey }),
    index,
    readFile: store.read,
    deleteFile: store.remove,
    runAsSystem,
    runAsTenant,
  });
}

module.exports = { store, index, startKnowledgeBaseWorker };
