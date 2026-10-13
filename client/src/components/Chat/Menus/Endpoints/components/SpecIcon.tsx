import React, { memo } from 'react';
import { getEndpointField } from 'librechat-data-provider';
import type { TModelSpec, TEndpointsConfig } from 'librechat-data-provider';
import type { IconMapProps } from '~/common';
import { getModelSpecIconURL, getIconKey } from '~/utils';
import { URLIcon } from '~/components/Endpoints/URLIcon';
import { icons } from '~/hooks/Endpoint/Icons';
import { isImageURL } from '~/utils/icons';
import { getModelBrand, ModelIcon } from './ModelIcon';
import OfficeAssistantAvatar, { isOfficeAssistantId } from '~/components/OfficeAssistantAvatar';

interface SpecIconProps {
  currentSpec: TModelSpec;
  endpointsConfig: TEndpointsConfig;
  /** Avatar of the agent this spec targets, used when the spec defines no icon of its own. */
  agentAvatarURL?: string;
  agentId?: string;
  officeAssistantSize?: number;
}

type IconType = (props: IconMapProps) => React.JSX.Element;

const SpecIcon: React.FC<SpecIconProps> = ({
  currentSpec,
  endpointsConfig,
  agentAvatarURL,
  agentId,
  officeAssistantSize = 20,
}) => {
  if (isOfficeAssistantId(agentId)) {
    return <OfficeAssistantAvatar size={officeAssistantSize} className="shrink-0 rounded-full" />;
  }

  const iconURL = getModelSpecIconURL(currentSpec, agentAvatarURL);
  const endpoint = currentSpec.preset?.endpoint;
  const modelId = currentSpec.preset?.model;
  const endpointIconURL = getEndpointField(endpointsConfig, endpoint, 'iconURL');
  const iconKey = getIconKey({ endpoint, endpointsConfig, endpointIconURL });
  const shouldRenderURLIcon = isImageURL(iconURL);

  if (
    !currentSpec.iconURL &&
    !currentSpec.preset?.iconURL &&
    !agentAvatarURL &&
    typeof modelId === 'string' &&
    getModelBrand(modelId, endpoint ?? '')
  ) {
    return <ModelIcon modelId={modelId} endpoint={endpoint ?? ''} />;
  }

  let Icon: IconType;

  if (!shouldRenderURLIcon) {
    Icon = (icons[iconURL] ?? icons[iconKey] ?? icons.unknown) as IconType;
  } else {
    return (
      <URLIcon
        iconURL={iconURL}
        altName={currentSpec.name}
        containerStyle={{ width: 20, height: 20 }}
        className="icon-md shrink-0 overflow-hidden rounded-full"
        endpoint={endpoint || undefined}
      />
    );
  }

  return (
    <Icon
      size={20}
      endpoint={endpoint}
      context="menu-item"
      iconURL={endpointIconURL}
      className="icon-md shrink-0 text-text-primary"
    />
  );
};

export default memo(SpecIcon);
