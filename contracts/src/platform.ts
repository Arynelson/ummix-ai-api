export type AiPlatformModule = 'campaign-assistant' | 'campaign-content';

export type AiPlatformModuleStatus = 'ready' | 'disabled' | 'not_ready';

export interface AiPlatformHealth {
  status: 'ok' | 'degraded';
  modules: Record<AiPlatformModule, {
    enabled: boolean;
    status: AiPlatformModuleStatus;
  }>;
  dependencies: {
    database: 'configured';
    llm: 'configured' | 'not_configured';
  };
}

export interface AiPlatformReadiness {
  status: 'ready' | 'not_ready';
  dependencies: {
    database: 'ready' | 'unavailable';
  };
}

export interface AuthHandoffExchangeRequest {
  handoffToken: string;
}

export interface AuthHandoffCreateResponse {
  handoffToken: string;
  expiresIn: number;
}

export interface AuthHandoffExchangeResponse {
  access_token: string;
  user: Record<string, unknown>;
}
