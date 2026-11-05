import { memo } from 'react';
import type { SVGProps, FC } from 'react';

type Shape =
  | { kind: 'path'; d: string; accent?: boolean }
  | { kind: 'circle'; cx: number; cy: number; r: number; accent?: boolean; filled?: boolean }
  | { kind: 'rect'; x: number; y: number; width: number; height: number; rx: number };

export type BrandIcon = FC<SVGProps<SVGSVGElement>>;

function shapeClass(shape: Shape): string | undefined {
  if (shape.kind === 'rect' || !shape.accent) {
    return undefined;
  }
  if (shape.kind === 'circle' && shape.filled) {
    return 'lc-icon-accent-fill';
  }
  return 'lc-icon-accent';
}

function renderShape(shape: Shape, index: number) {
  const className = shapeClass(shape);
  if (shape.kind === 'path') {
    return <path key={index} d={shape.d} className={className} />;
  }
  if (shape.kind === 'circle') {
    return <circle key={index} cx={shape.cx} cy={shape.cy} r={shape.r} className={className} />;
  }
  return (
    <rect
      key={index}
      x={shape.x}
      y={shape.y}
      width={shape.width}
      height={shape.height}
      rx={shape.rx}
    />
  );
}

/**
 * Synapse icons share one 24px grid and a 1.75 rounded stroke; each carries a
 * single accent stroke (the mascot's orange ear) that `lc-icon-accent` colours.
 */
function createIcon(displayName: string, shapes: Shape[]): BrandIcon {
  const Icon: BrandIcon = ({ className, ...props }) => (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      {...props}
    >
      {shapes.map(renderShape)}
    </svg>
  );
  Icon.displayName = displayName;
  return memo(Icon);
}

export const NewChatIcon = createIcon('NewChatIcon', [
  { kind: 'path', d: 'M12 20H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v5' },
  { kind: 'path', d: 'M18 15v6M15 18h6', accent: true },
]);

export const ChatsIcon = createIcon('ChatsIcon', [
  {
    kind: 'path',
    d: 'M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H10l-4 3.5V16a2 2 0 0 1-2-2Z',
  },
  { kind: 'circle', cx: 9, cy: 10, r: 1.2, accent: true, filled: true },
  { kind: 'circle', cx: 12.5, cy: 10, r: 0.6 },
  { kind: 'circle', cx: 15.5, cy: 10, r: 0.6 },
]);

export const SkillsIcon = createIcon('SkillsIcon', [
  { kind: 'path', d: 'M12 3.5 14 8l4.5.5-3.4 3 1 4.5L12 13.7 7.9 16l1-4.5-3.4-3L10 8Z' },
  { kind: 'path', d: 'M6 20.5h12', accent: true },
]);

export const PromptsIcon = createIcon('PromptsIcon', [
  { kind: 'rect', x: 4, y: 4, width: 16, height: 16, rx: 3 },
  { kind: 'path', d: 'm8 10 2.5 2L8 14' },
  { kind: 'path', d: 'M13 14.5h3.5', accent: true },
]);

export const MemoryIcon = createIcon('MemoryIcon', [
  {
    kind: 'path',
    d: 'M12 4.5a5 5 0 0 0-5 5c0 1.8.9 3 2 4 .7.6 1 1.4 1 2.2v.8h4v-.8c0-.8.3-1.6 1-2.2 1.1-1 2-2.2 2-4a5 5 0 0 0-5-5Z',
  },
  { kind: 'path', d: 'M10 19.5h4' },
  { kind: 'path', d: 'M12 7.5v3l1.5 1', accent: true },
]);

export const FilesIcon = createIcon('FilesIcon', [
  {
    kind: 'path',
    d: 'M4 7.5A2.5 2.5 0 0 1 6.5 5H10l2 2h5.5A2.5 2.5 0 0 1 20 9.5v7a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5Z',
  },
  { kind: 'path', d: 'M9 13.5h6', accent: true },
]);

export const InsightsIcon = createIcon('InsightsIcon', [
  { kind: 'path', d: 'M4 20h16' },
  { kind: 'path', d: 'M7 16.5v-4M12 16.5V7' },
  { kind: 'path', d: 'M17 16.5v-7', accent: true },
]);

export const PanelIcon = createIcon('PanelIcon', [
  { kind: 'rect', x: 3.5, y: 4.5, width: 17, height: 15, rx: 2.5 },
  { kind: 'path', d: 'M9.5 4.5v15' },
  { kind: 'path', d: 'M13.5 10l2 2-2 2', accent: true },
]);

export const ScanIcon = createIcon('ScanIcon', [
  {
    kind: 'path',
    d: 'M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2',
  },
  { kind: 'path', d: 'M8.5 9h7M8.5 15h4' },
  { kind: 'path', d: 'M4 12h16', accent: true },
]);

export const LetterIcon = createIcon('LetterIcon', [
  {
    kind: 'path',
    d: 'M14 3.5H7.5A2.5 2.5 0 0 0 5 6v12a2.5 2.5 0 0 0 2.5 2.5h9A2.5 2.5 0 0 0 19 18V8.5Z',
  },
  { kind: 'path', d: 'M14 3.5v5h5M8.5 13h7M8.5 16.5h4' },
  { kind: 'path', d: 'm15.5 19.5 3-3', accent: true },
]);

export const SlidesIcon = createIcon('SlidesIcon', [
  { kind: 'rect', x: 3.5, y: 4.5, width: 17, height: 11.5, rx: 2 },
  { kind: 'path', d: 'M12 16v3.5M8.5 19.5h7' },
  { kind: 'path', d: 'M8 12.5 10.5 10l2 1.5L16 8', accent: true },
]);

export const SheetIcon = createIcon('SheetIcon', [
  { kind: 'rect', x: 4, y: 4, width: 16, height: 16, rx: 2.5 },
  { kind: 'path', d: 'M4 9.5h16M10 9.5V20' },
  { kind: 'path', d: 'M13 15h4', accent: true },
]);
