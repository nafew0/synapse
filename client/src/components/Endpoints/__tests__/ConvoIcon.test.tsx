import React from 'react';
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import type { TConversation, TEndpointsConfig, EModelEndpoint } from 'librechat-data-provider';
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
    /** A custom endpoint's name is stored in `endpoint` as-is, outside the enum. */
    const conversation: Partial<TConversation> = {
      endpoint: 'OpenRouter' as EModelEndpoint,
      iconURL: 'OpenRouter',
      model: 'deepseek/deepseek-v4-flash-0731',
    };

    const { container } = render(
      <ConvoIcon
        conversation={conversation as TConversation}
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
    /** A custom endpoint's name is stored in `endpoint` as-is, outside the enum. */
    const conversation: Partial<TConversation> = {
      endpoint: 'OpenRouter' as EModelEndpoint,
      iconURL: 'https://example.com/custom.png',
      model: 'deepseek/deepseek-v4-flash-0731',
    };

    render(
      <ConvoIcon
        conversation={conversation as TConversation}
        endpointsConfig={endpointsConfig}
        agentsMap={undefined}
        assistantMap={undefined}
      />,
    );

    expect(screen.getByAltText('custom icon')).toHaveAttribute('src', conversation.iconURL);
  });
});
