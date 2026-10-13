import React from 'react';
import { Anthropic, Gemini, OpenAI } from '@lobehub/icons';
import OfficeAssistantAvatar, { isOfficeAssistantId } from '~/components/OfficeAssistantAvatar';

interface ModelIconProps {
  modelId: string;
  endpoint: string;
  avatarUrl?: string;
  entityIcon?: React.ReactNode;
  size?: number;
}

const endpointAliases: Record<string, 'openai' | 'anthropic' | 'google' | 'deepseek'> = {
  anthropic: 'anthropic',
  azureopenai: 'openai',
  deepseek: 'deepseek',
  gemini: 'google',
  google: 'google',
  openai: 'openai',
};

export function getModelBrand(
  modelId: string,
  endpoint: string,
): 'openai' | 'anthropic' | 'google' | 'deepseek' | null {
  const normalizedModelId = modelId.trim().toLowerCase();

  if (/(?:^|[/:_-])(?:gpt|chatgpt|o[1-9])(?:[-./]|$)/.test(normalizedModelId)) {
    return 'openai';
  }
  if (/(?:^|[/:_-])claude(?:[-./]|$)/.test(normalizedModelId)) {
    return 'anthropic';
  }
  if (/(?:^|[/:_-])(?:gemini|gemma)(?:[-./]|$)/.test(normalizedModelId)) {
    return 'google';
  }
  if (/(?:^|[/:_-])deepseek(?:[-./]|$)/.test(normalizedModelId)) {
    return 'deepseek';
  }

  const normalizedEndpoint = endpointAliases[endpoint.toLowerCase()];
  return normalizedEndpoint ?? null;
}

export function ModelIcon({ modelId, endpoint, avatarUrl, entityIcon, size = 20 }: ModelIconProps) {
  if (isOfficeAssistantId(modelId)) {
    return <OfficeAssistantAvatar size={16} className="shrink-0 rounded-full" />;
  }

  if (avatarUrl) {
    return (
      <span
        className="flex flex-shrink-0 items-center justify-center overflow-hidden rounded-full"
        style={{ width: size, height: size }}
      >
        <img src={avatarUrl} alt="" aria-hidden="true" className="h-full w-full object-cover" />
      </span>
    );
  }

  if (entityIcon) {
    return (
      <span
        aria-hidden="true"
        className="flex flex-shrink-0 items-center justify-center"
        style={{ width: size, height: size }}
      >
        {entityIcon}
      </span>
    );
  }

  const brand = getModelBrand(modelId, endpoint);
  if (brand === 'deepseek') {
    return (
      <span
        aria-hidden="true"
        className="flex flex-shrink-0 items-center justify-center overflow-hidden rounded-full"
        style={{ width: size, height: size }}
      >
        <img src="assets/deepseek.svg" alt="" className="h-full w-full object-cover" />
      </span>
    );
  }
  if (brand === 'openai') {
    return (
      <span aria-hidden="true" className="flex flex-shrink-0" style={{ width: size, height: size }}>
        <OpenAI.Avatar size={size} />
      </span>
    );
  }
  if (brand === 'anthropic') {
    return (
      <span aria-hidden="true" className="flex flex-shrink-0" style={{ width: size, height: size }}>
        <Anthropic.Avatar size={size} />
      </span>
    );
  }
  if (brand === 'google') {
    return (
      <span aria-hidden="true" className="flex flex-shrink-0" style={{ width: size, height: size }}>
        <Gemini.Color size={size} />
      </span>
    );
  }
  return null;
}
