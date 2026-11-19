import { createContext, useContext } from 'react';
import type { HTMLAttributes } from 'react';
import { cn } from '~/utils';

/** True inside a compact activity block, where steps sit in one dense timeline. */
export const DenseStepsContext = createContext(false);

export const useDenseSteps = (): boolean => useContext(DenseStepsContext);

/** The one-line status row every tool step renders, tighter inside an activity block. */
export default function StepRow({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  const dense = useDenseSteps();
  return (
    <div
      className={cn(
        'relative flex h-5 shrink-0 items-center gap-2.5',
        dense ? 'my-0.5' : 'my-1.5',
        className,
      )}
      {...props}
    />
  );
}
