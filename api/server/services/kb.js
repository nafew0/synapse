const {
  createKbIndexClient,
  createDoclingClient,
  startKbIngestWorker,
  createLocalKbFileStore,
} = require('@librechat/api');
const { logger, runAsSystem, tenantStorage } = require('@librechat/data-schemas');
const paths = require('~/config/paths');
const db = require('~/models');

/** Originals live beside other uploads; see `createLocalKbFileStore` for the layout. */
const store = createLocalKbFileStore(paths.uploads);

const index = process.env.RAG_API_URL ? createKbIndexClient(process.env.RAG_API_URL) : null;

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
      '[kb] ingestion worker off: set KB_DOCLING_URL, KB_DOCLING_API_KEY and RAG_API_URL to run it',
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
