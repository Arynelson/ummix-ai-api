import type { CampaignContentCampaignSnapshot } from '@ummix/ai-contracts';

export const CAMPAIGN_CONTENT_MAX_ANSWER_LENGTH = 2_000;
export const CAMPAIGN_CONTENT_MAX_MESSAGES = 20;

const QUESTION_LABELS: Record<string, string> = {
  product_or_service: 'O que será divulgado? Descreva o produto ou serviço.',
  target_audience: 'Para quem essa mensagem deve falar?',
  main_benefit: 'Qual é o principal benefício ou diferencial?',
  offer_details: 'Qual é a oferta, preço ou condição que precisa aparecer?',
  validity: 'Até quando a oferta é válida?',
  core_message: 'Qual mensagem central a marca quer transmitir?',
  positioning: 'Como a marca quer ser percebida?',
  call_to_action: 'Qual ação o público deve realizar? Informe telefone, site, endereço ou outro contato.',
  tone: 'Qual tom você prefere, por exemplo direto, emocional, descontraído ou institucional?',
  restrictions: 'Existe alguma informação obrigatória, restrição ou afirmação que não pode ser inventada?',
};

export function missingBriefingFields(
  snapshot: CampaignContentCampaignSnapshot,
  answers: Record<string, string>,
): string[] {
  const objective = snapshot.objective?.toLowerCase() ?? '';
  const isBrandRecognition = objective.includes('reconhecimento') || objective.includes('marca');
  const fields = isBrandRecognition
    ? ['core_message', 'positioning', 'target_audience', 'tone', 'restrictions']
    : ['product_or_service', 'target_audience', 'main_benefit', 'call_to_action', 'tone', 'restrictions'];

  if (objective.includes('promoc') || objective.includes('oferta') || objective.includes('lanc')) {
    fields.splice(isBrandRecognition ? 2 : 3, 0, 'offer_details', 'validity');
  }

  return fields.filter((key) => !answers[key]?.trim());
}

export function questionForBriefingField(key: string): string {
  return QUESTION_LABELS[key] ?? 'Que informação adicional devemos considerar no texto?';
}

export function applyDeterministicAnswer(
  snapshot: CampaignContentCampaignSnapshot,
  answers: Record<string, string>,
  currentQuestionKey: string | null,
  text: string,
): Record<string, string> {
  const next = { ...answers };
  const missing = missingBriefingFields(snapshot, next);
  const key = currentQuestionKey && missing.includes(currentQuestionKey)
    ? currentQuestionKey
    : missing[0];
  if (key) next[key] = text.trim().slice(0, CAMPAIGN_CONTENT_MAX_ANSWER_LENGTH);
  return next;
}

export function createSessionExpiry(endDate: string | null): Date {
  const base = endDate
    ? new Date(endDate.includes('T') ? endDate : `${endDate}T23:59:59.000Z`)
    : new Date();
  if (Number.isNaN(base.getTime())) {
    throw new Error('Data final da campanha inválida no contexto de conteúdo.');
  }
  base.setUTCDate(base.getUTCDate() + 90);
  return base;
}
