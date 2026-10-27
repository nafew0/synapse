import React from 'react';
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import type { TConversation, TEndpointsConfig } from 'librechat-data-provider';
import ConvoIcon from '../ConvoIcon';

jest.mock('~/components/Endpoints/ConvoIconURL', () => ({
  __esModule: true,
  default: ({ iconURL }: { iconURL: string }) => <img src={iconURL} alt="custom icon" />,
}));

const endpointsConfig = {
  OpenRouter: { order: 0 },
} as TEndpointsConfig;

describe('ConvoIcon', () => {
  it('shows the selected model brand when the icon falls back to OpenRouter', () => {
    const conversation = {
      endpoint: 'OpenRouter',
      iconURL: 'OpenRouter',
      model: 'deepseek/deepseek-v4-flash-0731',
    } as TConversation;

    const { container } = render(
      <ConvoIcon
        conversation={conversation}
        endpointsConfig={endpointsConfig}
        agentsMap={undefined}
        assistantMap={undefined}
        context="landing"
        size={41}
      />,
    );

    expect(container.querySelector('img')).toHaveAttribute('src', 'assets/deepseek.svg');
  });

  it('preserves an explicit custom image for a recognized model', () => {
    const conversation = {
      endpoint: 'OpenRouter',
      iconURL: 'https://example.com/custom.png',
      model: 'deepseek/deepseek-v4-flash-0731',
    } as TConversation;

    render(
      <ConvoIcon
        conversation={conversation}
        endpointsConfig={endpointsConfig}
        agentsMap={undefined}
        assistantMap={undefined}
      />,
    );

    expect(screen.getByAltText('custom icon')).toHaveAttribute('src', conversation.iconURL);
  });
});
