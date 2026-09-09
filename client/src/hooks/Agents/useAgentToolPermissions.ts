import { useMemo } from 'react';
import { Tools, EToolResources } from 'librechat-data-provider';
import type { TEphemeralAgent } from 'librechat-data-provider';
import { useGetAgentByIdQuery } from '~/data-provider';
import { useAgentsMapContext } from '~/Providers';
import { isEphemeralAgent } from '~/common';

interface AgentToolPermissionsResult {
  fileSearchAllowedByAgent: boolean;
  codeAllowedByAgent: boolean;
  tools: string[] | undefined;
  provider?: string;
}

/**
 * Hook to determine whether specific tools are allowed for a given agent.
 *
 * @param agentId - The ID of the agent. If null/undefined/empty, checks ephemeralAgent settings
 * @param ephemeralAgent - Optional ephemeral agent settings for tool permissions
 * @returns Object with boolean flags for file_search and execute_code permissions, plus the tools array
 */
export default function useAgentToolPermissions(
  agentId: string | null | undefined,
  ephemeralAgent?: TEphemeralAgent | null,
): AgentToolPermissionsResult {
  const agentsMap = useAgentsMapContext();

  const selectedAgent = useMemo(() => {
    return agentId != null && agentId !== '' ? agentsMap?.[agentId] : undefined;
  }, [agentId, agentsMap]);

  const { data: agentData } = useGetAgentByIdQuery(agentId);

  const tools = useMemo(
    () =>
      (agentData?.tools as string[] | undefined) || (selectedAgent?.tools as string[] | undefined),
    [agentData?.tools, selectedAgent?.tools],
  );

  const provider = useMemo(
    () => agentData?.provider || selectedAgent?.provider,
    [agentData?.provider, selectedAgent?.provider],
  );

  /**
   * An orchestrator holds no tools of its own but hands the file off to whichever
   * specialist it delegates to — codeFilesSession resolves execute_code files across
   * the whole subagent/graph reachability set server-side, and message-attachment
   * uploads are scoped per-user rather than per-agent (see api/server/services/Files/process.js),
   * so the upload only needs *a* code-capable agent downstream, not the selected one itself.
   */
  const subagentsEnabled = useMemo(
    () => (agentData?.subagents ?? selectedAgent?.subagents)?.enabled === true,
    [agentData?.subagents, selectedAgent?.subagents],
  );

  const fileSearchAllowedByAgent = useMemo(() => {
    // Check ephemeral agent settings
    if (isEphemeralAgent(agentId)) {
      return ephemeralAgent?.[EToolResources.file_search] ?? false;
    }
    // If agentId exists but agent not found, disallow
    if (!selectedAgent) return false;
    // Check if the agent has the file_search tool, or delegates to a specialist that might
    return (tools?.includes(Tools.file_search) ?? false) || subagentsEnabled;
  }, [agentId, selectedAgent, tools, ephemeralAgent, subagentsEnabled]);

  const codeAllowedByAgent = useMemo(() => {
    // Check ephemeral agent settings
    if (isEphemeralAgent(agentId)) {
      return ephemeralAgent?.[EToolResources.execute_code] ?? false;
    }
    // If agentId exists but agent not found, disallow
    if (!selectedAgent) return false;
    // Check if the agent has the execute_code tool, or delegates to a specialist that might
    return (tools?.includes(Tools.execute_code) ?? false) || subagentsEnabled;
  }, [agentId, selectedAgent, tools, ephemeralAgent, subagentsEnabled]);

  return {
    fileSearchAllowedByAgent,
    codeAllowedByAgent,
    provider,
    tools,
  };
}
