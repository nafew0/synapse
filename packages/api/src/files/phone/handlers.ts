import { logger } from '@librechat/data-schemas';
import type { Request, Response, NextFunction } from 'express';
import type { StorageEngine } from 'multer';
import type { PhoneUploadFile, PhoneUploadSessionBody } from 'librechat-data-provider';
import type { PhoneUploadSessions, ResolvedPhoneSession } from './session';
import type { PhoneUploadStore } from './store';
import { PHONE_UPLOAD_MAX_FILES } from './session';
import { sanitizeFilename } from '~/utils/files';

export interface PhoneUploadHandlerDeps {
  sessions: PhoneUploadSessions;
  store: PhoneUploadStore;
}

type AuthedRequest = Request & { user?: { id?: string } };

interface PhoneUploadLocals {
  phoneSession?: ResolvedPhoneSession;
}

type StagedMulterFile = Express.Multer.File & { staged?: PhoneUploadFile };

type Handler = (req: Request, res: Response) => Promise<void>;
type Guard = (req: Request, res: Response, next: NextFunction) => Promise<void>;

export interface PhoneUploadHandlers {
  /** Multer storage that streams each phone file straight into the temporary store. */
  storage: StorageEngine;
  createSession: Handler;
  getSession: Handler;
  downloadFile: Handler;
  closeSession: Handler;
  /** Checks the phone's link before anything else runs; never answers 401, the phone has no login. */
  resolveLink: Guard;
  /** Refuses a file once the session holds the most the desktop can take in one go. */
  checkRoom: Guard;
  /** Lets the file-type check see the chat's endpoint, which the phone does not know. */
  applyTarget: (req: Request, res: Response) => void;
  status: Handler;
  received: (req: Request, res: Response) => void;
}

const LINK_GONE = 'This upload link has expired. Scan a new code on your computer.';
const SESSION_GONE = 'This phone upload has ended.';

const readSession = (res: Response): ResolvedPhoneSession | undefined =>
  (res.locals as PhoneUploadLocals).phoneSession;

const asText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const decodeName = (name: string): string => {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
};

/**
 * Headers for anything that carries the phone link's secret: browsers must not cache the page or
 * response, and must never pass the address on to another site.
 */
export function phoneLinkHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  next();
}

/** Express handlers for the QR-code handoff that sends phone files into a desktop chat. */
export function createPhoneUploadHandlers({
  sessions,
  store,
}: PhoneUploadHandlerDeps): PhoneUploadHandlers {
  const ownerOf = (req: AuthedRequest) => ({
    userId: req.user?.id ?? '',
    sessionId: String(req.params.sessionId ?? ''),
  });

  const fail = (res: Response, context: string, error: unknown) => {
    logger.error(`[phoneUpload] ${context}`, error);
    res.status(500).json({ error: 'Phone upload failed. Try again.' });
  };

  const storage: StorageEngine = {
    _handleFile(req, file, cb) {
      const session = req.res ? readSession(req.res) : undefined;
      if (!session) {
        cb(new Error(LINK_GONE));
        return;
      }
      store
        .save(session, {
          filename: sanitizeFilename(decodeName(file.originalname)),
          mimeType: file.mimetype || 'application/octet-stream',
          stream: file.stream,
        })
        .then((staged) => cb(null, { size: staged.bytes, staged } as Partial<StagedMulterFile>))
        .catch((error: Error) => cb(error));
    },
    _removeFile(req, file, cb) {
      const session = req.res ? readSession(req.res) : undefined;
      const staged = (file as StagedMulterFile).staged;
      if (!session || !staged) {
        cb(null);
        return;
      }
      store
        .remove(session, staged.fileId)
        .then(() => cb(null))
        .catch((error: Error) => cb(error));
    },
  };

  return {
    storage,

    async createSession(req: AuthedRequest, res: Response) {
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ error: 'Sign in again to upload from your phone.' });
        return;
      }
      const body = (req.body ?? {}) as PhoneUploadSessionBody;
      try {
        const created = await sessions.create(userId, {
          endpoint: asText(body.endpoint),
          endpointType: asText(body.endpointType),
        });
        res.status(201).json(created);
      } catch (error) {
        fail(res, 'create session', error);
      }
    },

    async getSession(req: AuthedRequest, res: Response) {
      const { userId, sessionId } = ownerOf(req);
      try {
        const session = await sessions.get(userId, sessionId);
        if (!session) {
          res.status(410).json({ error: SESSION_GONE });
          return;
        }
        res.json(session);
      } catch (error) {
        fail(res, 'read session', error);
      }
    },

    async downloadFile(req: AuthedRequest, res: Response) {
      try {
        const found = await store.open(ownerOf(req), String(req.params.fileId ?? ''));
        if (!found) {
          res.status(404).json({ error: 'File not found.' });
          return;
        }
        res.setHeader('Content-Type', found.file.mimeType);
        res.setHeader('Content-Length', String(found.file.bytes));
        res.setHeader('Cache-Control', 'no-store');
        found.stream.on('error', (error) => {
          logger.error('[phoneUpload] download stream', error);
          res.destroy(error);
        });
        found.stream.pipe(res);
      } catch (error) {
        fail(res, 'download file', error);
      }
    },

    async closeSession(req: AuthedRequest, res: Response) {
      const { userId, sessionId } = ownerOf(req);
      try {
        await sessions.close(userId, sessionId);
        res.status(204).end();
      } catch (error) {
        fail(res, 'close session', error);
      }
    },

    async resolveLink(req: Request, res: Response, next: NextFunction) {
      try {
        const session = await sessions.resolve(String(req.params.token ?? ''));
        if (!session) {
          res.status(404).json({ error: LINK_GONE });
          return;
        }
        (res.locals as PhoneUploadLocals).phoneSession = session;
        next();
      } catch (error) {
        fail(res, 'resolve link', error);
      }
    },

    async checkRoom(_req: Request, res: Response, next: NextFunction) {
      const session = readSession(res);
      if (!session) {
        res.status(404).json({ error: LINK_GONE });
        return;
      }
      try {
        const received = await store.count(session);
        if (received >= PHONE_UPLOAD_MAX_FILES) {
          res.status(409).json({
            error: `You can send up to ${PHONE_UPLOAD_MAX_FILES} files with one code. Scan a new code for more.`,
          });
          return;
        }
        next();
      } catch (error) {
        fail(res, 'count files', error);
      }
    },

    applyTarget(req: Request, res: Response) {
      const session = readSession(res);
      const body = req.body as Record<string, string | undefined>;
      if (session?.endpoint) {
        body.endpoint = session.endpoint;
      }
      if (session?.endpointType) {
        body.endpointType = session.endpointType;
      }
    },

    async status(_req: Request, res: Response) {
      const session = readSession(res);
      if (!session) {
        res.status(404).json({ error: LINK_GONE });
        return;
      }
      try {
        await sessions.markSeen(session);
        res.json({
          expiresAt: session.expiresAt.toISOString(),
          received: await store.count(session),
          maxFiles: PHONE_UPLOAD_MAX_FILES,
        });
      } catch (error) {
        fail(res, 'status', error);
      }
    },

    received(req: Request, res: Response) {
      const staged = (req.file as StagedMulterFile | undefined)?.staged;
      if (!staged) {
        res.status(400).json({ error: 'No file was received.' });
        return;
      }
      res.status(201).json(staged);
    },
  };
}
