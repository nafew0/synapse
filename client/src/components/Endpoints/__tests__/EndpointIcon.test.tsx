import React from 'react';
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { EModelEndpoint } from 'librechat-data-provider';
import type { Agent, TConversation, TEndpointsConfig } from 'librechat-data-provider';
import EndpointIcon from '../EndpointIcon';

jest.mock('~/components/Endpoints/ConvoIconURL', () => ({
  __esModule: true,
  default: ({
    iconURL,
    modelLabel,
    agentAvatar,
    agentName,
  }: {
    iconURL: string;
    modelLabel?: string;
    agentAvatar?: string;
    agentName?: string;
  }) => (
    <img
      src={iconURL}
      alt={modelLabel || 'Icon'}
      data-testid="convo-url-icon"
      data-agent-avatar={agentAvatar}
      data-agent-name={agentName}
    />
  ),
}));

jest.mock('~/components/Endpoints/MinimalIcon', () => ({
  __esModule: true,
  default: ({ endpoint, iconURL }: { endpoint?: string | null; iconURL?: string }) => (
    <div data-testid="minimal-icon" data-endpoint={endpoint ?? ''} data-icon-url={iconURL ?? ''} />
  ),
}));

jest.mock('~/components/Chat/Menus/Endpoints/components/ModelIcon', () => ({
  getModelBrand: jest.fn((modelId: string) => (modelId.startsWith('openai/') ? 'openai' : null)),
  ModelIcon: ({ modelId }: { modelId: string }) => (
    <div data-testid="model-icon" data-model={modelId} />
  ),
}));

const endpointsConfig = {
  [EModelEndpoint.agents]: { order: 0 },
  [EModelEndpoint.google]: { order: 1 },
} as TEndpointsConfig;

const agent = {
  id: 'agent_123',
  name: 'Research Agent',
  avatar: {
    filepath: '/images/agents/agent_123/avatar.png',
    source: 'local',
  },
} as Agent;

describe('EndpointIcon', () => {
  it('uses the agent avatar when the agents endpoint would otherwise render its default icon', () => {
    const conversation = {
      endpoint: EModelEndpoint.agents,
      agent_id: agent.id,
      iconURL: EModelEndpoint.agents,
    } as TConversation;

    render(
      <EndpointIcon
        conversation={conversation}
        endpointsConfig={endpointsConfig}
        agentsMap={{ [agent.id]: agent }}
      />,
    );

    const icon = screen.getByTestId('convo-url-icon');
    expect(icon).toHaveAttribute('src', '/images/agents/agent_123/avatar.png');
    expect(icon).toHaveAttribute('alt', 'Research Agent');
  });

  it('keeps an explicit model spec icon ahead of the agent avatar', () => {
    const conversation = {
      endpoint: EModelEndpoint.agents,
      agent_id: agent.id,
      spec: 'research-spec',
      iconURL: EModelEndpoint.google,
    } as TConversation;

    render(
      <EndpointIcon
        conversation={conversation}
        endpointsConfig={endpointsConfig}
        agentsMap={{ [agent.id]: agent }}
      />,
    );

    expect(screen.queryByTestId('convo-url-icon')).not.toBeInTheDocument();
    expect(screen.getByTestId('minimal-icon')).toHaveAttribute(
      'data-endpoint',
      EModelEndpoint.google,
    );
  });

  it('uses the model brand instead of an OpenRouter fallback in conversation lists', () => {
    const conversation = {
      endpoint: 'OpenRouter',
      model: 'openai/gpt-5.6-luna',
      iconURL: 'OpenRouter',
    } as unknown as TConversation;

    render(<EndpointIcon conversation={conversation} endpointsConfig={endpointsConfig} />);

    expect(screen.getByTestId('model-icon')).toHaveAttribute('data-model', 'openai/gpt-5.6-luna');
    expect(screen.queryByTestId('minimal-icon')).not.toBeInTheDocument();
  });
});
