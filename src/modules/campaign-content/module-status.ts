import type { AiPlatformModuleStatus } from '@ummix/ai-contracts';

export function getCampaignContentModuleStatus(
  enabled: boolean,
  dependenciesConfigured: boolean,
): AiPlatformModuleStatus {
  if (!enabled) return 'disabled';
  return dependenciesConfigured ? 'ready' : 'not_ready';
}
