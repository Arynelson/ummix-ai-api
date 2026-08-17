export type CampaignContentChannel = 'radio' | 'tv' | 'both';

export type CampaignContentSessionStatus =
  | 'collecting'
  | 'ready_to_generate'
  | 'generating'
  | 'options_ready'
  | 'saved'
  | 'failed'
  | 'abandoned';

export interface CampaignContentOption {
  id: string;
  text: string;
  wordCount: number;
  style?: string;
}

export type CampaignContentStatus =
  | 'generating'
  | 'options_ready'
  | 'saved'
  | 'archived'
  | 'failed';

export type CampaignContentEmailStatus =
  | 'not_sent'
  | 'pending'
  | 'sending'
  | 'sent'
  | 'failed';

export interface CampaignContentGeneratedContent {
  generationId: string;
  status: CampaignContentStatus;
  sessionVersion: number;
  lengthPolicy: CampaignContentLengthPolicy;
  options: CampaignContentOption[];
  selectedOptionId: string | null;
  selectedTextOriginal: string | null;
  finalText: string | null;
  isEdited: boolean;
  wordCount: number | null;
  emailStatus: CampaignContentEmailStatus;
}

export interface CampaignContentLengthPolicy {
  version: string;
  durationSeconds: number;
  minWords: number;
  maxWords: number;
}

export interface CampaignContentContext {
  contractVersion: '1';
  campaignId: string;
  userId: string;
  clientId: string;
  campaignName: string | null;
  brandName: string | null;
  objective: string | null;
  mediaChannel: CampaignContentChannel;
  format: string | null;
  durationSeconds: number;
  paymentStatus: string;
  canGenerate: boolean;
  contextVersion: string;
  startDate: string | null;
  endDate: string | null;
  targetAudience: Record<string, unknown> | null;
}

export interface CampaignContentContextError {
  code:
    | 'UNAUTHENTICATED'
    | 'FORBIDDEN'
    | 'CAMPAIGN_NOT_FOUND'
    | 'CAMPAIGN_NOT_ELIGIBLE'
    | 'INTEGRATION_UNAVAILABLE';
  message: string;
}

export interface CampaignContentCampaignSnapshot {
  campaignName: string | null;
  brandName: string | null;
  objective: string | null;
  mediaChannel: CampaignContentChannel;
  format: string | null;
  durationSeconds: number;
  paymentStatus: string;
  startDate: string | null;
  endDate: string | null;
  targetAudience: Record<string, unknown> | null;
  contextVersion: string;
}

export type CampaignContentMessageRole = 'user' | 'assistant';

export type CampaignContentMessageType = 'question' | 'answer' | 'status' | 'error';

export interface CampaignContentMessage {
  id: string;
  role: CampaignContentMessageRole;
  type: CampaignContentMessageType;
  text: string;
  createdAt: string;
  metadata?: Record<string, unknown> | null;
}

export interface CampaignContentSessionView {
  sessionId: string;
  status: Extract<CampaignContentSessionStatus, 'collecting' | 'ready_to_generate' | 'generating' | 'options_ready' | 'saved' | 'failed' | 'abandoned'>;
  version: number;
  campaignContext: CampaignContentCampaignSnapshot;
  answers: Record<string, string>;
  currentQuestionKey: string | null;
  missingFields: string[];
  messages: CampaignContentMessage[];
  expiresAt: string;
}
