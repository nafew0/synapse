import { cn } from '@librechat/client';

/** Open box with a star (synapse-open-box-icon.svg), cropped to its drawing so it sits at the size of the lucide icons. */
export function NewIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="14 14 484 484"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn('lc-banner-new-icon', className)}
    >
      <path d="M256 268 118 210a32 32 0 0 0-40 14l-30 52a32 32 0 0 0 13 44l99 52a32 32 0 0 0 43-14l53-90Zm0 0 138-58a32 32 0 0 1 40 14l30 52a32 32 0 0 1-13 44l-99 52a32 32 0 0 1-43-14l-53-90Z" />
      <path d="M96 340v51a48 48 0 0 0 30 44l100 41a80 80 0 0 0 60 0l100-41a48 48 0 0 0 30-44v-51M256 270v211" />
      <path d="m275 44 11 20a16 16 0 0 0 12 8l22 4a19 19 0 0 1 11 32l-16 16a16 16 0 0 0-5 14l4 22a19 19 0 0 1-28 23l-20-10a21 21 0 0 0-20 0l-20 10a19 19 0 0 1-28-23l4-22a16 16 0 0 0-5-14l-16-16a19 19 0 0 1 11-32l22-4a16 16 0 0 0 12-8l11-20a21 21 0 0 1 38 0Z" />
      <path d="M46 66c45 22 74 54 84 89M470 66c-45 22-74 54-84 89" />
      <circle cx="135" cy="37" r="16" fill="currentColor" stroke="none" />
    </svg>
  );
}
