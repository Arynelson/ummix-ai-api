import {
  CATEGORIES,
  CHANNELS,
  OBJECTIVES,
  type CampaignCategory,
  type CampaignLocation,
  type CampaignState,
  type ChannelComparison,
  type MediaChannel,
  type MissingField,
  type StateOption,
  type ValidatedCampaignPatch,
} from './types.js';

export function initialState(
  minimumInvestment: number,
  businessActivity: string | null,
  locationOptions: CampaignLocation[] = [],
  stateOptions: StateOption[] = [],
): CampaignState {
  const category = CATEGORIES.includes(businessActivity as CampaignCategory)
    ? (businessActivity as CampaignCategory)
    : null;

  return {
    productService: null,
    objective: null,
    audienceDescription: null,
    location: null,
    locations: [],
    locationOptions,
    stateOptions,
    audienceFilters: [],
    unresolvedLocation: null,
    maximumBudget: null,
    desiredStartDate: null,
    selectedChannel: null,
    category,
    brandStrength: 'regional',
    durationSeconds: 15,
    comparison: null,
    minimumInvestment,
  };
}

export function applyExtractedPatch(
  current: CampaignState,
  patch: ValidatedCampaignPatch,
): CampaignState {
  const next: CampaignState = { ...current };
  const selectedChannelFromPatch =
    patch.selectedChannel && CHANNELS.includes(patch.selectedChannel)
      ? patch.selectedChannel
      : null;

  if (patch.productService?.trim()) next.productService = patch.productService.trim().slice(0, 240);
  if (patch.audienceDescription?.trim()) {
    next.audienceDescription = patch.audienceDescription.trim().slice(0, 500);
    if (patch.audienceFilters !== undefined) {
      next.audienceFilters = patch.audienceFilters ?? [];
    }
  }
  if (patch.objective && OBJECTIVES.includes(patch.objective)) next.objective = patch.objective;
  if (selectedChannelFromPatch) next.selectedChannel = selectedChannelFromPatch;
  if (patch.maximumBudget !== null && Number.isFinite(patch.maximumBudget)) {
    next.maximumBudget = Math.round(Math.max(0, patch.maximumBudget) * 100) / 100;
  }
  if (
    patch.desiredStartDate &&
    /^\d{4}-\d{2}-\d{2}$/.test(patch.desiredStartDate) &&
    !Number.isNaN(Date.parse(`${patch.desiredStartDate}T00:00:00Z`))
  ) {
    next.desiredStartDate = patch.desiredStartDate;
  }

  if (patch.cityName?.trim()) {
    next.unresolvedLocation = [patch.cityName.trim(), patch.stateUf?.trim().toUpperCase()]
      .filter(Boolean)
      .join('/');
    next.location = null;
    next.locations = [];
  }

  if (
    current.maximumBudget !== next.maximumBudget ||
    current.objective !== next.objective ||
    current.location?.cityId !== next.location?.cityId ||
    current.audienceDescription !== next.audienceDescription ||
    current.desiredStartDate !== next.desiredStartDate ||
    JSON.stringify(current.audienceFilters ?? []) !==
      JSON.stringify(next.audienceFilters ?? [])
  ) {
    next.comparison = null;
    // Se a mesma mensagem mudou dados e confirmou um canal, a confirmação
    // explícita do cliente deve sobreviver ao recálculo da comparação.
    next.selectedChannel = selectedChannelFromPatch;
  }

  return next;
}

export function missingFields(state: CampaignState): MissingField[] {
  const missing: MissingField[] = [];
  if (!state.objective) missing.push('objective');
  if (campaignLocations(state).length === 0) missing.push('location');
  if (!state.productService) missing.push('productService');
  if (!state.audienceDescription) missing.push('audienceDescription');
  if (state.maximumBudget === null || state.maximumBudget < state.minimumInvestment) {
    missing.push('maximumBudget');
  }
  if (!state.desiredStartDate) missing.push('desiredStartDate');
  if (!state.category) missing.push('category');
  if (
    !state.selectedChannel ||
    (state.comparison && !state.comparison[state.selectedChannel].available)
  ) {
    missing.push('selectedChannel');
  }
  return missing;
}

export function canCalculateComparison(state: CampaignState): boolean {
  return Boolean(
    state.productService &&
    state.objective &&
    campaignLocations(state).length > 0 &&
    state.audienceDescription &&
    state.category &&
    state.maximumBudget !== null &&
    state.maximumBudget >= state.minimumInvestment &&
    state.desiredStartDate,
  );
}

export function isReadyToFinalize(state: CampaignState): boolean {
  return missingFields(state).length === 0 && Boolean(state.comparison);
}

export function chooseRecommendedChannel(
  radio: ChannelComparison['radio'],
  tv: ChannelComparison['tv'],
): MediaChannel | null {
  if (radio.available && !tv.available) return 'radio';
  if (tv.available && !radio.available) return 'tv';
  if (!radio.available || !tv.available) return null;

  const radioScore = (radio.totalImpressions ?? 0) + (radio.audienceImpacts ?? 0);
  const tvScore = (tv.totalImpressions ?? 0) + (tv.audienceImpacts ?? 0);
  return radioScore >= tvScore ? 'radio' : 'tv';
}

export function buildRationale(comparison: ChannelComparison): string {
  const channel = comparison.recommendedChannel;
  if (!channel) {
    return 'Não há dados suficientes para recomendar Rádio ou TV nesta praça.';
  }

  const recommended = comparison[channel];
  const alternative = comparison[channel === 'radio' ? 'tv' : 'radio'];
  const label = channel === 'radio' ? 'Rádio' : 'TV';
  const reason =
    recommended.totalImpressions !== null && alternative.totalImpressions !== null
      ? `${recommended.totalImpressions.toLocaleString('pt-BR')} impressões estimadas, contra ${alternative.totalImpressions.toLocaleString('pt-BR')} na alternativa`
      : `CPM estimado de ${formatCurrency(recommended.cpm)}`;
  return `${label} aparece como melhor ponto de partida para este orçamento: ${reason}. A decisão final continua sendo sua.`;
}

export function nextAssistantTurn(
  state: CampaignState,
  options: { llmUnavailable?: boolean; clientName?: string } = {},
): { message: string; quickReplies: string[] } {
  if (options.llmUnavailable) {
    return {
      message:
        'Não consegui interpretar esta mensagem agora. Seus dados continuam salvos; você pode tentar novamente ou continuar pelo criador manual.',
      quickReplies: [],
    };
  }

  if (state.maximumBudget !== null && state.maximumBudget < state.minimumInvestment) {
    return {
      message: `O investimento mínimo atual é ${formatCurrency(state.minimumInvestment)}. Qual valor máximo acima desse mínimo você pretende investir?`,
      quickReplies: [],
    };
  }

  if (!state.objective) {
    return {
      message:
        'Qual é o principal objetivo da campanha: fortalecer a marca, lançar um produto ou promover uma oferta?',
      quickReplies: ['Fortalecer a marca', 'Lançar um produto', 'Promover uma oferta'],
    };
  }
  if (campaignLocations(state).length === 0) {
    const locationHint = state.unresolvedLocation
      ? `Não encontrei dados para “${state.unresolvedLocation}”. `
      : '';
    const hasOptions = (state.locationOptions?.length ?? 0) > 0;
    return {
      message: hasOptions
        ? `${locationHint}Seu negócio ou comércio fica ou atende clientes em uma ou mais destas cidades? Selecione as praças disponíveis e confirme.`
        : `${locationHint}Em qual cidade está o público da campanha?`,
      quickReplies: [],
    };
  }
  if (!state.productService) {
    const clientPrefix = options.clientName
      ? `Vamos montar uma campanha para ${options.clientName}. `
      : '';
    return {
      message: `${clientPrefix}Qual produto ou serviço você quer divulgar nesta campanha?`,
      quickReplies: [],
    };
  }
  if (!state.audienceDescription) {
    return {
      message: 'Como você descreveria o público que deseja alcançar em uma frase?',
      quickReplies: [],
    };
  }
  if (state.maximumBudget === null) {
    return {
      message: 'Qual é o orçamento máximo da campanha? Vou tratá-lo como um teto rígido.',
      quickReplies: [],
    };
  }
  if (!state.desiredStartDate) {
    return {
      message: 'Quando você gostaria que a campanha começasse?',
      quickReplies: [],
    };
  }
  if (!state.category) {
    return {
      message:
        'A atividade comercial do cliente não está associada a uma categoria suportada. Atualize o cadastro ou continue pelo criador manual.',
      quickReplies: [],
    };
  }
  if (!state.comparison) {
    return {
      message: 'Estou calculando uma comparação de Rádio e TV com os dados disponíveis.',
      quickReplies: [],
    };
  }
  const availableChannels = CHANNELS.filter(
    (channel) => state.comparison?.[channel].available,
  );
  if (availableChannels.length === 0) {
    return {
      message:
        'Não encontrei inventário calculável de Rádio ou TV para esta praça. Seus dados estão salvos; continue pelo criador manual para ajustar a segmentação.',
      quickReplies: [],
    };
  }
  if (
    !state.selectedChannel ||
    !state.comparison[state.selectedChannel].available
  ) {
    return {
      message: `${state.comparison.rationale} Qual canal você confirma para a proposta?`,
      quickReplies: availableChannels.map((channel) => (channel === 'radio' ? 'Rádio' : 'TV')),
    };
  }

  return {
    message:
      'A proposta está pronta. Confira o resumo e, quando estiver de acordo, crie o rascunho para revisar antes do pagamento.',
    quickReplies: [],
  };
}

function formatCurrency(value: number | null): string {
  if (value === null) return 'indisponível';
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(value);
}

export function campaignLocations(state: CampaignState): CampaignLocation[] {
  if (state.locations?.length) return state.locations;
  return state.location ? [state.location] : [];
}
