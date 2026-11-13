import path from 'path';
import { createHash } from 'crypto';
import { KbDocTypes } from 'librechat-data-provider';
import { KbLimits, logger, tenantStorage } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { IKbDocument, KbDocType, KbMethods } from '@librechat/data-schemas';
import type { KbIndexClient } from '~/kb/rag';
import type { KbFileStore } from '~/kb/store';
import { forgetInstitutionKb } from '~/kb/availability';

/** Extension decides the type: browsers send `application/octet-stream` for .md and others. */
const TYPES_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
};

export const KB_UPLOAD_EXTENSIONS: readonly string[] = Object.keys(TYPES_BY_EXTENSION);

const DOC_TYPES: ReadonlySet<string> = new Set(KbDocTypes);

interface UploadedFile {
  buffer: Buffer;
  originalname: string;
  size: number;
}

type KbRequest = Request & {
  file?: UploadedFile;
  user?: { id?: string; _id?: { toString(): string } };
};

export interface AdminKbDeps {
  methods: Pick<
    KbMethods,
    | 'listKbDocuments'
    | 'getKbDocument'
    | 'getKbUsage'
    | 'createKbDocument'
    | 'addKbDocumentVersion'
    | 'updateKbDocument'
    | 'listKbDocumentVersions'
    | 'deleteKbDocument'
  >;
  store: KbFileStore;
  index: Pick<KbIndexClient, 'remove'> | null;
  /** The tenant from `resolveAdminTenant`; sends the error itself and returns null when missing. */
  resolveTenant(req: Request, res: Response): string | null;
}

class KbRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Filename the browser sent, decoded from latin1 so Bangla names survive multer. */
const originalName = (file: UploadedFile): string =>
  Buffer.from(file.originalname, 'latin1').toString('utf8');

const toView = (document: IKbDocument) => ({
  id: String(document._id),
  title: document.title,
  docType: document.docType,
  status: document.status,
  error: document.error ?? null,
  currentVersion: document.currentVersion,
  latestVersion: document.latestVersion,
  filename: document.filename,
  mimeType: document.mimeType,
  sizeBytes: document.sizeBytes,
  pageCount: document.pageCount,
  chunkCount: document.chunkCount,
  unreadablePages: document.unreadablePages ?? [],
  createdAt: document.createdAt,
  updatedAt: document.updatedAt,
});

const readDocType = (value: unknown): KbDocType | undefined => {
  if (value == null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string' || !DOC_TYPES.has(value)) {
    throw new KbRequestError(400, `Unknown document type: ${String(value)}`);
  }
  return value as KbDocType;
};

function readUpload(file: UploadedFile | undefined) {
  if (!file) {
    throw new KbRequestError(400, 'Attach a file in the "file" field');
  }
  const filename = originalName(file);
  const extension = path.extname(filename).toLowerCase();
  const mimeType = TYPES_BY_EXTENSION[extension];
  if (!mimeType) {
    throw new KbRequestError(
      400,
      `Unsupported file type. Upload one of: ${KB_UPLOAD_EXTENSIONS.join(', ')}`,
    );
  }
  if (file.size > KbLimits.maxFileBytes) {
    throw new KbRequestError(413, 'Files can be at most 50 MB');
  }
  if (file.size === 0) {
    throw new KbRequestError(400, 'The file is empty');
  }
  const sha256 = createHash('sha256').update(file.buffer).digest('hex');
  return { filename, extension, mimeType, sha256, sizeBytes: file.size };
}

type AdminKbHandler = (req: Request, res: Response) => Promise<void>;

export interface AdminKbHandlers {
  list: AdminKbHandler;
  upload: AdminKbHandler;
  replace: AdminKbHandler;
  update: AdminKbHandler;
  versions: AdminKbHandler;
  remove: AdminKbHandler;
}

export function createAdminKbHandlers(deps: AdminKbDeps): AdminKbHandlers {
  const { methods, store } = deps;

  /** Runs a handler inside the tenant's context, turning known errors into responses. */
  const scoped =
    (handler: (req: KbRequest, res: Response, tenantId: string) => Promise<unknown>) =>
    async (req: Request, res: Response): Promise<void> => {
      const tenantId = deps.resolveTenant(req, res);
      if (!tenantId) {
        return;
      }
      try {
        await tenantStorage.run({ tenantId }, () => handler(req as KbRequest, res, tenantId));
      } catch (error) {
        if (error instanceof KbRequestError) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        logger.error('[admin/kb] request failed', error);
        res.status(500).json({ error: 'Knowledge base request failed' });
      }
    };

  const userId = (req: KbRequest): string | null => req.user?.id ?? null;

  const checkRoom = async (addedBytes: number, newDocument: boolean) => {
    const usage = await methods.getKbUsage();
    if (newDocument && usage.documents >= KbLimits.maxDocuments) {
      throw new KbRequestError(
        409,
        `The knowledge base holds at most ${KbLimits.maxDocuments} documents`,
      );
    }
    if (usage.bytes + addedBytes > KbLimits.maxTotalBytes) {
      throw new KbRequestError(409, 'This upload would take the knowledge base past 1 GB');
    }
  };

  const findDocument = async (id: string) => {
    const document = /^[a-f0-9]{24}$/i.test(id) ? await methods.getKbDocument(id) : null;
    if (!document) {
      throw new KbRequestError(404, 'Document not found');
    }
    return document;
  };

  const list = scoped(async (_req, res) => {
    const [documents, usage] = await Promise.all([methods.listKbDocuments(), methods.getKbUsage()]);
    res.json({
      documents: documents.map(toView),
      usage,
      limits: {
        maxDocuments: KbLimits.maxDocuments,
        maxFileBytes: KbLimits.maxFileBytes,
        maxTotalBytes: KbLimits.maxTotalBytes,
      },
      extensions: KB_UPLOAD_EXTENSIONS,
      docTypes: KbDocTypes,
    });
  });

  const upload = scoped(async (req, res, tenantId) => {
    const file = readUpload(req.file);
    const docType = readDocType(req.body?.docType);
    await checkRoom(file.sizeBytes, true);
    const title =
      String(req.body?.title ?? '').trim() || path.basename(file.filename, file.extension);
    const fileRef = await store.save({
      tenantId,
      extension: file.extension,
      buffer: req.file!.buffer,
    });
    try {
      const { document } = await methods.createKbDocument({
        title,
        docType,
        createdBy: userId(req),
        file: {
          fileRef,
          filename: file.filename,
          mimeType: file.mimeType,
          sha256: file.sha256,
          sizeBytes: file.sizeBytes,
        },
      });
      res.status(201).json({ document: toView(document) });
    } catch (error) {
      await store.remove(fileRef).catch(() => undefined);
      throw error;
    }
  });

  const replace = scoped(async (req, res, tenantId) => {
    const existing = await findDocument(req.params.documentId);
    const file = readUpload(req.file);
    await checkRoom(file.sizeBytes - existing.sizeBytes, false);
    const fileRef = await store.save({
      tenantId,
      extension: file.extension,
      buffer: req.file!.buffer,
    });
    try {
      const { document } = await methods.addKbDocumentVersion(
        String(existing._id),
        {
          fileRef,
          filename: file.filename,
          mimeType: file.mimeType,
          sha256: file.sha256,
          sizeBytes: file.sizeBytes,
        },
        userId(req),
      );
      res.status(201).json({ document: toView(document) });
    } catch (error) {
      await store.remove(fileRef).catch(() => undefined);
      if (error instanceof Error && /same as the latest version/.test(error.message)) {
        throw new KbRequestError(409, error.message);
      }
      throw error;
    }
  });

  const update = scoped(async (req, res) => {
    const existing = await findDocument(req.params.documentId);
    const title = typeof req.body?.title === 'string' ? req.body.title : undefined;
    if (title !== undefined && !title.trim()) {
      throw new KbRequestError(400, 'The title cannot be empty');
    }
    const document = await methods.updateKbDocument(String(existing._id), {
      title,
      docType: readDocType(req.body?.docType),
      updatedBy: userId(req),
    });
    res.json({ document: toView(document!) });
  });

  const versions = scoped(async (req, res) => {
    const existing = await findDocument(req.params.documentId);
    const all = await methods.listKbDocumentVersions(String(existing._id));
    res.json({
      versions: all.map((v) => ({
        version: v.version,
        filename: v.filename,
        sizeBytes: v.sizeBytes,
        indexedAt: v.indexedAt ?? null,
        current: v.version === existing.currentVersion,
        createdAt: v.createdAt,
      })),
    });
  });

  const remove = scoped(async (req, res, tenantId) => {
    const existing = await findDocument(req.params.documentId);
    const documentId = String(existing._id);
    if (deps.index) {
      await deps.index.remove({ tenantId, documentId });
    }
    const { fileRefs } = await methods.deleteKbDocument(documentId);
    await Promise.all(fileRefs.map((ref) => store.remove(ref).catch(() => undefined)));
    forgetInstitutionKb(tenantId);
    res.status(204).end();
  });

  return { list, upload, replace, update, versions, remove };
}
