const IMAGE_PATTERN = /!\[[^\]]*\]\((?:[^()\s]|\([^()\s]*\))*(?:\s+"[^"]*")?\)/g;
const LINK_PATTERN = /\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"]*")?\)/g;
const DOCUMENT_LINK_PATTERN = /\.(?:pdf|docx?|pptx?|xlsx?|csv|odt|ods|odp)(?:[?#]|$)/i;
const DOCUMENT_HOSTS: ReadonlySet<string> = new Set(['doi.org', 'dx.doi.org']);
const BOILERPLATE_LINE_PATTERN =
  /^\s*(?:skip to (?:main )?content|skip to navigation|(?:back to )?top|loading \\?\[mathjax\\?\].*|[-*+•])\s*$/i;

const isDocumentLink = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return DOCUMENT_HOSTS.has(parsed.hostname) || DOCUMENT_LINK_PATTERN.test(parsed.pathname);
  } catch {
    return false;
  }
};

const replaceLink = (_match: string, text: string, url: string): string => {
  const label = text.trim();
  if (!isDocumentLink(url)) {
    return label;
  }
  return label ? `${label} (${url})` : url;
};

/**
 * Shrinks scraped markdown to the text a model needs: drops images, unwraps links to their
 * text (keeping the URL only for documents and DOIs, which are useful references), removes
 * navigation lines, and collapses blank runs.
 */
export function cleanMarkdown(markdown: string): string {
  const unlinked = markdown.replace(IMAGE_PATTERN, '').replace(LINK_PATTERN, replaceLink);
  const lines: string[] = [];
  let blank = false;
  for (const rawLine of unlinked.split('\n')) {
    const line = rawLine.trimEnd();
    if (BOILERPLATE_LINE_PATTERN.test(line)) {
      continue;
    }
    if (!line.trim()) {
      blank = lines.length > 0;
      continue;
    }
    if (blank) {
      lines.push('');
      blank = false;
    }
    lines.push(line);
  }
  return lines.join('\n');
}
