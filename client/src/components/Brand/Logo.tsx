import { memo } from 'react';
import { cn } from '~/utils';

/** The Synapse mascot mark; decorative wherever a visible name sits beside it. */
function Logo({ className }: { className?: string }) {
  return (
    <img
      src="/assets/icon_synapse_v1.svg"
      alt=""
      aria-hidden="true"
      draggable={false}
      className={cn('select-none', className)}
    />
  );
}

export default memo(Logo);
