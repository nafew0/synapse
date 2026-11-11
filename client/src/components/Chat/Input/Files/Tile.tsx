import { memo } from 'react';
import {
  HoverCard,
  TooltipAnchor,
  HoverCardPortal,
  HoverCardTrigger,
  HoverCardContent,
} from '@librechat/client';
import type { ExtendedFile } from '~/common';
import { usePreparationLabel } from './PreparationStatus';
import useThumbnail from '~/hooks/Files/useThumbnail';
import { getFileType, cn } from '~/utils';
import SourceIcon from './SourceIcon';
import RemoveFile from './RemoveFile';
import Scan from './Scan';

const MAX_EXTENSION_LENGTH = 4;

/** "report.final.PDF" → "PDF"; nothing for names without a short extension. */
export const getExtension = (filename?: string): string => {
  const dot = filename?.lastIndexOf('.') ?? -1;
  if (filename == null || dot <= 0 || dot === filename.length - 1) {
    return '';
  }
  const extension = filename.slice(dot + 1);
  return extension.length > MAX_EXTENSION_LENGTH ? '' : extension.toUpperCase();
};

/**
 * A non-image attachment drawn as a square tile the size of an image preview, so a row of mixed
 * attachments reads as one set. The name and status move to the tooltip and the accessible name;
 * the tile itself shows the first page (or the file-type icon when there is no page picture), its
 * extension, and the upload overlay. Hovering or focusing a tile with a page shows it larger.
 */
function Tile({ file, onDelete }: { file: ExtendedFile; onDelete: () => void }) {
  const fileType = getFileType(file.type);
  const status = usePreparationLabel(file, fileType.title);
  const name = file.filename ?? file.file?.name ?? '';
  const description = name ? `${name} · ${status}` : status;
  const extension = getExtension(name);
  const uploading = file.progress < 1;
  const thumbnail = useThumbnail(file);

  const face = (
    <div className="relative size-14 overflow-hidden rounded-xl">
      {thumbnail ? (
        <img
          src={thumbnail}
          alt=""
          draggable={false}
          className="absolute inset-0 size-full object-cover object-left-top"
        />
      ) : (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 36 36"
          fill="none"
          className="absolute inset-0 size-full"
          aria-hidden="true"
        >
          <rect width="36" height="36" fill={fileType.fill} />
          <g transform="translate(0 -3)">
            <fileType.paths />
          </g>
        </svg>
      )}
      {extension && !uploading && (
        <span
          aria-hidden="true"
          className={cn(
            'absolute bottom-1 text-[10px] font-semibold leading-[14px] tracking-wide text-white',
            thumbnail != null
              ? 'left-1 rounded-full bg-black/60 px-1.5'
              : 'inset-x-0 mx-auto w-max',
          )}
        >
          {extension}
        </span>
      )}
      <SourceIcon source={file.source} isCodeFile={!!file.metadata?.fileIdentifier} />
      <Scan
        progress={file.progress}
        uploadProgress={file.uploadProgress}
        stage={file.preparationStage}
      />
    </div>
  );

  return (
    <div className="group relative inline-block text-sm text-text-secondary">
      <div className="relative overflow-hidden rounded-2xl border border-border-medium">
        {thumbnail ? (
          <HoverCard openDelay={250} closeDelay={80}>
            <HoverCardTrigger
              asChild
              role="group"
              aria-label={description}
              tabIndex={0}
              className="outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-border-xheavy"
            >
              {face}
            </HoverCardTrigger>
            <HoverCardPortal>
              <HoverCardContent
                side="top"
                collisionPadding={8}
                className="w-auto p-2"
                data-testid="tile-preview"
              >
                <img
                  src={thumbnail}
                  alt=""
                  draggable={false}
                  className="max-h-64 w-60 rounded-lg border border-border-light object-cover object-left-top"
                />
                <p className="mt-1.5 w-60 truncate text-xs font-medium text-text-primary">{name}</p>
                <p className="w-60 truncate text-xs text-text-secondary">{status}</p>
              </HoverCardContent>
            </HoverCardPortal>
          </HoverCard>
        ) : (
          <TooltipAnchor
            description={description}
            aria-label={description}
            role="group"
            render={face}
          />
        )}
      </div>
      <RemoveFile onRemove={onDelete} />
    </div>
  );
}

export default memo(Tile);
