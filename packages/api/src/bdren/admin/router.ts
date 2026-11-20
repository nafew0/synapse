import { Router } from 'express';
import type { RequestHandler } from 'express';
import type { KnowledgeDeps } from './knowledge';
import type { GroupDeps } from './groups';
import { createProductKeyGuard, createTaskCostHandlers } from '~/usage/costs';
import { createKnowledgeHandlers } from './knowledge';
import { createInstitutionGuard } from './guard';
import { createTicketService } from './tickets';
import { createGroupHandlers } from './groups';
import { createUsageHandlers } from './usage';
import { manifestHandler } from './manifest';
import { createAuditor } from './audit';

export interface InstitutionAdminRouterDeps {
  productKey: () => string | undefined;
  issuer: () => string | undefined;
  /** `BDREN_UPLOAD_SECRET`, or a value derived from the product key. */
  uploadSecret: () => string | undefined;
  uploadTtlSeconds?: () => number | undefined;
  /** multer-style middleware that reads one `file` and caps it at `req.bdrenTicket.sizeBytes`. */
  oneFile: RequestHandler;
  methods: KnowledgeDeps['methods'];
  store: KnowledgeDeps['store'];
  index: KnowledgeDeps['index'];
  uploadBaseUrl: KnowledgeDeps['uploadBaseUrl'];
  recordAuditEntry: Parameters<typeof createAuditor>[0];
  grantPermission: GroupDeps['grantPermission'];
  findRoleByIdentifier: GroupDeps['findRoleByIdentifier'];
  deleteConfig: GroupDeps['deleteConfig'];
}

/**
 * `/api/bdren`: the product-key endpoints bdren.ai calls (task costs, admin manifest, the
 * institution-admin API) and the one public route, the signed knowledge-base upload.
 */
export function createBdrenRouter(deps: InstitutionAdminRouterDeps): Router {
  const audit = createAuditor(deps.recordAuditEntry);
  const tickets = createTicketService({
    secret: deps.uploadSecret,
    ttlSeconds: deps.uploadTtlSeconds,
  });
  const knowledge = createKnowledgeHandlers({
    methods: deps.methods,
    store: deps.store,
    index: deps.index,
    tickets,
    audit,
    getIssuer: deps.issuer,
    uploadBaseUrl: deps.uploadBaseUrl,
  });
  const groups = createGroupHandlers({
    audit,
    grantPermission: deps.grantPermission,
    findRoleByIdentifier: deps.findRoleByIdentifier,
    deleteConfig: deps.deleteConfig,
    issuer: deps.issuer,
  });
  const usage = createUsageHandlers();
  const costs = createTaskCostHandlers();

  const router = Router();
  /** The link is the credential here, not the product key. */
  router.post('/upload/:ticketId', knowledge.redeem, deps.oneFile, knowledge.completeUpload);

  router.use(createProductKeyGuard(deps.productKey));
  router.get('/task-costs', costs.getTaskCosts);
  router.get('/admin-manifest', manifestHandler);

  const institution = Router({ mergeParams: true });
  institution.use(createInstitutionGuard({ getIssuer: deps.issuer }) as RequestHandler);
  institution.get('/knowledge', knowledge.list as RequestHandler);
  institution.post('/knowledge/upload-url', knowledge.issueUploadUrl as RequestHandler);
  institution.get('/knowledge/:documentId/versions', knowledge.versions as RequestHandler);
  institution.patch('/knowledge/:documentId', knowledge.update as RequestHandler);
  institution.delete('/knowledge/:documentId', knowledge.remove as RequestHandler);
  institution.post('/knowledge/:documentId/retry', knowledge.retry as RequestHandler);
  institution.get('/groups', groups.list as RequestHandler);
  institution.post('/groups', groups.create as RequestHandler);
  institution.get('/groups/:groupId', groups.get as RequestHandler);
  institution.patch('/groups/:groupId', groups.update as RequestHandler);
  institution.delete('/groups/:groupId', groups.remove as RequestHandler);
  institution.get('/agents', groups.agents as RequestHandler);
  institution.get('/members', groups.members as RequestHandler);
  institution.get('/usage/daily', usage.daily as RequestHandler);
  router.use('/institutions/:orgId', institution);
  return router;
}
