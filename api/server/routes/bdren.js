const multer = require('multer');
const { KbLimits } = require('@librechat/data-schemas');
const { createBdrenRouter } = require('@librechat/api');
const { grantPermission } = require('~/server/services/PermissionService');
const { store, index } = require('~/server/services/kb');
const db = require('~/models');

const productKey = () => process.env.BDREN_PRODUCT_KEY;

/** Signs upload links with their own secret when set; otherwise one derived from the product key. */
const uploadSecret = () => {
  const own = (process.env.BDREN_UPLOAD_SECRET ?? '').trim();
  const key = (productKey() ?? '').trim();
  return own || (key ? `synapse-upload-v1:${key}` : undefined);
};

/** One file. multer's limit is one byte over the link's size so a file of exactly that size passes; the handler then checks it. */
const oneFile = (req, res, next) =>
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: Math.min(req.bdrenTicket.sizeBytes, KbLimits.maxFileBytes) + 1, files: 1 },
  }).single('file')(req, res, (error) => {
    if (error?.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'The file is larger than the upload link allows' });
    }
    return error ? res.status(400).json({ error: error.message }) : next();
  });

module.exports = createBdrenRouter({
  productKey,
  issuer: () => process.env.BDREN_ISSUER,
  uploadSecret,
  uploadTtlSeconds: () => Number(process.env.BDREN_UPLOAD_TTL_SECONDS) || undefined,
  oneFile,
  methods: db,
  store,
  index,
  uploadBaseUrl: (req) =>
    (process.env.BDREN_UPLOAD_BASE_URL ?? '').replace(/\/+$/, '') ||
    `${req.protocol}://${req.get('host')}/api/bdren/upload`,
  recordAuditEntry: db.recordAuditEntry,
  grantPermission,
  findRoleByIdentifier: db.findRoleByIdentifier,
  deleteConfig: db.deleteConfig,
});
