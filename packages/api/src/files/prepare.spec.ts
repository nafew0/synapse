import { EToolResources, defaultAutoPreparation } from 'librechat-data-provider';
import type { PreparationAvailability } from './prepare';
import {
  FileCategory,
  DeliveryMethod,
  planDelivery,
  categorizeFile,
  planExtraction,
  ExtractionMethod,
  planPreparation,
  PreparationLabel,
  shouldEscalateToOcr,
} from './prepare';

const PDF = 'application/pdf';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

const everything: PreparationAvailability = {
  search: true,
  sandbox: true,
  fullText: true,
  ocr: true,
};

const only = (overrides: Partial<PreparationAvailability>): PreparationAvailability => ({
  search: false,
  sandbox: false,
  fullText: false,
  ocr: false,
  ...overrides,
});

describe('categorizeFile', () => {
  it.each([
    ['image/png', FileCategory.image],
    ['image/heic', FileCategory.image],
    ['audio/mpeg', FileCategory.audio],
    ['audio/m4a', FileCategory.audio],
    [XLSX, FileCategory.data],
    ['application/vnd.ms-excel', FileCategory.data],
    ['text/csv', FileCategory.data],
    ['application/json', FileCategory.data],
    ['application/vnd.oasis.opendocument.spreadsheet', FileCategory.data],
    [PDF, FileCategory.document],
    [DOCX, FileCategory.document],
    [PPTX, FileCategory.document],
    ['text/plain', FileCategory.document],
    ['text/markdown', FileCategory.document],
  ])('sorts %s into %s', (mimetype, expected) => {
    expect(categorizeFile(mimetype)).toBe(expected);
  });

  it('routes source files to the sandbox family', () => {
    expect(categorizeFile('application/x-sh')).toBe(FileCategory.data);
  });
});

describe('planExtraction', () => {
  it('never extracts from images', () => {
    expect(planExtraction(FileCategory.image, 'image/png')).toBe(ExtractionMethod.none);
  });

  it('transcribes audio', () => {
    expect(planExtraction(FileCategory.audio, 'audio/mpeg')).toBe(ExtractionMethod.stt);
  });

  it('starts documents on the free parser rather than OCR', () => {
    expect(planExtraction(FileCategory.document, PDF)).toBe(ExtractionMethod.parser);
    expect(planExtraction(FileCategory.document, DOCX)).toBe(ExtractionMethod.parser);
  });

  it('leaves types the parser cannot open alone', () => {
    expect(planExtraction(FileCategory.document, 'text/plain')).toBe(ExtractionMethod.none);
    expect(planExtraction(FileCategory.document, PPTX)).toBe(ExtractionMethod.none);
  });
});

describe('shouldEscalateToOcr', () => {
  const ocrMinCharsPerPage = defaultAutoPreparation.ocrMinCharsPerPage;

  it('escalates when the parser found nothing', () => {
    expect(shouldEscalateToOcr({ text: '', pageCount: 12, ocrMinCharsPerPage })).toBe(true);
    expect(shouldEscalateToOcr({ text: undefined, pageCount: 12, ocrMinCharsPerPage })).toBe(true);
    expect(shouldEscalateToOcr({ text: '   \n  ', pageCount: 12, ocrMinCharsPerPage })).toBe(true);
  });

  it('escalates when pages average less text than the threshold', () => {
    expect(shouldEscalateToOcr({ text: 'x'.repeat(990), pageCount: 10, ocrMinCharsPerPage })).toBe(
      true,
    );
  });

  it('keeps parser output at the threshold', () => {
    expect(shouldEscalateToOcr({ text: 'x'.repeat(1000), pageCount: 10, ocrMinCharsPerPage })).toBe(
      false,
    );
  });

  it('keeps any text when the page count is unknown', () => {
    expect(shouldEscalateToOcr({ text: 'short', ocrMinCharsPerPage })).toBe(false);
    expect(shouldEscalateToOcr({ text: 'short', pageCount: 0, ocrMinCharsPerPage })).toBe(false);
  });
});

describe('planDelivery', () => {
  const config = defaultAutoPreparation;

  it('sends images to vision', () => {
    expect(
      planDelivery({
        category: FileCategory.image,
        textTokens: 0,
        conversationUsedTokens: 0,
        availability: everything,
        config,
      }),
    ).toMatchObject({
      delivery: DeliveryMethod.vision,
      toolResource: undefined,
      label: PreparationLabel.image,
    });
  });

  it('sends data files to the sandbox and only charges the preview to the budget', () => {
    const plan = planDelivery({
      category: FileCategory.data,
      textTokens: 50_000,
      conversationUsedTokens: 0,
      availability: everything,
      config,
    });
    expect(plan.delivery).toBe(DeliveryMethod.sandbox);
    expect(plan.toolResource).toBe(EToolResources.execute_code);
    expect(plan.budgetTokens).toBe(config.previewTokens);
  });

  it('reads a short document in full', () => {
    const plan = planDelivery({
      category: FileCategory.document,
      textTokens: 5_000,
      conversationUsedTokens: 0,
      availability: everything,
      config,
    });
    expect(plan.delivery).toBe(DeliveryMethod.full_text);
    expect(plan.toolResource).toBe(EToolResources.context);
    expect(plan.budgetTokens).toBe(5_000);
    expect(plan.label).toBe(PreparationLabel.read_in_full);
  });

  it('labels a transcript as transcribed', () => {
    expect(
      planDelivery({
        category: FileCategory.audio,
        textTokens: 900,
        conversationUsedTokens: 0,
        availability: everything,
        config,
      }).label,
    ).toBe(PreparationLabel.transcribed);
  });

  it('reads a document sitting exactly on the per-file ceiling', () => {
    expect(
      planDelivery({
        category: FileCategory.document,
        textTokens: config.fullTextTokens,
        conversationUsedTokens: 0,
        availability: everything,
        config,
      }).delivery,
    ).toBe(DeliveryMethod.full_text);
  });

  it('searches a document one token past the per-file ceiling', () => {
    expect(
      planDelivery({
        category: FileCategory.document,
        textTokens: config.fullTextTokens + 1,
        conversationUsedTokens: 0,
        availability: everything,
        config,
      }),
    ).toMatchObject({
      delivery: DeliveryMethod.search,
      toolResource: EToolResources.file_search,
      budgetTokens: 0,
      label: PreparationLabel.searchable,
    });
  });

  it('reads a small document that exactly exhausts the conversation budget', () => {
    expect(
      planDelivery({
        category: FileCategory.document,
        textTokens: 5_000,
        conversationUsedTokens: config.conversationTextTokens - 5_000,
        availability: everything,
        config,
      }).delivery,
    ).toBe(DeliveryMethod.full_text);
  });

  it('searches a small document once the conversation budget is spent', () => {
    expect(
      planDelivery({
        category: FileCategory.document,
        textTokens: 5_000,
        conversationUsedTokens: config.conversationTextTokens - 4_999,
        availability: everything,
        config,
      }).delivery,
    ).toBe(DeliveryMethod.search);
  });

  it('falls back to full text when search is unavailable', () => {
    const plan = planDelivery({
      category: FileCategory.document,
      textTokens: 500_000,
      conversationUsedTokens: 0,
      availability: only({ fullText: true }),
      config,
    });
    expect(plan.delivery).toBe(DeliveryMethod.full_text);
    expect(plan.budgetTokens).toBe(config.fullTextTokens);
  });

  it('falls back to the sandbox when neither text route exists', () => {
    expect(
      planDelivery({
        category: FileCategory.document,
        textTokens: 500_000,
        conversationUsedTokens: 0,
        availability: only({ sandbox: true }),
        config,
      }).delivery,
    ).toBe(DeliveryMethod.sandbox);
  });

  it('falls back to the provider when no tool is available', () => {
    expect(
      planDelivery({
        category: FileCategory.document,
        textTokens: 0,
        conversationUsedTokens: 0,
        availability: only({}),
        config,
      }),
    ).toMatchObject({ delivery: DeliveryMethod.provider, toolResource: undefined });
  });

  it('searches a data file when the sandbox is missing', () => {
    expect(
      planDelivery({
        category: FileCategory.data,
        textTokens: 500_000,
        conversationUsedTokens: 0,
        availability: only({ search: true, fullText: true }),
        config,
      }).delivery,
    ).toBe(DeliveryMethod.search);
  });
});

describe('planPreparation', () => {
  const config = defaultAutoPreparation;

  it('keeps a sandbox copy of a document it reads in full', () => {
    const plan = planPreparation({
      mimetype: DOCX,
      textTokens: 3_000,
      conversationUsedTokens: 0,
      availability: everything,
      config,
    });
    expect(plan.delivery).toBe(DeliveryMethod.full_text);
    expect(plan.sandboxCopy).toBe(true);
    expect(plan.ocrApplied).toBe(false);
  });

  it('does not duplicate a data file that already lives in the sandbox', () => {
    expect(
      planPreparation({
        mimetype: XLSX,
        textTokens: 3_000,
        conversationUsedTokens: 0,
        availability: everything,
        config,
      }).sandboxCopy,
    ).toBe(false);
  });

  it('never copies an image into the sandbox', () => {
    const plan = planPreparation({
      mimetype: 'image/png',
      textTokens: 0,
      conversationUsedTokens: 0,
      availability: everything,
      config,
    });
    expect(plan.sandboxCopy).toBe(false);
    expect(plan.delivery).toBe(DeliveryMethod.vision);
  });

  it('records OCR as the extraction method when text recognition was used', () => {
    const plan = planPreparation({
      mimetype: PDF,
      textTokens: 1_200,
      conversationUsedTokens: 0,
      availability: everything,
      config,
      ocrApplied: true,
    });
    expect(plan.extraction).toBe(ExtractionMethod.ocr);
    expect(plan.ocrApplied).toBe(true);
    expect(plan.delivery).toBe(DeliveryMethod.full_text);
  });

  it('skips the sandbox copy when code execution is unavailable', () => {
    expect(
      planPreparation({
        mimetype: PDF,
        textTokens: 1_200,
        conversationUsedTokens: 0,
        availability: only({ fullText: true, search: true }),
        config,
      }).sandboxCopy,
    ).toBe(false);
  });
});
