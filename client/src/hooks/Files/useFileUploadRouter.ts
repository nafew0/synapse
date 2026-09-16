import { useCallback } from 'react';
import { useSetRecoilState } from 'recoil';
import { Constants, EToolResources } from 'librechat-data-provider';
import type { UploadLifecycleCallbacks } from './useFileHandling';
import { useChatContext } from '~/Providers/ChatContext';
import { PER_FILE_UPLOAD_ROUTE } from '~/utils';
import { ephemeralAgentByConvoId } from '~/store';
import useFileHandling from './useFileHandling';
import useUploadRoute from './useUploadRoute';

/**
 * Returns a function that attaches files to a chosen upload destination, enabling the
 * matching ephemeral-agent capability first (file search is left for explicit opt-in to
 * preserve legacy behavior). Shared by the paste, drag, and modal flows. Resolves to
 * whether the files were accepted, so callers can gate success messaging on it.
 */
export default function useFileUploadRouter() {
  const { handleFiles } = useFileHandling();
  const { conversation } = useChatContext();
  const { routeContext } = useUploadRoute(conversation);
  const setEphemeralAgent = useSetRecoilState(
    ephemeralAgentByConvoId(conversation?.conversationId ?? Constants.NEW_CONVO),
  );

  return useCallback(
    (files: File[], toolResource?: string, uploadLifecycle?: UploadLifecycleCallbacks) => {
      /** A per-file batch can land on either tool, so both are opted into up front. */
      if (toolResource === PER_FILE_UPLOAD_ROUTE) {
        setEphemeralAgent((prev) => ({
          ...prev,
          ...(routeContext.codeEnabled && routeContext.codeAllowedByAgent
            ? { [EToolResources.execute_code]: true }
            : {}),
          ...(routeContext.fileSearchEnabled && routeContext.fileSearchAllowedByAgent
            ? { [EToolResources.file_search]: true }
            : {}),
        }));
      } else if (toolResource && toolResource !== EToolResources.file_search) {
        setEphemeralAgent((prev) => ({
          ...prev,
          [toolResource]: true,
        }));
      }
      return handleFiles(files, toolResource, uploadLifecycle);
    },
    [handleFiles, setEphemeralAgent, routeContext],
  );
}
