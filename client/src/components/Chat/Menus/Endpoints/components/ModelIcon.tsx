import React from 'react';
import { Anthropic, Gemini, OpenAI } from '@lobehub/icons';

interface ModelIconProps {
  modelId: string;
  endpoint: string;
  avatarUrl?: string;
  entityIcon?: React.ReactNode;
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

export function ModelIcon({ modelId, endpoint, avatarUrl, entityIcon }: ModelIconProps) {
  if (avatarUrl) {
    return (
      <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center overflow-hidden rounded-full">
        <img src={avatarUrl} alt="" aria-hidden="true" className="h-full w-full object-cover" />
      </span>
    );
  }

  if (entityIcon) {
    return (
      <span
        aria-hidden="true"
        className="flex h-5 w-5 flex-shrink-0 items-center justify-center"
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
        className="flex h-5 w-5 flex-shrink-0 items-center justify-center overflow-hidden rounded-full"
      >
        <img src="assets/deepseek.svg" alt="" className="h-full w-full object-cover" />
      </span>
    );
  }
  if (brand === 'openai') {
    return (
      <span aria-hidden="true" className="flex h-5 w-5 flex-shrink-0">
        <OpenAI.Avatar size={20} />
      </span>
    );
  }
  if (brand === 'anthropic') {
    return (
      <span aria-hidden="true" className="flex h-5 w-5 flex-shrink-0">
        <Anthropic.Avatar size={20} />
      </span>
    );
  }
  if (brand === 'google') {
    return (
      <span aria-hidden="true" className="flex h-5 w-5 flex-shrink-0">
        <Gemini.Avatar size={20} />
      </span>
    );
  }
  return null;
}
