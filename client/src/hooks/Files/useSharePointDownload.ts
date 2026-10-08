import { useCallback, useState } from 'react';
import { useToastContext } from '@librechat/client';
import type { SharePointFile, SharePointBatchProgress } from '~/data-provider/Files';
import { getErrorInfo, getErrorMessage, recordError } from '~/utils/errors';
import { useSharePointBatchDownload } from '~/data-provider/Files';
import useLocalize from '~/hooks/useLocalize';
import useSharePointToken from './useSharePointToken';

interface UseSharePointDownloadProps {
  onFilesDownloaded?: (files: File[]) => void | Promise<void>;
  onError?: (error: Error) => void;
}

interface UseSharePointDownloadReturn {
  downloadSharePointFiles: (files: SharePointFile[]) => Promise<File[]>;
  isDownloading: boolean;
  downloadProgress: SharePointBatchProgress | null;
  error: string | null;
}

export default function useSharePointDownload({
  onFilesDownloaded,
  onError,
}: UseSharePointDownloadProps = {}): UseSharePointDownloadReturn {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const [downloadProgress, setDownloadProgress] = useState<SharePointBatchProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { token, refetch: refetchToken } = useSharePointToken({
    enabled: false,
    purpose: 'Download',
  });

  const batchDownloadMutation = useSharePointBatchDownload();

  const downloadSharePointFiles = useCallback(
    async (files: SharePointFile[]): Promise<File[]> => {
      if (!files || files.length === 0) {
        throw new Error('No files provided for download');
      }

      setError(null);
      setDownloadProgress({ completed: 0, total: files.length, failed: [] });

      try {
        let accessToken = token?.access_token;
        if (!accessToken) {
          showToast({
            message: localize('com_files_sharepoint_token_loading'),
            status: 'info',
            duration: 2000,
          });

          const tokenResult = await refetchToken();
          accessToken = tokenResult.data?.access_token;

          if (!accessToken) {
            throw new Error('Failed to obtain SharePoint access token');
          }
        }

        showToast({
          message: localize('com_files_sharepoint_downloading', { 0: files.length }),
          status: 'info',
          duration: 3000,
        });

        const downloadedFiles = await batchDownloadMutation.mutateAsync({
          files,
          accessToken,
          onProgress: (progress) => {
            setDownloadProgress(progress);

            if (files.length > 5 && progress.completed % 3 === 0) {
              showToast({
                message: localize('com_files_sharepoint_download_progress', {
                  0: progress.completed,
                  1: progress.total,
                }),
                status: 'info',
                duration: 1000,
              });
            }
          },
        });

        if (downloadedFiles.length > 0) {
          const failedCount = files.length - downloadedFiles.length;
          const successMessage =
            failedCount > 0
              ? localize('com_files_sharepoint_download_partial', {
                  0: downloadedFiles.length,
                  1: files.length,
                  2: failedCount,
                })
              : localize('com_files_sharepoint_download_success', { 0: downloadedFiles.length });

          showToast({
            message: successMessage,
            status: failedCount > 0 ? 'warning' : 'success',
            duration: 4000,
          });

          if (onFilesDownloaded) {
            await onFilesDownloaded(downloadedFiles);
          }
        }

        setDownloadProgress(null);
        return downloadedFiles;
      } catch (error) {
        const errorMessage = getErrorMessage(
          error,
          localize,
          'com_files_sharepoint_download_error',
        );
        setError(errorMessage);
        recordError(getErrorInfo(error));

        showToast({
          message: errorMessage,
          status: 'error',
          duration: 5000,
        });

        if (onError) {
          onError(error instanceof Error ? error : new Error(errorMessage));
        }

        setDownloadProgress(null);
        throw error;
      }
    },
    [token, localize, showToast, batchDownloadMutation, onFilesDownloaded, onError, refetchToken],
  );

  return {
    downloadSharePointFiles,
    isDownloading: batchDownloadMutation.isLoading,
    downloadProgress,
    error,
  };
}
