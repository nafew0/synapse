import { randomUUID } from 'crypto';
import { unlink } from 'fs/promises';
import { logger } from '@librechat/data-schemas';
import { inferMimeType } from 'librechat-data-provider';
import type { Response } from 'express';
import type { BrowserExtensionMethods, IInstitution } from '@librechat/data-schemas';
import type { ExtensionConfig } from './config';
import type { CredentialStore } from './credentials';
import type { ExtensionRequest } from './auth';
import { exchangeCode, issueCode } from './credentials';
import { parseText } from '~/files/text';
import { parseDocument } from '~/files/documents/crud';

/** Documents the extension may send to be read: the formats tax and VAT papers arrive in. */
const DOCUMENT_TYPES = /\.(pdf|docx?|xlsx?|odt|ods|rtf|csv|pptx?)$/i;
/** The most text one document returns; the agent pages through attachments past its own budget. */
export const MAX_EXTRACT_CHARS = 400_000;

type Handler = (req: ExtensionRequest, res: Response) => Promise<void>;

export interface ExtensionHandlers {
  createCode: Handler;
  exchange: Handler;
  signOut: Handler;
  signOutEverywhere: Handler;
  settings: Handler;
  extract: Handler;
}

export function createExtensionHandlers(deps: {
  config: () => ExtensionConfig;
  store: CredentialStore & Pick<BrowserExtensionMethods, 'deleteBrowserExtensionTokens'>;
  getInstitutionByTenantId: (tenantId: string) => Promise<IInstitution | null>;
  parse?: typeof parseText;
  parseDocument?: typeof parseDocument;
}): ExtensionHandlers {
  const parse = deps.parse ?? parseText;
  const parseBuiltIn = deps.parseDocument ?? parseDocument;

  /**
   * The RAG service's text extraction first, then Synapse's built-in document parser, as uploads do. Never raw text:
   * read that way, a PDF or Word file is unreadable bytes.
   */
  const readDocument = async (
    req: ExtensionRequest,
    file: Express.Multer.File,
  ): Promise<string> => {
    try {
      return (await parse({ req, file, file_id: randomUUID(), allowNativeFallback: false })).text;
    } catch (error) {
      logger.warn(
        '[browserExtension] RAG extraction unavailable, using the built-in parser',
        error instanceof Error ? error.message : '',
      );
      return (await parseBuiltIn({ file })).text;
    }
  };

  /** The connect page asks for a code to show; the user types it into the extension. */
  const createCode = async (req: ExtensionRequest, res: Response): Promise<void> => {
    if (!req.user?.id) {
      res.status(401).end();
      return;
    }
    res.json(await issueCode(deps.store, { id: req.user.id, tenantId: req.user.tenantId }));
  };

  const exchange = async (req: ExtensionRequest, res: Response): Promise<void> => {
    const sent = (req.body as { code?: unknown } | undefined)?.code;
    const code = typeof sent === 'string' ? sent : '';
    const result = code ? await exchangeCode(deps.store, code) : null;
    if (!result) {
      res.status(400).json({
        error: { code: 'bad_code', message: 'That code is wrong or has expired. Get a new one.' },
      });
      return;
    }
    res.json(result);
  };

  /** The extension signs out: only its own token ends. */
  const signOut = async (req: ExtensionRequest, res: Response): Promise<void> => {
    if (req.extensionCredentialId)
      await deps.store.deleteBrowserExtensionCredential(req.extensionCredentialId);
    res.status(204).end();
  };

  /** From Synapse itself: signs the user out of every extension. */
  const signOutEverywhere = async (req: ExtensionRequest, res: Response): Promise<void> => {
    if (!req.user?.id) {
      res.status(401).end();
      return;
    }
    const removed = await deps.store.deleteBrowserExtensionTokens(req.user.id);
    res.json({ removed });
  };

  const settings = async (req: ExtensionRequest, res: Response): Promise<void> => {
    const tenantId = req.user?.tenantId;
    const institution = tenantId ? await deps.getInstitutionByTenantId(tenantId) : null;
    res.json({
      enabled: !!institution?.browserControl?.extensionEnabled,
      blockedDomains: institution?.browserControl?.blockedDomains ?? [],
      maxSteps: deps.config().maxSteps,
      contextTokens: deps.config().contextTokens,
      maxOutputTokens: deps.config().maxOutputTokens,
      vision: deps.config().vision,
    });
  };

  /** Reads a PDF, Word or Excel file with Synapse's own extraction. The file and its text are not kept. */
  const extract = async (req: ExtensionRequest, res: Response): Promise<void> => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: { code: 'no_file', message: 'No file was sent.' } });
      return;
    }
    try {
      if (!DOCUMENT_TYPES.test(file.originalname)) {
        res.status(415).json({
          error: {
            code: 'unsupported',
            message: 'Only PDF, Word, Excel and similar documents can be read.',
          },
        });
        return;
      }
      if (!file.mimetype || file.mimetype === 'application/octet-stream') {
        file.mimetype = inferMimeType(file.originalname, file.mimetype) || file.mimetype;
      }
      const text = await readDocument(req, file);
      res.json({
        name: file.originalname,
        text: text.slice(0, MAX_EXTRACT_CHARS),
        truncated: text.length > MAX_EXTRACT_CHARS,
      });
    } catch (error) {
      logger.error(
        '[browserExtension] document not read',
        error instanceof Error ? error.message : '',
      );
      res
        .status(422)
        .json({ error: { code: 'unreadable', message: 'Synapse could not read this document.' } });
    } finally {
      await unlink(file.path).catch(() => undefined);
    }
  };

  return { createCode, exchange, signOut, signOutEverywhere, settings, extract };
}
