import path from 'path';
import { KbDocTypes } from 'librechat-data-provider';
import { KbLimits, logger, tenantStorage } from '@librechat/data-schemas';
import type { IBdrenUploadTicket } from '@librechat/data-schemas';
import type { KbMethods } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { TicketService } from './tickets';
import type { KbIndexClient } from '~/kb/rag';
import type { KbFileStore } from '~/kb/store';
import type { AdminRequest } from './types';
import type { Auditor } from './audit';
import { findActorInTenant, findInstitutionByOrganization } from './guard';
import { KB_STORAGE_MAX_DAYS, readKbStorage, readStorageDays } from '~/kb/disk';
import { createAdminKbHandlers, KB_UPLOAD_EXTENSIONS } from '~/admin/kb';
import { normalizeOpenIdIssuer } from '~/auth/openid';
import { withAudit } from './audit';

export interface KnowledgeDeps {
  methods: Parameters<typeof createAdminKbHandlers>[0]['methods'] &
    Pick<KbMethods, 'getKbDocument' | 'listKbStorageDaily'>;
  store: KbFileStore;
  index: Pick<KbIndexClient, 'remove' | 'rename'> | null;
  tickets: TicketService;
  audit: Auditor;
  getIssuer: () => string | undefined;
  /** Where the browser posts the file, e.g. `https://chat.example/api/bdren/upload`. */
  uploadBaseUrl: (req: Request) => string;
}

export type TicketRequestWithFile = Request & {
  bdrenTicket?: IBdrenUploadTicket;
  file?: { originalname: string; size: number };
};

const DOC_TYPES: ReadonlySet<string> = new Set(KbDocTypes);
const OBJECT_ID = /^[a-f0-9]{24}$/i;

const fail = (res: Response, status: number, error: string): void => {
  res.status(status).json({ error });
};

/** The console-facing knowledge-base handlers. The tenant is only ever `req.bdren.tenantId`. */
type KnowledgeHandler = (req: AdminRequest, res: Response) => Promise<void>;

export interface KnowledgeHandlers {
  list: KnowledgeHandler;
  storage: KnowledgeHandler;
  versions: KnowledgeHandler;
  update: KnowledgeHandler;
  remove: KnowledgeHandler;
  retry: KnowledgeHandler;
  issueUploadUrl: KnowledgeHandler;
  redeem: (req: TicketRequestWithFile, res: Response, next: () => void) => Promise<void>;
  completeUpload: (req: TicketRequestWithFile, res: Response) => Promise<void>;
}

export function createKnowledgeHandlers(deps: KnowledgeDeps): KnowledgeHandlers {
  const { methods, tickets, audit } = deps;
  const kb = createAdminKbHandlers({
    methods,
    store: deps.store,
    index: deps.index,
    resolveTenant: (req, res) => {
      const tenantId = (req as AdminRequest).bdren?.tenantId;
      if (!tenantId) {
        fail(res, 403, 'No institution context');
        return null;
      }
      return tenantId;
    },
  });
  const documentTarget = (req: AdminRequest) => ({
    target: { type: 'kb_document', id: String(req.params.documentId) },
  });

  async function issueUploadUrl(req: AdminRequest, res: Response): Promise<void> {
    const context = req.bdren!;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const filename = typeof body.filename === 'string' ? body.filename.trim() : '';
    const extension = path.extname(filename).toLowerCase();
    const sizeBytes = Number(body.sizeBytes);
    if (!filename || filename.length > 255 || !KB_UPLOAD_EXTENSIONS.includes(extension)) {
      fail(res, 400, `Unsupported file type. Upload one of: ${KB_UPLOAD_EXTENSIONS.join(', ')}`);
      return;
    }
    if (!Number.isInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > KbLimits.maxFileBytes) {
      fail(res, 400, `sizeBytes must be between 1 and ${KbLimits.maxFileBytes}`);
      return;
    }
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 300) : undefined;
    const docType = typeof body.docType === 'string' && body.docType ? body.docType : undefined;
    if (docType && !DOC_TYPES.has(docType)) {
      fail(res, 400, `Unknown document type: ${docType}`);
      return;
    }
    const documentId = typeof body.documentId === 'string' ? body.documentId : undefined;
    if (documentId) {
      const found =
        OBJECT_ID.test(documentId) &&
        (await tenantStorage.run({ tenantId: context.tenantId }, () =>
          methods.getKbDocument(documentId),
        ));
      if (!found) {
        fail(res, 404, 'Document not found');
        return;
      }
    }
    const ticket = await tickets.issue({
      tenantId: context.tenantId,
      organizationId: context.organizationId,
      actorUserId: context.actor.userId,
      actorSubject: context.actor.subject,
      filename,
      extension,
      sizeBytes,
      title,
      docType,
      documentId,
    });
    if (!ticket) {
      fail(res, 503, 'Upload links are not configured');
      return;
    }
    const query = new URLSearchParams({ exp: String(ticket.expires), sig: ticket.signature });
    res.status(201).json({
      uploadUrl: `${deps.uploadBaseUrl(req)}/${ticket.ticketId}?${query}`,
      method: 'POST',
      fieldName: 'file',
      expiresAt: ticket.expiresAt.toISOString(),
      maxBytes: sizeBytes,
      filename,
    });
    await audit(
      req,
      'institution.kb_upload_url_issued',
      { type: 'kb_document', id: documentId },
      {
        filename,
        sizeBytes,
        ticketId: ticket.ticketId,
      },
    );
  }

  /** Verifies and spends the ticket before the body is read; sets `req.bdrenTicket`. */
  const redeem =
    (verifier: TicketService) =>
    async (req: TicketRequestWithFile, res: Response, next: () => void) => {
      const { ticketId } = req.params;
      const checked = await verifier.verify(
        String(ticketId),
        String(req.query.exp ?? ''),
        String(req.query.sig ?? ''),
      );
      if ('failure' in checked) {
        const status = checked.failure === 'invalid' ? 403 : 410;
        fail(
          res,
          status,
          checked.failure === 'invalid' ? 'Invalid upload link' : `Upload link ${checked.failure}`,
        );
        return;
      }
      const spent = await verifier.consume(checked.ticket.ticketId);
      if (!spent) {
        fail(res, 410, 'Upload link used');
        return;
      }
      req.bdrenTicket = spent;
      next();
    };

  /** Disk use now and per Asia/Dhaka day; the tenant is the guard's, never the caller's. */
  async function storage(req: AdminRequest, res: Response): Promise<void> {
    const tenantId = req.bdren?.tenantId;
    if (!tenantId) {
      fail(res, 403, 'No institution context');
      return;
    }
    const days = readStorageDays(req.query.days);
    if (days == null) {
      fail(res, 400, `days must be a whole number from 1 to ${KB_STORAGE_MAX_DAYS}`);
      return;
    }
    try {
      res.json(await readKbStorage(methods, tenantId, days));
    } catch (error) {
      logger.error('[bdren/knowledge] storage request failed', error);
      fail(res, 500, 'Knowledge base storage request failed');
    }
  }

  return {
    list: kb.list as KnowledgeHandler,
    storage,
    versions: kb.versions as KnowledgeHandler,
    update: withAudit(audit, 'institution.kb_document_renamed', documentTarget, kb.update as never),
    remove: withAudit(audit, 'institution.kb_document_deleted', documentTarget, kb.remove as never),
    retry: withAudit(audit, 'institution.kb_document_retried', documentTarget, kb.retry as never),
    issueUploadUrl,
    redeem: redeem(tickets),
    /** The ticket is already spent and checked; the file was read by multer in the route. */
    async completeUpload(req: TicketRequestWithFile, res: Response): Promise<void> {
      const ticket = req.bdrenTicket!;
      const issuer = normalizeOpenIdIssuer(deps.getIssuer());
      const actor = issuer
        ? await findActorInTenant(ticket.tenantId, issuer, ticket.actorSubject)
        : null;
      if (!issuer || !actor) {
        fail(res, 403, 'The acting user is no longer a member of this institution');
        return;
      }
      const institution = await findInstitutionByOrganization(ticket.organizationId);
      if (
        !institution ||
        institution.tenantId !== ticket.tenantId ||
        institution.status !== 'active'
      ) {
        fail(res, 403, 'The institution no longer accepts uploads');
        return;
      }
      const asAdmin = req as AdminRequest;
      asAdmin.bdren = {
        tenantId: ticket.tenantId,
        organizationId: ticket.organizationId,
        institutionName: '',
        actor: { userId: ticket.actorUserId, subject: ticket.actorSubject, issuer },
      };
      asAdmin.user = { id: ticket.actorUserId };
      const named = req.file
        ? path.extname(Buffer.from(req.file.originalname, 'latin1').toString('utf8')).toLowerCase()
        : '';
      if (req.file && named !== ticket.extension) {
        fail(res, 400, 'The file type does not match the upload link');
        return;
      }
      if (req.file && req.file.size > ticket.sizeBytes) {
        fail(res, 413, 'The file is larger than the upload link allows');
        return;
      }
      if (req.file) {
        req.file.originalname = Buffer.from(ticket.filename, 'utf8').toString('latin1');
      }
      req.body = { title: ticket.title, docType: ticket.docType };
      req.params = { ...req.params, documentId: ticket.documentId ?? '' };
      const replacing = Boolean(ticket.documentId);
      await withAudit(
        audit,
        replacing ? 'institution.kb_document_replaced' : 'institution.kb_document_uploaded',
        () => ({
          target: { type: 'kb_document', id: ticket.documentId },
          metadata: {
            filename: ticket.filename,
            sizeBytes: ticket.sizeBytes,
            ticketId: ticket.ticketId,
          },
        }),
        replacing ? kb.replace : kb.upload,
      )(asAdmin, res);
    },
  };
}
