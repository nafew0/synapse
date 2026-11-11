import { memo, useRef } from 'react';
import type { CSSProperties } from 'react';
import type { UploadStageName } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

/** Sending the bytes clears the first half of the blur; each server stage clears more. */
const UPLOAD_SHARE = 0.5;
const MAX_BLUR_PX = 6;
const stageClarity: Record<UploadStageName, number> = {
  uploading: 0,
  reading: 0.55,
  recognizing: 0.7,
  indexing: 0.85,
  ready: 1,
};

/** How sharp the thumbnail should be, from 0 (fully blurred) to 1 (clear). */
export const getClarity = (uploadProgress = 0, stage?: UploadStageName): number =>
  stage != null && stage !== 'uploading' ? stageClarity[stage] : uploadProgress * UPLOAD_SHARE;

/**
 * Sits on an attachment thumbnail while its file uploads: the picture starts blurred and washed
 * out and sharpens as the upload and the server's preparation move on, a scanner beam sweeps it,
 * and a pill shows the share of bytes sent until the server takes over.
 */
function Scan({
  progress,
  uploadProgress,
  stage,
}: {
  /** The attachment's overall progress; the overlay fades out once it reaches 1. */
  progress?: number;
  uploadProgress?: number;
  stage?: UploadStageName;
}) {
  const localize = useLocalize();
  const wasActive = useRef(false);
  const active = typeof progress === 'number' && progress < 1;
  if (active) {
    wasActive.current = true;
  }
  /** Files that were already uploaded never get the overlay; a finished upload keeps it to fade out. */
  if (!active && !wasActive.current) {
    return null;
  }

  const clarity = active ? getClarity(uploadProgress, stage) : 1;
  const sending =
    active &&
    (stage == null || stage === 'uploading') &&
    uploadProgress != null &&
    uploadProgress < 1;
  const percent = sending ? Math.round(uploadProgress * 100) : undefined;
  const filter = `blur(${((1 - clarity) * MAX_BLUR_PX).toFixed(1)}px) saturate(${(0.4 + clarity * 0.6).toFixed(2)})`;
  const style: CSSProperties = { backdropFilter: filter, WebkitBackdropFilter: filter };

  return (
    <div
      role={active ? 'progressbar' : undefined}
      aria-hidden={active ? undefined : true}
      aria-label={active ? localize('com_ui_file_stage_uploading') : undefined}
      aria-valuemin={active ? 0 : undefined}
      aria-valuemax={active ? 100 : undefined}
      aria-valuenow={percent}
      className={cn(
        'pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit] transition-opacity duration-300 motion-reduce:transition-none',
        active ? 'opacity-100' : 'opacity-0',
      )}
    >
      <div
        data-testid="scan-blur"
        className="absolute inset-0 transition-[backdrop-filter] duration-300 motion-reduce:transition-none"
        style={style}
      />
      {active && (
        <div
          data-testid="scan-beam"
          className={cn(
            'absolute inset-x-0 top-0 h-1/3 animate-upload-scan bg-gradient-to-b from-transparent via-white/50 to-transparent mix-blend-screen motion-reduce:animate-none',
            sending && '[animation-duration:0.9s]',
          )}
        >
          <div className="absolute inset-x-0 top-1/2 h-px bg-white/90" />
        </div>
      )}
      {percent != null && (
        <span className="absolute inset-x-0 bottom-1 mx-auto w-max rounded-full bg-black/60 px-1.5 text-[10px] font-semibold tabular-nums leading-[14px] text-white">
          {percent}%
        </span>
      )}
    </div>
  );
}

export default memo(Scan);
