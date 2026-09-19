import { SANDBOX_WORKING_DIR, isSandboxDirkeep, isSandboxWorkingFile } from './working';

describe('isSandboxWorkingFile', () => {
  /**
   * codeapi reports a generated file by its destination relative to /mnt/data,
   * always `/`-separated. A deliverable is written at the top; working material
   * goes in a directory of its own.
   */
  it('treats anything in a subdirectory as working material', () => {
    expect(isSandboxWorkingFile('qa/slide-01.jpg')).toBe(true);
    expect(isSandboxWorkingFile('qa/stage1/deck.pdf')).toBe(true);
    /* The run that forced this rule: a deck unzipped into `work/` and `work2/`
     * shipped twenty-seven slide XML parts to the user, because the instruction
     * named renders and unzipping is not rendering. */
    expect(isSandboxWorkingFile('work/ppt/slides/slide1.xml')).toBe(true);
    expect(isSandboxWorkingFile('work2/_Content_Types_-69a22a.xml')).toBe(true);
    expect(isSandboxWorkingFile('renderqa/slide-10.jpg')).toBe(true);
    expect(isSandboxWorkingFile('unpacked/ppt/theme/theme1.xml')).toBe(true);
  });

  it('delivers what the tools write at the top level', () => {
    expect(isSandboxWorkingFile('deck.pptx')).toBe(false);
    expect(isSandboxWorkingFile('report.docx')).toBe(false);
    expect(isSandboxWorkingFile('sit_well_work_well.pptx')).toBe(false);
    expect(isSandboxWorkingFile('budget.xlsx')).toBe(false);
    /* A montage the model insists on writing beside the deck is still a
     * deliverable by this rule — the directory decides, not the name. */
    expect(isSandboxWorkingFile('qa_montage.jpg')).toBe(false);
  });

  it('is safe on a missing or non-string name', () => {
    expect(isSandboxWorkingFile(undefined)).toBe(false);
    expect(isSandboxWorkingFile(null)).toBe(false);
    expect(isSandboxWorkingFile(42)).toBe(false);
  });

  it('names the directory the skills use by convention', () => {
    expect(SANDBOX_WORKING_DIR).toBe('qa');
  });
});

describe('isSandboxDirkeep', () => {
  /**
   * Unzipping a pptx leaves empty directories, and codeapi marks each with a
   * zero-byte `.dirkeep`. Persisting those re-injected a sentinel whose
   * download answers 403, which failed seven executions of an edit turn.
   */
  it('matches the marker wherever it sits', () => {
    expect(isSandboxDirkeep('.dirkeep')).toBe(true);
    expect(isSandboxDirkeep('qa/unpacked/ppt/media/.dirkeep')).toBe(true);
    expect(isSandboxDirkeep('qa/unpacked/ppt/charts/_rels/.dirkeep')).toBe(true);
  });

  it('leaves real files alone, including lookalikes', () => {
    expect(isSandboxDirkeep('deck.pptx')).toBe(false);
    expect(isSandboxDirkeep('qa/slide-1.jpg')).toBe(false);
    expect(isSandboxDirkeep('.dirkeeper')).toBe(false);
    expect(isSandboxDirkeep('my.dirkeep')).toBe(false);
    expect(isSandboxDirkeep('dirkeep')).toBe(false);
  });

  it('is safe on a missing name', () => {
    expect(isSandboxDirkeep(undefined)).toBe(false);
    expect(isSandboxDirkeep(null)).toBe(false);
  });
});
