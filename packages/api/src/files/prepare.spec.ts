import { EToolResources, defaultAutoPreparation } from 'librechat-data-provider';
import type { PreparationAvailability } from './prepare';
import {
  FileCategory,
  DeliveryMethod,
  planDelivery,
  categorizeFile,
  planExtraction,
  hasSandboxCopy,
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

  /**
   * `planPreparation` always tells `planDelivery` whether the file will also be in the sandbox, so
   * the tests derive it the same way. Passing `availability.sandbox` while claiming no copy would
   * exercise a combination the pipeline never produces.
   */
  const plan = (params: Parameters<typeof planDelivery>[0]) =>
    planDelivery({
      ...params,
      sandboxCopy: params.sandboxCopy ?? hasSandboxCopy(params.category, params.availability),
    });

  it('sends images to vision', () => {
    expect(
      plan({
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
    const result = plan({
      category: FileCategory.data,
      textTokens: 50_000,
      conversationUsedTokens: 0,
      availability: everything,
      config,
    });
    expect(result.delivery).toBe(DeliveryMethod.sandbox);
    expect(result.toolResource).toBe(EToolResources.execute_code);
    expect(result.budgetTokens).toBe(config.previewTokens);
  });

  it('reads a short document in full', () => {
    const result = plan({
      category: FileCategory.document,
      textTokens: 5_000,
      conversationUsedTokens: 0,
      availability: only({ fullText: true }),
      config,
    });
    expect(result.delivery).toBe(DeliveryMethod.full_text);
    expect(result.toolResource).toBe(EToolResources.context);
    expect(result.budgetTokens).toBe(5_000);
    expect(result.label).toBe(PreparationLabel.read_in_full);
  });

  it('calls a document the user can edit ready for editing, however its text travels', () => {
    /**
     * The chip answers "what can I do with this file", not "which route did its words take".
     * Someone who uploaded an order to change a line reads "Read in full" as a refusal.
     */
    const short = plan({
      category: FileCategory.document,
      textTokens: 5_000,
      conversationUsedTokens: 0,
      availability: everything,
      config,
    });
    expect(short.delivery).toBe(DeliveryMethod.full_text);
    expect(short.label).toBe(PreparationLabel.sandbox);

    const long = plan({
      category: FileCategory.document,
      textTokens: 50_000,
      conversationUsedTokens: 0,
      availability: everything,
      config,
    });
    expect(long.delivery).toBe(DeliveryMethod.search);
    expect(long.label).toBe(PreparationLabel.sandbox);
  });

  it('stops reading an editable document in full past its own ceiling', () => {
    /** Its text is re-sent every turn while the same bytes already sit in the sandbox. */
    const fits = plan({
      category: FileCategory.document,
      textTokens: config.editableFullTextTokens,
      conversationUsedTokens: 0,
      availability: everything,
      config,
    });
    expect(fits.delivery).toBe(DeliveryMethod.full_text);

    const past = plan({
      category: FileCategory.document,
      textTokens: config.editableFullTextTokens + 1,
      conversationUsedTokens: 0,
      availability: everything,
      config,
    });
    expect(past.delivery).not.toBe(DeliveryMethod.full_text);
  });

  it('previews an oversized editable document rather than truncating it into the conversation', () => {
    const result = plan({
      category: FileCategory.document,
      textTokens: 500_000,
      conversationUsedTokens: 0,
      availability: only({ fullText: true, sandbox: true }),
      config,
    });
    expect(result.delivery).toBe(DeliveryMethod.sandbox);
    expect(result.toolResource).toBe(EToolResources.execute_code);
    expect(result.budgetTokens).toBe(config.previewTokens);
  });

  it('keeps the higher ceiling for a document that is not editable', () => {
    expect(
      plan({
        category: FileCategory.document,
        textTokens: config.fullTextTokens,
        conversationUsedTokens: 0,
        availability: only({ fullText: true, search: true }),
        config,
      }).delivery,
    ).toBe(DeliveryMethod.full_text);
  });

  it('labels a transcript as transcribed', () => {
    expect(
      plan({
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
      plan({
        category: FileCategory.document,
        textTokens: config.fullTextTokens,
        conversationUsedTokens: 0,
        availability: only({ fullText: true, search: true }),
        config,
      }).delivery,
    ).toBe(DeliveryMethod.full_text);
  });

  it('searches a document one token past the per-file ceiling', () => {
    expect(
      plan({
        category: FileCategory.document,
        textTokens: config.fullTextTokens + 1,
        conversationUsedTokens: 0,
        availability: only({ fullText: true, search: true }),
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
      plan({
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
      plan({
        category: FileCategory.document,
        textTokens: 5_000,
        conversationUsedTokens: config.conversationTextTokens - 4_999,
        availability: everything,
        config,
      }).delivery,
    ).toBe(DeliveryMethod.search);
  });

  it('falls back to full text when search is unavailable', () => {
    const result = plan({
      category: FileCategory.document,
      textTokens: 500_000,
      conversationUsedTokens: 0,
      availability: only({ fullText: true }),
      config,
    });
    expect(result.delivery).toBe(DeliveryMethod.full_text);
    expect(result.budgetTokens).toBe(config.fullTextTokens);
  });

  it('falls back to the sandbox when neither text route exists', () => {
    expect(
      plan({
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
      plan({
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
      plan({
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

  it('tells the user an uploaded document is ready to edit', () => {
    /** The complaint this answers: a .docx uploaded to be edited was chipped "Read in full". */
    const plan = planPreparation({
      mimetype: DOCX,
      textTokens: 3_000,
      conversationUsedTokens: 0,
      availability: everything,
      config,
    });
    expect(plan.label).toBe(PreparationLabel.sandbox);
    expect(plan.sandboxCopy).toBe(true);
  });

  it('says the same thing for a deck and a spreadsheet', () => {
    for (const mimetype of [PPTX, XLSX]) {
      expect(
        planPreparation({
          mimetype,
          textTokens: 3_000,
          conversationUsedTokens: 0,
          availability: everything,
          config,
        }).label,
      ).toBe(PreparationLabel.sandbox);
    }
  });

  it('still calls a document read in full when the chat cannot edit it', () => {
    expect(
      planPreparation({
        mimetype: DOCX,
        textTokens: 3_000,
        conversationUsedTokens: 0,
        availability: only({ fullText: true }),
        config,
      }).label,
    ).toBe(PreparationLabel.read_in_full);
  });

  it('keeps a transcript labelled as one even though the audio reaches the sandbox', () => {
    const plan = planPreparation({
      mimetype: 'audio/mpeg',
      textTokens: 900,
      conversationUsedTokens: 0,
      availability: everything,
      config,
    });
    expect(plan.label).toBe(PreparationLabel.transcribed);
    expect(plan.sandboxCopy).toBe(true);
  });

  it('previews a long document instead of charging it to every turn', () => {
    const plan = planPreparation({
      mimetype: DOCX,
      textTokens: 50_000,
      conversationUsedTokens: 0,
      availability: only({ fullText: true, sandbox: true }),
      config,
    });
    expect(plan.delivery).toBe(DeliveryMethod.sandbox);
    expect(plan.budgetTokens).toBe(config.previewTokens);
    /** The delivery is the sandbox, so there is nothing to copy a second time. */
    expect(plan.sandboxCopy).toBe(false);
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
