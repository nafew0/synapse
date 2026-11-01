import { defaultUrlTransform } from 'react-markdown';
import type { TAttachment } from 'librechat-data-provider';
import { displayFilename } from './Parts/attachmentTypes';

const SANDBOX_HREF_PATTERN = /^(?:sandbox:|file:\/\/)?\/?mnt\/data\/(.+)$|^sandbox:\/?(.+)$/i;

const leafOf = (path: string): string => {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? path : path.slice(slash + 1);
};

const decode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/**
 * File name a model-authored sandbox link points at (`sandbox:/mnt/data/report.docx`,
 * `/mnt/data/report.docx`), or `null` when the href is not a sandbox path.
 */
export const sandboxFilename = (href: string | undefined): string | null => {
  const match = href?.trim().match(SANDBOX_HREF_PATTERN);
  const path = match?.[1] ?? match?.[2];
  if (!path) {
    return null;
  }
  return leafOf(decode(path.split(/[?#]/)[0]));
};

/**
 * Code spans and fenced blocks (kept as written), link targets (`](`, resolved by the link
 * renderer), or a bare sandbox path. A path ends before whitespace, brackets, quotes and the
 * sentence punctuation that follows it, Bangla `।` included.
 */
const SANDBOX_TEXT_PATTERN =
  /(```[\s\S]*?```|`[^`\n]*`)|(\]\()?(?<![\w/])(?:sandbox:)?\/mnt\/data\/([^\s()[\]`'"<>]*[^\s()[\]`'"<>.,;:!?।])/g;

/**
 * Shows a sandbox path the model wrote into its reply (`/mnt/data/qa/report.docx`) as the bare
 * file name. The path means nothing to the user, and the file itself is attached to the reply.
 */
export const hideSandboxPaths = (content: string): string => {
  if (!content.includes('/mnt/data/')) {
    return content;
  }
  return content.replace(
    SANDBOX_TEXT_PATTERN,
    (match: string, code?: string, linkTarget?: string, path?: string) =>
      code != null || linkTarget != null || path == null ? match : leafOf(path),
  );
};

/** Keeps `sandbox:` hrefs, which react-markdown would otherwise blank out, so links to generated files can resolve. */
export const urlTransform = (url: string): string =>
  sandboxFilename(url) != null ? url : defaultUrlTransform(url);

export const findSandboxAttachment = (
  attachments: TAttachment[] | undefined,
  filename: string,
): TAttachment | undefined =>
  attachments?.find((attachment) => {
    const name = attachment.filename;
    return !!name && (leafOf(name) === filename || leafOf(displayFilename(name)) === filename);
  });
