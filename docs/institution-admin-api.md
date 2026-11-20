# Synapse institution-admin API (contract for the bdren.ai console, step I2)

Server-to-server. The browser never calls it except the signed upload URL. Base: `https://<synapse>/api/bdren`.
Code: `packages/api/src/bdren/admin/`, wiring `api/server/routes/bdren.js`.

## Authentication (every route except the upload URL)

| Header | Meaning |
|---|---|
| `X-Product-Key` (or `Authorization: Bearer`) | `BDREN_PRODUCT_KEY`, same key as `/task-costs`. Missing/wrong → 401, not configured → 503 |
| `X-Acting-Subject` | ZITADEL subject of the admin acting. Required (400) |
| `X-Acting-Issuer` | optional; if sent it must equal `BDREN_ISSUER` (else 403) |
| path `:orgId` | bdren.ai organization id, mapped to a tenant by `Institution.bdrenOrganizationId` |

Resolution: `orgId` → institution (404 if unmapped, 400 if malformed) → the subject must be an active member of
**that tenant** signed in through `BDREN_ISSUER` (403 otherwise). The tenant is never taken from the request body.
bdren.ai is responsible for checking the person administers the organization; Synapse does not check a role.
Writes to a suspended/closed institution → 403. Errors are `{ "error": string }`.

## Routes (`/institutions/:orgId/...`)

| Route | Body / query | Response |
|---|---|---|
| `GET /admin-manifest` (no orgId) | | `{app:"synapse", version:1, sections:[{key,title,paths}]}` — keys `knowledge`, `access-groups`, `usage` |
| `GET /knowledge` | | `{documents:[{id,title,docType,status:"queued\|processing\|ready\|failed",error,currentVersion,latestVersion,filename,mimeType,sizeBytes,pageCount,chunkCount,unreadablePages,createdAt,updatedAt}], usage:{documents,bytes}, limits:{maxDocuments,maxFileBytes,maxTotalBytes}, extensions, docTypes}` |
| `POST /knowledge/upload-url` | `{filename, sizeBytes, title?, docType?, documentId?}` (`documentId` = add a version) | 201 `{uploadUrl, method:"POST", fieldName:"file", expiresAt, maxBytes, filename}` |
| `PATCH /knowledge/:id` | `{title?, docType?}` | `{document}` (also renames in the search index) |
| `DELETE /knowledge/:id` | | 204 |
| `POST /knowledge/:id/retry` | | `{document}`; 409 if not failed |
| `GET /knowledge/:id/versions` | | `{versions:[...]}` |
| `GET /groups` | | `{groups:[{id,name,description,members:[{userId,subject,name,email}],agents:[{id,name}]}]}` (system-managed groups are never listed) |
| `POST /groups` | `{name, description?, members?:[subject], agents?:[agentId]}` | 201 `{group}` |
| `GET /groups/:id` | | `{group}` |
| `PATCH /groups/:id` | any of `name, description, members, agents` (lists replace) | `{group}` |
| `DELETE /groups/:id` | | 204 |
| `GET /agents` | | `{agents:[{id,name,description}]}`: the tenant's own agents plus platform agents the superadmin enabled for it |
| `GET /members` | | `{members:[{userId,subject,name,email}]}` active members (max 5000), to map console members to subjects |
| `GET /usage/daily?start=YYYY-MM-DD&end=YYYY-MM-DD` | range ≤ 93 days | `{start,end,truncated,rows:[{day,member:{userId,subject,name,email}\|null,service,taskType,requests,units,credits}]}`; `credits` is allowance credits (no provider cost) |

Group members are referenced by ZITADEL **subject**; a subject that is not an active member of the tenant, or an agent
the tenant may not use, gives 400 and changes nothing.

## Signed upload URL (the one browser-facing route)

`POST /knowledge/upload-url` returns `uploadUrl = <base>/api/bdren/upload/<ticketId>?exp=<unix>&sig=<hmac>`.
The browser sends `multipart/form-data` with one `file` field to it, no other auth, CORS open.

- TTL 5 min (`BDREN_UPLOAD_TTL_SECONDS`, max 600). Single use: spent before the body is read, so an aborted upload needs a new URL.
- The ticket fixes tenant, acting admin, file name (the stored name is the ticket's), type (extension must match) and size (file may not exceed `sizeBytes`).
- Signature: HMAC-SHA256 over `ticketId.tenantId.exp` with `BDREN_UPLOAD_SECRET` (else derived from the product key); tenant is read from the ticket, never the URL.
- Responses: 201 `{document}` (status `queued`, then poll `GET /knowledge`); 403 bad/forged link or admin left the institution; 410 expired or used; 413 too big; 400 wrong type.
- Set `BDREN_UPLOAD_BASE_URL` (e.g. `https://chat.bdren.ai/api/bdren/upload`) in production; otherwise the URL is built from the request host.

## Audit

Every write adds an entry to the institution's audit log, actor `{type:"api", id:<synapse user id>, name:"bdren:<issuer>#<subject>"}`,
metadata has `organizationId`. Actions: `institution.kb_upload_url_issued|kb_document_uploaded|kb_document_replaced|kb_document_renamed|kb_document_deleted|kb_document_retried|access_group_created|access_group_updated|access_group_deleted`. Failed writes are audited with outcome `failure`.

## Not done / for I2

- The console must send the real acting admin's subject; any active member's subject is accepted by Synapse.
- Audit writes are after the response and fail-open (logged).
- Upload content is checked by extension only.
