import { EToolResources, AUTO_TOOL_RESOURCE } from 'librechat-data-provider';
import type { UploadRouteContext } from '../files';
import { resolveUploadRoute, AUTO_SEARCH_MIN_BYTES } from '../files';

const PDF = 'application/pdf';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const file = (type: string, name: string, size = 1024): File =>
  ({ name, type, size }) as unknown as File;

const ctx = (overrides: Partial<UploadRouteContext> = {}): UploadRouteContext => ({
  serverPreparesUploads: false,
  fileSearchEnabled: true,
  codeEnabled: true,
  contextEnabled: true,
  fileSearchAllowedByAgent: true,
  codeAllowedByAgent: true,
  ...overrides,
});

describe('resolveUploadRoute', () => {
  describe('when the server prepares uploads', () => {
    const serverCtx = ctx({ serverPreparesUploads: true });

    it('hands every non-image file to the server', () => {
      expect(resolveUploadRoute(file(PDF, 'report.pdf'), serverCtx)).toBe(AUTO_TOOL_RESOURCE);
      expect(resolveUploadRoute(file(XLSX, 'budget.xlsx'), serverCtx)).toBe(AUTO_TOOL_RESOURCE);
      expect(resolveUploadRoute(file('audio/mpeg', 'call.mp3'), serverCtx)).toBe(
        AUTO_TOOL_RESOURCE,
      );
    });

    it('still sends images straight to the model', () => {
      expect(resolveUploadRoute(file('image/png', 'screenshot.png'), serverCtx)).toBeUndefined();
    });
  });

  describe('deciding in the browser', () => {
    it('sends images to the provider', () => {
      expect(resolveUploadRoute(file('image/jpeg', 'photo.jpg'), ctx())).toBeUndefined();
    });

    it('recognizes an image by extension when the browser reports no type', () => {
      expect(resolveUploadRoute(file('', 'photo.heic'), ctx())).toBeUndefined();
    });

    it('sends spreadsheets and data files to the code sandbox', () => {
      expect(resolveUploadRoute(file(XLSX, 'budget.xlsx'), ctx())).toBe(
        EToolResources.execute_code,
      );
      expect(resolveUploadRoute(file('text/csv', 'rows.csv'), ctx())).toBe(
        EToolResources.execute_code,
      );
      expect(resolveUploadRoute(file('application/json', 'data.json'), ctx())).toBe(
        EToolResources.execute_code,
      );
    });

    it('reads documents as text', () => {
      expect(resolveUploadRoute(file(PDF, 'letter.pdf'), ctx())).toBe(EToolResources.context);
      expect(resolveUploadRoute(file(DOCX, 'memo.docx'), ctx())).toBe(EToolResources.context);
      expect(resolveUploadRoute(file('audio/mpeg', 'call.mp3'), ctx())).toBe(
        EToolResources.context,
      );
    });

    it('searches a large text-based document', () => {
      expect(resolveUploadRoute(file(DOCX, 'thesis.docx', AUTO_SEARCH_MIN_BYTES + 1), ctx())).toBe(
        EToolResources.file_search,
      );
    });

    it('keeps a large PDF on the text route, where OCR lives', () => {
      expect(resolveUploadRoute(file(PDF, 'scan.pdf', AUTO_SEARCH_MIN_BYTES * 20), ctx())).toBe(
        EToolResources.context,
      );
    });

    it('reads a document sitting exactly on the search threshold in full', () => {
      expect(resolveUploadRoute(file(DOCX, 'memo.docx', AUTO_SEARCH_MIN_BYTES), ctx())).toBe(
        EToolResources.context,
      );
    });
  });

  describe('falling back when a tool is missing', () => {
    it('reads a spreadsheet as text when there is no sandbox', () => {
      expect(resolveUploadRoute(file(XLSX, 'budget.xlsx'), ctx({ codeEnabled: false }))).toBe(
        EToolResources.context,
      );
    });

    it('honors an agent that was not given code execution', () => {
      expect(
        resolveUploadRoute(file(XLSX, 'budget.xlsx'), ctx({ codeAllowedByAgent: false })),
      ).toBe(EToolResources.context);
    });

    it('searches a document when reading text is disabled', () => {
      expect(resolveUploadRoute(file(DOCX, 'memo.docx'), ctx({ contextEnabled: false }))).toBe(
        EToolResources.file_search,
      );
    });

    it('falls back to the sandbox when neither text route exists', () => {
      expect(
        resolveUploadRoute(
          file(DOCX, 'memo.docx'),
          ctx({ contextEnabled: false, fileSearchEnabled: false }),
        ),
      ).toBe(EToolResources.execute_code);
    });

    it('falls back to the provider when no tool is available', () => {
      expect(
        resolveUploadRoute(
          file(DOCX, 'memo.docx'),
          ctx({ contextEnabled: false, fileSearchEnabled: false, codeEnabled: false }),
        ),
      ).toBeUndefined();
    });

    it('never searches a type retrieval cannot index', () => {
      expect(
        resolveUploadRoute(
          file('application/zip', 'bundle.zip', AUTO_SEARCH_MIN_BYTES * 5),
          ctx({ contextEnabled: false }),
        ),
      ).toBe(EToolResources.execute_code);
    });
  });

  it('routes a mixed selection per file rather than as a batch', () => {
    const selection = [file('image/png', 'chart.png'), file(XLSX, 'data.xlsx'), file(PDF, 'a.pdf')];
    expect(selection.map((entry) => resolveUploadRoute(entry, ctx()))).toEqual([
      undefined,
      EToolResources.execute_code,
      EToolResources.context,
    ]);
  });
});
