import type {
  CampaignContentCampaignSnapshot,
  CampaignContentGeneratedContent,
  CampaignContentLengthPolicy,
  CampaignContentMessage,
  CampaignContentOption,
} from '@ummix/ai-contracts';

export type CampaignContentMessageRole = CampaignContentMessage['role'];

export type CampaignContentMessageType = CampaignContentMessage['type'];

export type CampaignContentStatus = CampaignContentGeneratedContent['status'];

export type CampaignContentSessionStatus =
  | 'collecting'
  | 'ready_to_generate'
  | 'generating'
  | 'options_ready'
  | 'saved'
  | 'failed'
  | 'abandoned';

export type CampaignContentEmailStatus = CampaignContentGeneratedContent['emailStatus'];

export type CampaignContentAnswers = Record<string, string>;

export interface CampaignContentSession {
  id: string;
  campaignId: string;
  userId: string;
  status: CampaignContentSessionStatus;
  campaignSnapshot: CampaignContentCampaignSnapshot;
  answers: CampaignContentAnswers;
  currentQuestionKey: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface CampaignContentMessageRecord extends CampaignContentMessage {
  sessionId: string;
  clientMessageId: string | null;
}

export type {
  CampaignContentCampaignSnapshot,
  CampaignContentGeneratedContent,
  CampaignContentLengthPolicy,
  CampaignContentOption,
};
