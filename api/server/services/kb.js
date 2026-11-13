const {
  createKbIndexClient,
  createDoclingClient,
  startKbIngestWorker,
  createLocalKbFileStore,
  getKbRagApiUrl,
} = require('@librechat/api');
const { logger, runAsSystem, tenantStorage } = require('@librechat/data-schemas');
const paths = require('~/config/paths');
const db = require('~/models');

/** Originals live beside other uploads; see `createLocalKbFileStore` for the layout. */
const store = createLocalKbFileStore(paths.uploads);

const ragApiUrl = getKbRagApiUrl();
const index = ragApiUrl ? createKbIndexClient(ragApiUrl) : null;

const runAsTenant = (tenantId, fn) => tenantStorage.run({ tenantId }, fn);

/**
 * Starts the ingestion worker when Docling and the RAG API are configured. Without them
 * uploads still queue, and they are processed once the worker runs.
 */
function startKnowledgeBaseWorker() {
  const doclingUrl = process.env.KB_DOCLING_URL;
  const doclingKey = process.env.KB_DOCLING_API_KEY;
  if (!doclingUrl || !doclingKey || !index) {
    logger.info(
      '[kb] ingestion worker off: set KB_DOCLING_URL, KB_DOCLING_API_KEY and KB_RAG_API_URL or RAG_API_URL to run it',
    );
    return null;
  }
  logger.info('[kb] ingestion worker started');
  return startKbIngestWorker({
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
