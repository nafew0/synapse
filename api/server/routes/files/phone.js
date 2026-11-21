const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const { runAsSystem } = require('@librechat/data-schemas');
const { mergeFileConfig } = require('librechat-data-provider');
const {
  removePorts,
  limiterCache,
  createPhoneUploadStore,
  createPhoneUploadSessions,
  createPhoneUploadHandlers,
} = require('@librechat/api');
const { requireJwtAuth, checkBan } = require('~/server/middleware');
const { createToken, findToken, updateToken, deleteTokens } = require('~/models');
const { getAppConfig } = require('~/server/services/Config');
const { createFileFilter } = require('./multer');

/** Upload from phone: the desktop opens a session and shows a QR code; the phone sends files to it. */
const initialize = async () => {
  const store = createPhoneUploadStore(mongoose.connection.db);
  const sessions = createPhoneUploadSessions({
    store,
    createToken,
    findToken,
    updateToken,
    deleteTokens,
    runAsSystem,
  });
  const handlers = createPhoneUploadHandlers({ sessions, store });

  const appConfig = await getAppConfig();
  const fileConfig = mergeFileConfig(appConfig?.fileConfig);
  const fileFilter = createFileFilter(fileConfig);
  const upload = multer({
    storage: handlers.storage,
    limits: { fileSize: fileConfig.serverFileSizeLimit, files: 1 },
    fileFilter: (req, file, cb) => {
      handlers.applyTarget(req, req.res);
      fileFilter(req, file, cb);
    },
  });
  /** The phone has no login, so its uploads are limited per network address instead of per user. */
  const phoneIpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: parseInt(process.env.PHONE_UPLOAD_IP_MAX) || 60,
    keyGenerator: removePorts,
    store: limiterCache('phone_upload_ip_limiter'),
    handler: (req, res) =>
      res.status(429).json({ error: 'Too many uploads from this network. Try again later.' }),
  });

  const router = express.Router();

  router.get('/u/:token', handlers.resolveLink, handlers.status);
  router.post(
    '/u/:token',
    phoneIpLimiter,
    handlers.resolveLink,
    handlers.checkRoom,
    upload.single('file'),
    handlers.received,
  );

  const authed = [requireJwtAuth, checkBan];
  router.post('/sessions', ...authed, handlers.createSession);
  router.get('/sessions/:sessionId', ...authed, handlers.getSession);
  router.delete('/sessions/:sessionId', ...authed, handlers.closeSession);
  router.get('/sessions/:sessionId/files/:fileId', ...authed, handlers.downloadFile);

  return router;
};

module.exports = { initialize };
