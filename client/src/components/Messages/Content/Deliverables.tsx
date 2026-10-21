import { useMemo } from 'react';
import { Tools } from 'librechat-data-provider';
import type { TAttachment } from 'librechat-data-provider';
import { BACKGROUND_STATUS_ATTACHMENT_TYPE } from '~/components/Chat/Messages/Content/Parts/handle';
import { AttachmentGroup } from '~/components/Chat/Messages/Content/Parts/Attachment';
import { useLocalize } from '~/hooks';

type TFileLike = { filename?: string; filepath?: string; file_id?: string; type?: string };

/**
 * The files a run produced, one per name (the last write wins: a build/fix loop
 * rewrites the same document several times). Memory entries and background-task
 * markers are not files.
 */
export function pickDeliverables(
  attachments?: Array<TAttachment | null | undefined>,
): TAttachment[] {
  const latest = new Map<string, TAttachment>();
  for (const attachment of attachments ?? []) {
    if (!attachment || attachment[Tools.memory] != null) {
      continue;
    }
    const file = attachment as TFileLike;
    if (!file.filepath || file.type === BACKGROUND_STATUS_ATTACHMENT_TYPE) {
      continue;
    }
    latest.delete(file.filename ?? file.file_id ?? file.filepath);
    latest.set(file.filename ?? file.file_id ?? file.filepath, attachment);
  }
  return [...latest.values()];
}

/**
 * Shown under an error that ended a run: the files it had already produced are
 * otherwise spread across (often collapsed) tool cards, so the user would read
 * the error and miss the finished document.
 */
export default function Deliverables({ attachments }: { attachments?: TAttachment[] }) {
  const localize = useLocalize();
  const files = useMemo(() => pickDeliverables(attachments), [attachments]);

  if (files.length === 0) {
    return null;
  }

  return (
    <div className="mt-3" role="group" aria-label={localize('com_error_files_kept')}>
      <p className="mb-1 text-sm text-text-secondary">{localize('com_error_files_kept')}</p>
      <AttachmentGroup attachments={files} />
    </div>
  );
}
