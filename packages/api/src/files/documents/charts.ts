import JSZip from 'jszip';

const CHART_PART = /^ppt\/charts\/chart\d+\.xml$/;
const CHART_OPEN = /<c:chart(?=[\s>])[^>]*>/;
const CHART_TITLE = /^\s*<c:title>[\s\S]*?<\/c:title>/;
const TITLE_DELETED = /<c:autoTitleDeleted\s+val="(?:1|true)"\s*\/>/;
const TITLE_TEXT = /<a:t>\s*[^<\s][^<]*<\/a:t>/;

/** A single-space rich-text title: pptx-preview renders it as nothing. */
const BLANK_TITLE =
  '<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t> </a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>';

/**
 * Give a chart a blank title when PowerPoint would show none.
 *
 * pptx-preview 1.0.7 ignores `c:autoTitleDeleted` and labels every bar or
 * line chart without rich title text "图表标题" ("Chart Title"), so untitled
 * pptxgenjs charts read as Chinese in the chat preview. Returns the XML
 * unchanged when the chart has a visible title of its own.
 */
export function blankHiddenChartTitle(xml: string): string {
  const open = CHART_OPEN.exec(xml);
  if (!open) {
    return xml;
  }
  const start = open.index + open[0].length;
  const rest = xml.slice(start);
  const title = CHART_TITLE.exec(rest);
  const visible = title != null && TITLE_TEXT.test(title[0]) && !TITLE_DELETED.test(rest);
  if (visible) {
    return xml;
  }
  const body = title ? rest.slice(title[0].length) : rest;
  return xml.slice(0, start) + BLANK_TITLE + body;
}

/**
 * Copy of a .pptx for the pptx-preview renderer, with titles PowerPoint
 * hides blanked out. Returns the original buffer when no chart changes.
 * The delivered file is never touched; this only feeds the preview.
 */
export async function previewChartTitles(buffer: Buffer): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buffer);
  const parts = Object.keys(zip.files).filter((name) => CHART_PART.test(name));
  if (parts.length === 0) {
    return buffer;
  }
  const edits = await Promise.all(
    parts.map(async (name) => {
      const xml = (await zip.file(name)?.async('string')) ?? '';
      const next = blankHiddenChartTitle(xml);
      return next === xml ? null : { name, next };
    }),
  );
  const changed = edits.filter((edit): edit is { name: string; next: string } => edit != null);
  if (changed.length === 0) {
    return buffer;
  }
  for (const { name, next } of changed) {
    zip.file(name, next);
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
