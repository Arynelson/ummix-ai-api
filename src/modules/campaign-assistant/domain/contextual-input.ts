import type {
  ExtractedCampaignPatch,
  MissingField,
} from './types.js';

interface ContextualInputOptions {
  message: string;
  currentField: MissingField | null | undefined;
  referenceDate: string;
}

export function normalizeContextualPatch(
  patch: ExtractedCampaignPatch,
  options: ContextualInputOptions,
): ExtractedCampaignPatch {
  const normalized = { ...patch };

  if (options.currentField === 'maximumBudget') {
    const monetaryValue = parseBrazilianMonetaryLiteral(options.message);
    if (monetaryValue !== null) normalized.maximumBudget = monetaryValue;
  }

  if (
    options.currentField === 'desiredStartDate' &&
    isAsSoonAsPossible(options.message)
  ) {
    normalized.desiredStartDate = addBusinessDays(options.referenceDate, 4);
  }

  return normalized;
}

export function currentDateInBrazil(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function parseBrazilianMonetaryLiteral(message: string): number | null {
  const literal = message.trim().replace(/^R\$\s*/iu, '').replace(/\s+/g, '');
  const isBrazilianNumber =
    /^\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?$/u.test(literal) ||
    /^\d+(?:,\d{1,2})?$/u.test(literal);
  if (!isBrazilianNumber) return null;

  const parsed = Number(literal.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function isAsSoonAsPossible(message: string): boolean {
  const normalized = message
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('pt-BR')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return /\b(?:o )?mais (?:rapido|breve) possivel\b/u.test(normalized);
}

function addBusinessDays(referenceDate: string, days: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(referenceDate)) return referenceDate;
  const date = new Date(`${referenceDate}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return referenceDate;

  let remaining = Math.max(0, Math.floor(days));
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    const dayOfWeek = date.getUTCDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) remaining -= 1;
  }
  return date.toISOString().slice(0, 10);
}
