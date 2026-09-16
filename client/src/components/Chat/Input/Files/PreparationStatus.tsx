import React from 'react';
import type { TranslationKeys } from '~/hooks';
import type { ExtendedFile } from '~/common';
import { useLocalize } from '~/hooks';

/**
 * Stage shown while the server is still preparing the file. Ordered the way a user sees them:
 * the bytes arrive, the text is read, a scan is recognised, a long document is indexed.
 */
const stageLabels: Record<string, TranslationKeys> = {
  uploading: 'com_ui_file_stage_uploading',
  reading: 'com_ui_file_stage_reading',
  recognizing: 'com_ui_file_stage_recognizing',
  indexing: 'com_ui_file_stage_indexing',
  ready: 'com_ui_file_stage_ready',
};

/** How the finished file reaches the model, in the plainest words that stay accurate. */
const deliveryLabels: Record<string, TranslationKeys> = {
  read_in_full: 'com_ui_file_read_in_full',
  searchable: 'com_ui_file_searchable',
  sandbox: 'com_ui_file_ready_for_analysis',
  image: 'com_ui_file_image',
  transcribed: 'com_ui_file_transcribed',
  provider: 'com_ui_file_read_in_full',
};

/**
 * The one line of status on an attachment chip: what is happening to the file while it uploads,
 * and how the model will read it once it is ready. Files attached without automatic preparation
 * fall back to the chip's usual file-type subtitle.
 */
const PreparationStatus = ({
  file,
  fallback,
}: {
  file: Partial<ExtendedFile>;
  /** The chip's default subtitle, shown when the file carries no preparation of its own. */
  fallback: string;
}) => {
  const localize = useLocalize();
  const preparation = file.metadata?.preparation;

  if ((file.progress ?? 1) < 1) {
    const stageKey = stageLabels[file.preparationStage ?? 'uploading'];
    return (
      <div className="truncate text-text-secondary">
        {localize(stageKey ?? 'com_ui_file_stage_uploading')}
      </div>
    );
  }

  const deliveryKey = preparation?.label != null ? deliveryLabels[preparation.label] : undefined;
  if (!deliveryKey) {
    return (
      <div className="truncate text-text-secondary" title={fallback}>
        {fallback}
      </div>
    );
  }

  const label = localize(deliveryKey);
  const suffix = preparation?.ocrApplied === true ? ` · ${localize('com_ui_file_recognized')}` : '';

  return (
    <div className="truncate text-text-secondary" title={`${label}${suffix}`}>
      {label}
      {suffix}
    </div>
  );
};

export default React.memo(PreparationStatus);
