import { useGetStartupConfig } from '~/data-provider';

/**
 * Whether tool steps may expand to show their code, arguments and raw output
 * (`interface.toolDetails`). Stays false until the config loads, so hidden
 * details never flash on first render.
 */
export default function useToolDetails(): boolean {
  const { data: startupConfig } = useGetStartupConfig();
  return startupConfig?.interface?.toolDetails === true;
}
