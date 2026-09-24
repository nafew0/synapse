import { render, screen } from '@testing-library/react';
import { ModelIcon, getModelBrand } from '../ModelIcon';

jest.mock('@lobehub/icons', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const createIcon = (brand: string) => {
    const Avatar = ({ size }: { size: number }) =>
      React.createElement('svg', { 'data-testid': `${brand}-icon`, width: size });
    return { Avatar };
  };

  return {
    Anthropic: createIcon('anthropic'),
    Gemini: createIcon('google'),
    OpenAI: createIcon('openai'),
  };
});

describe('getModelBrand', () => {
  it.each([
    ['gpt-4.1', 'custom', 'openai'],
    ['openai/o3', 'openrouter', 'openai'],
    ['Claude-3-7-Sonnet', 'openrouter', 'anthropic'],
    ['anthropic/claude-sonnet-4-5', 'custom', 'anthropic'],
    ['gemini-2.5-pro', 'custom', 'google'],
    ['google/gemma-3', 'openrouter', 'google'],
    ['deepseek-r1', 'custom', 'deepseek'],
    ['deepseek/deepseek-chat', 'openrouter', 'deepseek'],
    ['custom-model', 'Anthropic', 'anthropic'],
    ['custom-model', 'openAI', 'openai'],
  ] as const)('maps %s on %s to %s', (modelId, endpoint, expected) => {
    expect(getModelBrand(modelId, endpoint)).toBe(expected);
  });

  it('returns null for unrecognized model IDs and endpoints', () => {
    expect(getModelBrand('custom-model', 'custom')).toBeNull();
  });
});

describe('ModelIcon', () => {
  it.each([
    ['gpt-4.1', 'openai'],
    ['claude-opus-4-6', 'anthropic'],
    ['gemini-2.5-pro', 'google'],
  ])('renders the %s brand icon', (modelId, brand) => {
    render(<ModelIcon modelId={modelId} endpoint="custom" />);

    expect(screen.getByTestId(`${brand}-icon`)).toBeInTheDocument();
  });

  it('uses a custom avatar before the provider icon', () => {
    render(
      <ModelIcon
        modelId="claude-opus-4-6"
        endpoint="anthropic"
        avatarUrl="/avatar.png"
      />,
    );

    expect(document.querySelector('img')).toHaveAttribute('src', '/avatar.png');
    expect(screen.queryByTestId('anthropic-icon')).not.toBeInTheDocument();
  });

  it('uses the bundled DeepSeek asset', () => {
    render(<ModelIcon modelId="deepseek-r1" endpoint="custom" />);

    expect(document.querySelector('img')).toHaveAttribute('src', 'assets/deepseek.svg');
  });

  it('keeps unknown custom models iconless', () => {
    const { container } = render(<ModelIcon modelId="custom-model" endpoint="custom" />);

    expect(container).toBeEmptyDOMElement();
  });

  it('keeps an entity icon ahead of model branding', () => {
    render(
      <ModelIcon
        modelId="gpt-4.1"
        endpoint="agents"
        entityIcon={<span data-testid="entity-icon" />}
      />,
    );

    expect(screen.getByTestId('entity-icon')).toBeInTheDocument();
    expect(screen.queryByTestId('openai-icon')).not.toBeInTheDocument();
  });
});
