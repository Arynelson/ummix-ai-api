export const OBJECTIVES = [
  'reconhecimento_marca',
  'lancamento_produto',
  'promocao_oferta',
] as const;

export const CHANNELS = ['radio', 'tv'] as const;

export const CATEGORIES = [
  'alimentacao',
  'varejo',
  'supermercado',
  'saude_essencial',
  'saude_estetica',
  'educacao',
  'automotivo',
  'imobiliario',
  'construcao',
  'servicos_profissionais',
  'servicos_locais',
  'evento',
] as const;

export type CampaignObjective = (typeof OBJECTIVES)[number];
export type MediaChannel = (typeof CHANNELS)[number];
export type CampaignCategory = (typeof CATEGORIES)[number];
export type SessionStatus = 'collecting' | 'ready' | 'finalizing' | 'completed' | 'expired';

export interface CampaignLocation {
  cityId: string;
  cityName: string;
  stateUf: string | null;
}

export interface MediaPlan {
  channel: MediaChannel;
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

export interface ChannelComparison {
  radio: MediaPlan;
  tv: MediaPlan;
  recommendedChannel: MediaChannel | null;
  rationale: string;
}

export interface CampaignState {
  productService: string | null;
  objective: CampaignObjective | null;
  audienceDescription: string | null;
  location: CampaignLocation | null;
  locations?: CampaignLocation[];
  locationOptions?: CampaignLocation[];
  unresolvedLocation: string | null;
  maximumBudget: number | null;
  desiredStartDate: string | null;
  selectedChannel: MediaChannel | null;
  category: CampaignCategory | null;
  brandStrength: 'regional';
  durationSeconds: 15;
  comparison: ChannelComparison | null;
  minimumInvestment: number;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export interface ClientSnapshot {
  id: string;
  fullName: string;
  companyName: string | null;
  companyBrand: string | null;
  businessActivity: string | null;
  isActive: boolean;
}

export interface AssistantSession {
  id: string;
  userId: string;
  userType: string;
  clientId: string;
  clientSnapshot: ClientSnapshot;
  status: SessionStatus;
  state: CampaignState;
  messages: ChatMessage[];
  finalizedCampaignId: string | null;
  finalizedAt: string | null;
  reviewReachedAt: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface ExtractedCampaignPatch {
  productService: string | null;
  objective: CampaignObjective | null;
  audienceDescription: string | null;
  cityName: string | null;
  stateUf: string | null;
  maximumBudget: number | null;
  desiredStartDate: string | null;
  selectedChannel: MediaChannel | null;
}

export type MissingField =
  | 'productService'
  | 'objective'
  | 'location'
  | 'audienceDescription'
  | 'maximumBudget'
  | 'desiredStartDate'
  | 'category'
  | 'selectedChannel';
