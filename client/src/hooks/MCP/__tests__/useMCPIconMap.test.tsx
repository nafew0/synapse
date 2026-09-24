import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MCPServersListResponse } from 'librechat-data-provider';
import { useMCPIconMap, useMCPServerNames } from '../useMCPIconMap';

const mockGetMCPServers = jest.fn();
jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: { ...actual.dataService, getMCPServers: () => mockGetMCPServers() },
  };
});

let mockCanUseMcp = false;
jest.mock('~/hooks/Roles/useHasAccess', () => ({
  __esModule: true,
  default: () => mockCanUseMcp,
}));

const servers = {
  'Google Drive': { iconPath: '/icons/drive.svg' },
} as unknown as MCPServersListResponse;

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useMCPIconMap / useMCPServerNames', () => {
  beforeEach(() => {
    mockGetMCPServers.mockReset().mockResolvedValue(servers);
  });

  it('does not request MCP servers for a user without MCP access', async () => {
    mockCanUseMcp = false;

    const { result } = renderHook(() => [useMCPIconMap(), useMCPServerNames()] as const, {
      wrapper: createWrapper(),
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockGetMCPServers).not.toHaveBeenCalled();
    expect(result.current[0].size).toBe(0);
    expect(result.current[1]).toEqual([]);
  });

  it('loads icons and names for a user with MCP access', async () => {
    mockCanUseMcp = true;

    const { result } = renderHook(() => [useMCPIconMap(), useMCPServerNames()] as const, {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current[1]).toHaveLength(1));
    expect(mockGetMCPServers).toHaveBeenCalledTimes(1);
    expect([...result.current[0].values()]).toEqual(['/icons/drive.svg']);
  });
});
