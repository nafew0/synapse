import { useCallback } from 'react';
import { useSetRecoilState } from 'recoil';
import { Constants, EToolResources } from 'librechat-data-provider';
import type { UploadLifecycleCallbacks } from './useFileHandling';
import { useChatContext } from '~/Providers/ChatContext';
import { PER_FILE_UPLOAD_ROUTE } from '~/utils';
import { ephemeralAgentByConvoId } from '~/store';
import useFileHandling from './useFileHandling';

/**
 * Returns a function that attaches files to a chosen upload destination. Picking a destination
 * explicitly still enables the matching ephemeral-agent capability (file search is left for
 * explicit opt-in to preserve legacy behavior); a per-file batch enables nothing, because what an
 * assistant can reach is declared by its model spec or its agent record. Shared by the paste,
 * drag, and modal flows. Resolves to whether the files were accepted, so callers can gate success
 * messaging on it.
 */
export default function useFileUploadRouter() {
  const { handleFiles } = useFileHandling();
  const { conversation } = useChatContext();
  const setEphemeralAgent = useSetRecoilState(
    ephemeralAgentByConvoId(conversation?.conversationId ?? Constants.NEW_CONVO),
  );

  return useCallback(
    (files: File[], toolResource?: string, uploadLifecycle?: UploadLifecycleCallbacks) => {
      /** A per-file batch enables nothing: what an assistant can reach is declared by its model
       * spec or its agent record, not switched on by attaching a file. */
      if (
        toolResource !== PER_FILE_UPLOAD_ROUTE &&
        toolResource &&
        toolResource !== EToolResources.file_search
      ) {
        setEphemeralAgent((prev) => ({
          ...prev,
          [toolResource]: true,
        }));
      }
      return handleFiles(files, toolResource, uploadLifecycle);
    },
    [handleFiles, setEphemeralAgent],
  );
}
