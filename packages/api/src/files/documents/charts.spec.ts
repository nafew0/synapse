import JSZip from 'jszip';
import { blankHiddenChartTitle, previewChartTitles } from './charts';

const SPACE = '<c:chartSpace xmlns:c="c" xmlns:a="a">';
const PLOT = '<c:plotArea><c:layout/><c:barChart><c:barDir val="col"/></c:barChart></c:plotArea>';
const titled = (text: string) =>
  `<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></c:rich></c:tx></c:title>`;

/** pptxgenjs output for a chart without `title`: no title, auto title deleted. */
const UNTITLED = `${SPACE}<c:chart><c:autoTitleDeleted val="1"/>${PLOT}</c:chart></c:chartSpace>`;
const TITLED = `${SPACE}<c:chart>${titled('New posts per phase')}<c:autoTitleDeleted val="0"/>${PLOT}</c:chart></c:chartSpace>`;

const chartTitleText = (xml: string): string => {
  const title = /<c:chart>\s*<c:title>([\s\S]*?)<\/c:title>/.exec(xml);
  return title ? [...title[1].matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join('') : '';
};

const deck = async (charts: Record<string, string>): Promise<Buffer> => {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types/>');
  zip.file('ppt/slides/slide1.xml', '<p:sld/>');
  for (const [name, xml] of Object.entries(charts)) {
    zip.file(name, xml);
  }
  return zip.generateAsync({ type: 'nodebuffer' });
};

describe('blankHiddenChartTitle', () => {
  it('adds a blank title before autoTitleDeleted when the chart has none', () => {
    const out = blankHiddenChartTitle(UNTITLED);
    expect(out).toContain('<c:chart><c:title>');
    expect(out.indexOf('<c:title>')).toBeLessThan(out.indexOf('<c:autoTitleDeleted'));
    expect(chartTitleText(out)).toBe(' ');
  });

  it('keeps a visible title', () => {
    expect(blankHiddenChartTitle(TITLED)).toBe(TITLED);
  });

  it('blanks a title PowerPoint hides with autoTitleDeleted', () => {
    const hidden = TITLED.replace('val="0"', 'val="1"');
    const out = blankHiddenChartTitle(hidden);
    expect(chartTitleText(out)).toBe(' ');
    expect(out.match(/<c:title>/g)).toHaveLength(1);
  });

  it('blanks a title with no text runs', () => {
    const empty = TITLED.replace('New posts per phase', '');
    expect(chartTitleText(blankHiddenChartTitle(empty))).toBe(' ');
  });

  it('leaves axis titles alone', () => {
    const axis = `<c:valAx>${titled('Posts')}</c:valAx>`;
    const xml = UNTITLED.replace('</c:plotArea>', `${axis}</c:plotArea>`);
    const out = blankHiddenChartTitle(xml);
    expect(out).toContain(axis);
    expect(out.match(/<c:title>/g)).toHaveLength(2);
  });

  it('ignores XML without a chart element', () => {
    expect(blankHiddenChartTitle('<p:sld/>')).toBe('<p:sld/>');
  });
});

describe('previewChartTitles', () => {
  it('rewrites only the untitled charts', async () => {
    const input = await deck({
      'ppt/charts/chart1.xml': UNTITLED,
      'ppt/charts/chart2.xml': TITLED,
    });
    const zip = await JSZip.loadAsync(await previewChartTitles(input));
    const chart1 = await zip.file('ppt/charts/chart1.xml')?.async('string');
    const chart2 = await zip.file('ppt/charts/chart2.xml')?.async('string');
    expect(chartTitleText(chart1 ?? '')).toBe(' ');
    expect(chart2).toBe(TITLED);
    expect(await zip.file('ppt/slides/slide1.xml')?.async('string')).toBe('<p:sld/>');
  });

  it('returns the same buffer when nothing changes', async () => {
    const titledDeck = await deck({ 'ppt/charts/chart1.xml': TITLED });
    expect(await previewChartTitles(titledDeck)).toBe(titledDeck);
    const noCharts = await deck({});
    expect(await previewChartTitles(noCharts)).toBe(noCharts);
  });
});
