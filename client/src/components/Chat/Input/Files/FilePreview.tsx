import { FileIcon } from '@librechat/client';
import type { TFile } from 'librechat-data-provider';
import type { ExtendedFile } from '~/common';
import SourceIcon from './SourceIcon';
import Scan from './Scan';
import { cn } from '~/utils';

const FilePreview = ({
  file,
  fileType,
  className = '',
}: {
  file?: Partial<ExtendedFile | TFile>;
  fileType: {
    paths: React.FC;
    fill: string;
    title: string;
  };
  className?: string;
}) => {
  return (
    <div className={cn('relative size-10 shrink-0 overflow-hidden rounded-xl', className)}>
      <FileIcon file={file} fileType={fileType} />
      <SourceIcon source={file?.source} isCodeFile={!!file?.['metadata']?.fileIdentifier} />
      <Scan
        progress={file?.['progress']}
        uploadProgress={file?.['uploadProgress']}
        stage={file?.['preparationStage']}
      />
    </div>
  );
};

export default FilePreview;
