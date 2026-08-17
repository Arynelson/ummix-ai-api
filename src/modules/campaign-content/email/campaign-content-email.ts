import type {
  CampaignContentCampaignSnapshot,
  CampaignContentLengthPolicy,
} from '@ummix/ai-contracts';

export interface CampaignContentEmailInput {
  campaignId: string;
  contentId: string;
  campaignSnapshot: CampaignContentCampaignSnapshot;
  selectedTextOriginal: string;
  finalText: string;
  isEdited: boolean;
  wordCount: number;
  lengthPolicy: CampaignContentLengthPolicy;
}

export interface RenderedCampaignContentEmail {
  subject: string;
  htmlContent: string;
  textContent: string;
}

const MEDIA_LABELS: Record<CampaignContentCampaignSnapshot['mediaChannel'], string> = {
  radio: 'Rádio',
  tv: 'TV',
  both: 'Rádio e TV',
};

export function renderCampaignContentEmail(
  input: CampaignContentEmailInput,
): RenderedCampaignContentEmail {
  const campaignName = input.campaignSnapshot.campaignName?.trim() || input.campaignId;
  const subjectName = sanitizeSubject(campaignName).slice(0, 100);
  const rows = [
    ['Campanha', campaignName],
    ['ID da campanha', input.campaignId],
    ['ID do conteúdo', input.contentId],
    ['Canal', MEDIA_LABELS[input.campaignSnapshot.mediaChannel]],
    ['Duração', `${input.lengthPolicy.durationSeconds} segundos`],
    ['Formato', input.campaignSnapshot.format || 'Não informado'],
    ['Palavras', `${input.wordCount} (faixa: ${input.lengthPolicy.minWords}–${input.lengthPolicy.maxWords})`],
    ['Edição manual', input.isEdited ? 'Sim' : 'Não'],
  ] as const;

  const htmlRows = rows
    .map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`)
    .join('');
  const textRows = rows.map(([label, value]) => `${label}: ${value}`).join('\n');

  return {
    subject: `Novo conteúdo de campanha — ${subjectName}`,
    htmlContent: `<!doctype html>
<html lang="pt-BR">
  <body style="margin:0;background:#f4f2f2;color:#1e1e1e;font-family:Arial,sans-serif;line-height:1.5;">
    <main style="max-width:720px;margin:0 auto;padding:32px 20px;">
      <section style="background:#fff;border-radius:16px;padding:28px;">
        <p style="margin:0 0 8px;color:#9b191a;font-weight:700;">Ummix Ads · Conteúdo com IA</p>
        <h1 style="margin:0 0 20px;font-size:24px;">Novo conteúdo salvo para revisão administrativa</h1>
        <table style="width:100%;border-collapse:collapse;margin:0 0 24px;">${htmlRows}</table>
        <h2 style="font-size:18px;margin:20px 0 8px;">Texto final</h2>
        <pre style="white-space:pre-wrap;background:#f4f2f2;border-radius:12px;padding:16px;font:inherit;">${escapeHtml(input.finalText)}</pre>
        <h2 style="font-size:18px;margin:20px 0 8px;">Texto original escolhido</h2>
        <pre style="white-space:pre-wrap;background:#f4f2f2;border-radius:12px;padding:16px;font:inherit;">${escapeHtml(input.selectedTextOriginal)}</pre>
      </section>
    </main>
  </body>
</html>`,
    textContent: [
      'Ummix Ads — novo conteúdo salvo para revisão administrativa',
      '',
      textRows,
      '',
      'TEXTO FINAL',
      input.finalText,
      '',
      'TEXTO ORIGINAL ESCOLHIDO',
      input.selectedTextOriginal,
    ].join('\n'),
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function sanitizeSubject(value: string): string {
  return value.replace(/[\r\n]+/gu, ' ').trim() || 'Campanha sem nome';
}
