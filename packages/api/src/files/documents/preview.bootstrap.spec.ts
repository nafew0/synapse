import JSZip from 'jszip';
import { JSDOM } from 'jsdom';
import { _internal } from './html';

/**
 * The renderer bootstraps ship as inline scripts inside the generated preview
 * documents, so nothing in the module graph can call them. These tests lift the
 * bootstrap out of the produced HTML and run it against a DOM that reproduces
 * what the real CDN library builds — which is the part that actually broke:
 * both bootstraps were written against a DOM shape the libraries do not emit,
 * and every string assertion in `html.spec.ts` passed throughout.
 */
function inlineBootstrap(html: string): string {
  const open = html.lastIndexOf('<script>');
  const close = html.lastIndexOf('</script>');
  return html.slice(open + '<script>'.length, close);
}

/**
 * The PPTX bootstrap arms an 8s fallback timer that would otherwise hold the
 * jest worker open, so every window this file opens is closed afterwards.
 */
const open: JSDOM[] = [];
function openDom(bodyHtml: string): JSDOM {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${bodyHtml}</body></html>`, {
    runScripts: 'outside-only',
  });
  open.push(dom);
  return dom;
}
afterEach(() => {
  while (open.length > 0) {
    open.pop()?.window.close();
  }
});

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const SLOT = `
<div id="lc-render"><div class="lc-pptx-loading">Loading…</div></div>
<div id="lc-fallback" hidden>
  <p id="lc-fallback-notice">notice</p>
  <div id="lc-fallback-reason"></div>
</div>
<script id="lc-doc-data" type="application/octet-stream;base64">AAAA</script>`;

describe('PPTX preview bootstrap', () => {
  const buildPptx = async (slideCount: number): Promise<Buffer> => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types/>');
    for (let i = 1; i <= slideCount; i++) {
      zip.file(
        `ppt/slides/slide${i}.xml`,
        `<p:sld xmlns:a="x"><a:p><a:t>Slide ${i}</a:t></a:p></p:sld>`,
      );
    }
    return zip.generateAsync({ type: 'nodebuffer' });
  };

  /**
   * pptx-preview 1.0.7 creates ONE host div sized to the init dimensions with
   * `overflow-y: auto` and stacks every slide inside it. It does not put slides
   * at the container's top level.
   */
  function stubRenderer(doc: Document, slideCount: number) {
    return {
      init(container: HTMLElement) {
        return {
          preview() {
            const host = doc.createElement('div');
            host.className = 'pptx-preview-wrapper';
            for (let i = 0; i < slideCount; i++) {
              const slide = doc.createElement('div');
              slide.className = `pptx-preview-slide-wrapper pptx-preview-slide-wrapper-${i}`;
              slide.appendChild(doc.createElement('span')).textContent = `slide ${i}`;
              host.appendChild(slide);
            }
            container.appendChild(host);
            return Promise.resolve({ slides: new Array(slideCount).fill({}) });
          },
        };
      },
    };
  }

  async function render(slideCount: number): Promise<Document> {
    const html = await _internal.pptxToHtmlViaCdn(await buildPptx(slideCount), '<ol></ol>');
    const dom = openDom(SLOT);
    const doc = dom.window.document;
    (dom.window as unknown as Record<string, unknown>).pptxPreview = stubRenderer(doc, slideCount);
    dom.window.eval(inlineBootstrap(html));
    await flush();
    return doc;
  }

  it('gives every slide its own wrap, not just the first', async () => {
    /**
     * The bug: the bootstrap wrapped the container's CHILDREN, and the only
     * child is the renderer's host. That wrap was sized to one slide and had
     * `overflow: hidden`, so slide 1 rendered and every later slide sat below
     * the fold of a scroll box whose scrollbar had been clipped away — an
     * unreachable deck that looked like a one-slide preview.
     */
    const doc = await render(3);

    expect(doc.querySelectorAll('.lc-slide-wrap')).toHaveLength(3);
    for (const wrap of Array.from(doc.querySelectorAll('.lc-slide-wrap'))) {
      expect(wrap.firstElementChild?.className).toContain('pptx-preview-slide-wrapper');
    }
  });

  it('keeps the slides in order and drops the emptied host', async () => {
    const doc = await render(3);
    const slot = doc.getElementById('lc-render') as HTMLElement;

    expect(Array.from(slot.children).map((child) => child.className)).toEqual([
      'lc-slide-wrap',
      'lc-slide-wrap',
      'lc-slide-wrap',
    ]);
    /* The host is a black, fixed-size scroll box; leaving it behind paints a
     * black band under the deck. */
    expect(doc.querySelectorAll('.pptx-preview-wrapper')).toHaveLength(0);
  });

  it('does not fall back when the renderer produced slides', async () => {
    const doc = await render(2);

    expect((doc.getElementById('lc-fallback') as HTMLElement).hidden).toBe(true);
    expect((doc.getElementById('lc-render') as HTMLElement).style.visibility).toBe('visible');
  });

  it('falls back when the renderer produced nothing', async () => {
    const html = await _internal.pptxToHtmlViaCdn(await buildPptx(1), '<ol></ol>');
    const dom = openDom(SLOT);
    (dom.window as unknown as Record<string, unknown>).pptxPreview = {
      init: () => ({ preview: () => Promise.resolve({ slides: [] }) }),
    };
    dom.window.eval(inlineBootstrap(html));
    await flush();

    expect((dom.window.document.getElementById('lc-fallback') as HTMLElement).hidden).toBe(false);
  });
});

describe('DOCX preview bootstrap', () => {
  async function render(pageCount: number): Promise<Document> {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types/>');
    zip.file('word/document.xml', '<w:document/>');
    const docx = await zip.generateAsync({ type: 'nodebuffer' });
    const html = await _internal.wordDocToHtmlViaCdn(docx, '<p>fallback</p>');

    const dom = openDom(SLOT);
    const doc = dom.window.document;
    (dom.window as unknown as Record<string, unknown>).docx = {
      /** docx-preview nests one `section.docx` per page inside `.docx-wrapper`. */
      renderAsync(_buf: unknown, container: HTMLElement) {
        const wrapper = doc.createElement('div');
        wrapper.className = 'docx-wrapper';
        for (let i = 0; i < pageCount; i++) {
          const page = doc.createElement('section');
          page.className = 'docx';
          page.textContent = `page ${i}`;
          wrapper.appendChild(page);
        }
        container.appendChild(wrapper);
        return Promise.resolve();
      },
    };
    dom.window.eval(inlineBootstrap(html));
    await flush();
    return doc;
  }

  it('wraps every page so each one can be scaled as a page', async () => {
    /**
     * Pages used to be forced to `width: 100% !important; padding: 0`, which
     * discarded the page size and the page margins: an A4 office order came
     * out as one unbroken column of edge-to-edge text with no page breaks.
     */
    const doc = await render(2);

    expect(doc.querySelectorAll('.lc-page-wrap')).toHaveLength(2);
    for (const wrap of Array.from(doc.querySelectorAll('.lc-page-wrap'))) {
      expect(wrap.firstElementChild?.tagName).toBe('SECTION');
      expect((wrap as HTMLElement).style.width).not.toBe('');
      expect((wrap.firstElementChild as HTMLElement).style.transform).toMatch(/^scale\(/);
    }
  });

  it('keeps the wraps inside the renderer wrapper, in page order', async () => {
    const doc = await render(3);
    const wrapper = doc.querySelector('.docx-wrapper') as HTMLElement;

    expect(Array.from(wrapper.children).map((child) => child.className)).toEqual([
      'lc-page-wrap',
      'lc-page-wrap',
      'lc-page-wrap',
    ]);
    expect(
      Array.from(wrapper.querySelectorAll('section.docx')).map((page) => page.textContent),
    ).toEqual(['page 0', 'page 1', 'page 2']);
  });

  it('caches native page size so a resize never measures a scaled box', async () => {
    const doc = await render(1);
    const page = doc.querySelector('section.docx') as HTMLElement;

    expect(page.dataset.lcNativeW).toBeDefined();
    expect(page.dataset.lcNativeH).toBeDefined();
  });
});
