export type AssistantMediaChannel = 'radio' | 'tv';

export interface AssistantClient {
  id: string;
  fullName: string;
  companyName: string | null;
  companyBrand: string | null;
  businessActivity: string | null;
  isActive: boolean;
}

export interface AssistantContext {
  user: {
    id: string;
    fullName: string;
    userType: 'regular_client' | 'marketing_agency' | 'paid_traffic_manager';
  };
  clients: AssistantClient[];
  requiresClientSelection: boolean;
}

export interface AssistantMediaPlan {
  channel: AssistantMediaChannel;
  available: boolean;
  cpm: number | null;
  frequency: number | null;
  periodWeeks: number | null;
  totalImpressions: number | null;
  inventory: number | null;
  audienceImpacts: number | null;
  projectedLeads: number | null;
  projectedSales: number | null;
  reasonUnavailable: string | null;
}

export interface AssistantCampaignState {
  productService: string | null;
  objective: string | null;
  audienceDescription: string | null;
  location: AssistantLocation | null;
  locations?: AssistantLocation[];
  locationOptions?: AssistantLocation[];
  stateOptions?: AssistantStateOption[];
  audienceFilters?: AssistantAudienceFilter[];
  unresolvedLocation: string | null;
  maximumBudget: number | null;
  desiredStartDate: string | null;
  selectedChannel: AssistantMediaChannel | null;
  category: string | null;
  brandStrength: 'regional';
  durationSeconds: 15;
  comparison: {
    radio: AssistantMediaPlan;
    tv: AssistantMediaPlan;
    recommendedChannel: AssistantMediaChannel | null;
    rationale: string;
  } | null;
  minimumInvestment: number;
}

export interface AssistantLocation {
  cityId: string;
  cityName: string;
  stateUf: string | null;
}

export interface AssistantStateOption {
  stateId: string;
  stateName: string;
  stateUf: string;
}

export interface AssistantAudienceFilter {
  questionId: string;
  question: string;
  questionOriginal?: string;
  category?: string | null;
  optionId: string;
  option: string;
}

export interface AssistantChatMessage {
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export interface AssistantSessionView {
  id: string;
  status: 'collecting' | 'ready' | 'finalizing' | 'completed' | 'expired';
  client: AssistantClient;
  state: AssistantCampaignState;
  messages: AssistantChatMessage[];
  missingFields: string[];
  quickReplies: string[];
  readyToFinalize: boolean;
  expiresAt: string;
  finalization: {
    campaignId: string;
    wizardStep: 4;
    reviewUrl: string;
  } | null;
  assistantMessage?: string;
  fallbackToManual?: boolean;
}
