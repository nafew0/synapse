import { useCallback, useMemo } from 'react';
import { Tools, isEphemeralAgentId, defaultAgentCapabilities } from 'librechat-data-provider';
import type { TConversation } from 'librechat-data-provider';
import type { UploadRoute, UploadRouteContext } from '~/utils';
import { useGetAgentByIdQuery, useGetStartupConfig } from '~/data-provider';
import useAgentCapabilities from '~/hooks/Agents/useAgentCapabilities';
import useGetAgentsConfig from '~/hooks/Agents/useGetAgentsConfig';
import { resolveUploadRoute } from '~/utils';

/**
 * Resolves where each attached file should go when the user picked "Upload file" rather than a
 * destination. Returns a per-file resolver plus the tools a chat can reach, so callers can turn
 * on the matching ephemeral capabilities before the upload starts.
 *
 * The agent's tools are read straight from its query rather than through
 * `useAgentToolPermissions`, which reaches the agents-map context and, with it, most of the app's
 * component tree — too heavy a dependency for the upload pipeline.
 */
export default function useUploadRoute(conversation?: TConversation | null) {
  const agentId = conversation?.agent_id;
  const { agentsConfig } = useGetAgentsConfig();
  const { data: startupConfig } = useGetStartupConfig();
  const { data: agent } = useGetAgentByIdQuery(agentId);
  const capabilities = useAgentCapabilities(agentsConfig?.capabilities ?? defaultAgentCapabilities);

  /** Tools are offerable unless a saved agent omits them; ephemeral chats opt in on upload. */
  const isSavedAgent = agentId != null && agentId !== '' && !isEphemeralAgentId(agentId);
  const tools = agent?.tools as string[] | undefined;

  const routeContext = useMemo<UploadRouteContext>(
    () => ({
      serverPreparesUploads: startupConfig?.autoFilePreparationEnabled === true,
      fileSearchEnabled: capabilities.fileSearchEnabled,
      codeEnabled: capabilities.codeEnabled,
      contextEnabled: capabilities.contextEnabled,
      fileSearchAllowedByAgent: !isSavedAgent || (tools?.includes(Tools.file_search) ?? false),
      codeAllowedByAgent: !isSavedAgent || (tools?.includes(Tools.execute_code) ?? false),
    }),
    [
      tools,
      isSavedAgent,
      capabilities.codeEnabled,
      capabilities.contextEnabled,
      capabilities.fileSearchEnabled,
      startupConfig?.autoFilePreparationEnabled,
    ],
  );

  const resolveRoute = useCallback(
    (file: File): UploadRoute => resolveUploadRoute(file, routeContext),
    [routeContext],
  );

  return { resolveRoute, routeContext };
}
