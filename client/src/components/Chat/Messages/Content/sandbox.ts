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
