import type { ExtendedFile } from '~/common';
import type { TaskFile } from './useBrowserTask';

/** The extension's own limits, so a file is refused here rather than after the hand-over. */
export const MAX_TASK_FILES = 16;
export const MAX_TASK_FILE_BYTES = 25 * 1024 * 1024;

/** What Synapse can read back as text for the extension: its documents, and plain text. */
const READABLE =
  /\.(pdf|docx?|xlsx?|pptx?|odt|ods|rtf|csv|tsv|txt|md|markdown|json|xml|html?|ya?ml|log)$/i;

const nameOf = (file: ExtendedFile): string => file.filename ?? file.file?.name ?? '';

/**
 * The composer's attachments as the extension takes them: the ids of files that have finished uploading and that
 * Synapse can read as text. Anything else — an image, a still-uploading file, one past the limits — is counted as
 * left behind, so the user is told rather than finding out from a task that read nothing.
 */
export function taskFiles(attached: Map<string, ExtendedFile>): {
  files: TaskFile[];
  skipped: number;
} {
  const files: TaskFile[] = [];
  let skipped = 0;
  for (const file of attached.values()) {
    const name = nameOf(file);
    const ready =
      !!file.file_id &&
      !!name &&
      file.progress === 1 &&
      file.size <= MAX_TASK_FILE_BYTES &&
      READABLE.test(name);
    if (!ready || files.length >= MAX_TASK_FILES) {
      skipped++;
      continue;
    }
    files.push({
      fileId: file.file_id,
      name,
      mimeType: file.type ?? '',
      size: file.size,
    });
  }
  return { files, skipped };
}
