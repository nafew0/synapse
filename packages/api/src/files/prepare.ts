import {
  EToolResources,
  excelMimeTypes,
  audioMimeTypes,
  codeInterpreterMimeTypes,
  documentParserMimeTypes,
} from 'librechat-data-provider';
import type { AutoPreparationConfig, RegexLike } from 'librechat-data-provider';

/** What the uploaded bytes are, before anything has been extracted from them. */
export enum FileCategory {
  /** Photos and screenshots: the model looks at them directly. */
  image = 'image',
  /** Spreadsheets, CSV, JSON and source files: analysed with code, not read as prose. */
  data = 'data',
  /** Speech: turned into a transcript first. */
  audio = 'audio',
  /** PDFs, Word, PowerPoint, plain text: read as prose. */
  document = 'document',
}

/** How the file's text is obtained. OCR is *extraction*; it is not a delivery decision. */
export enum ExtractionMethod {
  /** Nothing to extract; the bytes themselves go to the model or the sandbox. */
  none = 'none',
  /** The free built-in parser (pdfjs, mammoth, xlsx, odt). */
  parser = 'parser',
  /** A paid per-page OCR service, used only when the parser found too little text. */
  ocr = 'ocr',
  /** Speech-to-text. */
  stt = 'stt',
}

/** How the extracted text reaches the model. */
export enum DeliveryMethod {
  /** The whole text is placed in the conversation. */
  full_text = 'full_text',
  /** The text is embedded and searched with the `file_search` tool. */
  search = 'search',
  /** The bytes live in the code sandbox and are opened by generated code. */
  sandbox = 'sandbox',
  /** The image is sent to the model as vision. */
  vision = 'vision',
  /** The provider reads the original file natively (last resort for unreadable PDFs). */
  provider = 'provider',
}

/** Which destinations this chat can actually use, so a missing tool degrades instead of failing. */
export interface PreparationAvailability {
  /** `file_search` is enabled for the chat and a RAG API is configured. */
  search: boolean;
  /** `execute_code` is enabled for the chat. */
  sandbox: boolean;
  /** `context` (text in the conversation) is enabled for the chat. */
  fullText: boolean;
  /** A configured OCR service is available for this MIME type. */
  ocr: boolean;
}

/** The chip label shown on the attachment once preparation finishes. */
export enum PreparationLabel {
  read_in_full = 'read_in_full',
  searchable = 'searchable',
  sandbox = 'sandbox',
  image = 'image',
  transcribed = 'transcribed',
  provider = 'provider',
}

export interface DeliveryPlan {
  delivery: DeliveryMethod;
  /** The `tool_resource` the prepared file is stored under; `undefined` is the native provider path. */
  toolResource?: EToolResources;
  /** Tokens this file adds to the conversation's shared full-text budget. */
  budgetTokens: number;
  label: PreparationLabel;
}

export interface PreparationPlan extends DeliveryPlan {
  category: FileCategory;
  extraction: ExtractionMethod;
  /** A second copy in the code sandbox, so the model can edit the file instead of retyping it. */
  sandboxCopy: boolean;
  /** Text recognition was used, which the chip surfaces so users can tell OCR output apart. */
  ocrApplied: boolean;
}

/** Tabular and structured types that are computed on rather than read, plus their text forms. */
const tabularMimeTypes =
  /^(text\/(csv|tab-separated-values)|application\/(csv|json|vnd\.oasis\.opendocument\.spreadsheet|x-parquet|vnd\.apache\.parquet))$/;

/** Prose the model reads end to end: PDFs, Word, PowerPoint, OpenDocument text, ebooks. */
const proseMimeTypes =
  /^application\/(pdf|msword|epub\+zip|rtf|vnd\.ms-(word|powerpoint)|vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|presentationml\.(presentation|template))|vnd\.oasis\.opendocument\.(text|presentation))$/;

const matches = (mimetype: string, patterns: RegexLike[]): boolean =>
  patterns.some((pattern) => pattern.test(mimetype));

/**
 * Sorts an upload into one of the four handling families. Order matters: spreadsheets and CSV
 * are document-parser eligible but belong in the sandbox, where their rows can be computed on
 * rather than flattened into prose.
 */
export function categorizeFile(mimetype: string): FileCategory {
  if (mimetype.startsWith('image/')) {
    return FileCategory.image;
  }
  if (audioMimeTypes.test(mimetype)) {
    return FileCategory.audio;
  }
  if (excelMimeTypes.test(mimetype) || tabularMimeTypes.test(mimetype)) {
    return FileCategory.data;
  }
  if (proseMimeTypes.test(mimetype)) {
    return FileCategory.document;
  }
  if (mimetype === 'text/plain' || mimetype === 'text/markdown') {
    return FileCategory.document;
  }
  if (matches(mimetype, codeInterpreterMimeTypes)) {
    return FileCategory.data;
  }
  return FileCategory.document;
}

/** Whether the built-in parser can read this type without a paid OCR call. */
export function isParserEligible(mimetype: string): boolean {
  return matches(mimetype, documentParserMimeTypes);
}

/**
 * Chooses the first extraction attempt. PDFs and Office files always start with the free
 * parser; OCR is reserved for what the parser could not read, which reverses the historical
 * order where a configured OCR ran on every matching file.
 */
export function planExtraction(category: FileCategory, mimetype: string): ExtractionMethod {
  if (category === FileCategory.image) {
    return ExtractionMethod.none;
  }
  if (category === FileCategory.audio) {
    return ExtractionMethod.stt;
  }
  return isParserEligible(mimetype) ? ExtractionMethod.parser : ExtractionMethod.none;
}

/**
 * Decides whether parser output is thin enough to be a scan. A PDF whose pages carry almost no
 * text layer is the case OCR exists for; a PDF with prose on every page is not, however long it is.
 */
export function shouldEscalateToOcr({
  text,
  pageCount,
  ocrMinCharsPerPage,
}: {
  text: string | undefined;
  pageCount?: number;
  ocrMinCharsPerPage: number;
}): boolean {
  const trimmed = text?.trim() ?? '';
  if (trimmed.length === 0) {
    return true;
  }
  if (!pageCount || pageCount < 1) {
    return false;
  }
  return trimmed.length / pageCount < ocrMinCharsPerPage;
}

/** Whether this upload also gets a copy in the sandbox, which is what makes it editable. */
export function hasSandboxCopy(category: FileCategory, availability: PreparationAvailability): boolean {
  return availability.sandbox && category !== FileCategory.image;
}

/**
 * Chooses how the extracted text reaches the model. Full text is used only while it fits both
 * the per-file ceiling and what the conversation has left, so a handful of individually small
 * documents cannot quietly become a large payload re-sent on every turn.
 *
 * A document that is also in the sandbox has a lower ceiling of its own. Its text would otherwise
 * be re-sent on every turn while the same bytes already sit in the sandbox, and past a certain
 * size that duplication costs more than it buys: the model can open the file instead.
 */
export function planDelivery({
  category,
  textTokens,
  conversationUsedTokens,
  availability,
  config,
  sandboxCopy = false,
}: {
  category: FileCategory;
  /** Tokens in the extracted text; `0` when nothing was extracted. */
  textTokens: number;
  /** Full-text tokens already committed by earlier documents in this conversation. */
  conversationUsedTokens: number;
  availability: PreparationAvailability;
  config: AutoPreparationConfig;
  /** Whether a copy of this file will also be mounted in the sandbox. */
  sandboxCopy?: boolean;
}): DeliveryPlan {
  if (category === FileCategory.image) {
    return {
      delivery: DeliveryMethod.vision,
      toolResource: undefined,
      budgetTokens: 0,
      label: PreparationLabel.image,
    };
  }

  if (category === FileCategory.data && availability.sandbox) {
    return {
      delivery: DeliveryMethod.sandbox,
      toolResource: EToolResources.execute_code,
      budgetTokens: Math.min(textTokens, config.previewTokens),
      label: PreparationLabel.sandbox,
    };
  }

  /**
   * An office document the user can edit. The chip says so whatever the text does, because what
   * matters to someone who uploaded a file to change it is that they can, not which route its
   * words took to the model.
   */
  const editable = sandboxCopy && category === FileCategory.document;
  const fullTextCeiling = editable
    ? Math.min(config.fullTextTokens, config.editableFullTextTokens)
    : config.fullTextTokens;

  const fitsInFullText =
    textTokens > 0 &&
    textTokens <= fullTextCeiling &&
    conversationUsedTokens + textTokens <= config.conversationTextTokens;

  if (availability.fullText && fitsInFullText) {
    return {
      delivery: DeliveryMethod.full_text,
      toolResource: EToolResources.context,
      budgetTokens: textTokens,
      label: editable
        ? PreparationLabel.sandbox
        : category === FileCategory.audio
          ? PreparationLabel.transcribed
          : PreparationLabel.read_in_full,
    };
  }

  if (availability.search) {
    return {
      delivery: DeliveryMethod.search,
      toolResource: EToolResources.file_search,
      budgetTokens: 0,
      label: editable ? PreparationLabel.sandbox : PreparationLabel.searchable,
    };
  }

  /**
   * Too long to read in full, with no retrieval to fall back on. The sandbox already holds the
   * file, so the model gets a preview and opens the rest itself rather than a truncated copy of
   * the text charged to every turn.
   */
  if (editable) {
    return {
      delivery: DeliveryMethod.sandbox,
      toolResource: EToolResources.execute_code,
      budgetTokens: Math.min(textTokens, config.previewTokens),
      label: PreparationLabel.sandbox,
    };
  }

  /** Nothing else is reachable: keep the text, truncated downstream by `fileTokenLimit`. */
  if (availability.fullText && textTokens > 0) {
    return {
      delivery: DeliveryMethod.full_text,
      toolResource: EToolResources.context,
      budgetTokens: Math.min(textTokens, config.fullTextTokens),
      label:
        category === FileCategory.audio
          ? PreparationLabel.transcribed
          : PreparationLabel.read_in_full,
    };
  }

  if (availability.sandbox) {
    return {
      delivery: DeliveryMethod.sandbox,
      toolResource: EToolResources.execute_code,
      budgetTokens: 0,
      label: PreparationLabel.sandbox,
    };
  }

  return {
    delivery: DeliveryMethod.provider,
    toolResource: undefined,
    budgetTokens: 0,
    label: PreparationLabel.provider,
  };
}

/**
 * The whole plan for one upload: what it is, how its text was obtained, and where that text goes.
 * Extraction has already happened when this is called, so `textTokens` and `ocrApplied` describe
 * the real result rather than a prediction.
 */
export function planPreparation({
  mimetype,
  textTokens,
  conversationUsedTokens,
  availability,
  config,
  ocrApplied = false,
}: {
  mimetype: string;
  textTokens: number;
  conversationUsedTokens: number;
  availability: PreparationAvailability;
  config: AutoPreparationConfig;
  ocrApplied?: boolean;
}): PreparationPlan {
  const category = categorizeFile(mimetype);
  const sandboxCopy = hasSandboxCopy(category, availability);
  const delivery = planDelivery({
    category,
    textTokens,
    conversationUsedTokens,
    availability,
    config,
    sandboxCopy,
  });

  return {
    ...delivery,
    category,
    extraction: ocrApplied ? ExtractionMethod.ocr : planExtraction(category, mimetype),
    /** Editing works by opening the file in the sandbox, never by re-typing it through context. */
    sandboxCopy: sandboxCopy && delivery.delivery !== DeliveryMethod.sandbox,
    ocrApplied,
  };
}
