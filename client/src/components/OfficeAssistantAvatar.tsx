import { motion, useReducedMotion } from 'framer-motion';
import type { Agent } from 'librechat-data-provider';

export const officeAssistantAgentId = 'agent_office_assistant';

export const isOfficeAssistant = (agent: Agent | null | undefined): boolean =>
  agent?.id === officeAssistantAgentId;

export const isOfficeAssistantId = (agentId: string | null | undefined): boolean =>
  agentId === officeAssistantAgentId;

type OfficeAssistantAvatarProps = {
  size: number | string;
  className?: string;
  animated?: boolean;
};

export default function OfficeAssistantAvatar({
  size,
  className,
  animated = true,
}: OfficeAssistantAvatarProps) {
  const prefersReducedMotion = useReducedMotion();

  return (
    <motion.img
      src="/assets/synapse_192x192.png"
      alt="Office Assistant"
      width={size}
      height={size}
      className={className}
      animate={
        !animated || prefersReducedMotion
          ? undefined
          : {
              y: [0, -4, 1, 0],
              rotate: [0, -2.5, 2.5, 0],
              scale: [1, 1.08, 0.98, 1],
            }
      }
      transition={{ duration: 2.8, ease: 'easeInOut', repeat: Infinity, repeatDelay: 0.8 }}
    />
  );
}
