import type {
  CampaignContentCampaignSnapshot,
  CampaignContentContext,
  CampaignContentGeneratedContent,
  CampaignContentMessage,
  CampaignContentSessionView,
} from '@ummix/ai-contracts';
import type { AppConfig } from '../../../config.js';
import {
  applyDeterministicAnswer,
  CAMPAIGN_CONTENT_MAX_ANSWER_LENGTH,
  CAMPAIGN_CONTENT_MAX_MESSAGES,
  createSessionExpiry,
  missingBriefingFields,
  questionForBriefingField,
} from '../domain/briefing.js';
import type {
  CampaignContentSession,
  CampaignContentSessionStatus,
} from '../domain/types.js';
import {
  CampaignContentRepository,
  type CampaignContentEmailDelivery,
  type ContentWithSessionVersion,
} from '../db/content-repository.js';
import { CampaignContentGenerator, CampaignContentLlmError } from '../openai/content-generator.js';
import { CampaignContentLengthPolicyService } from '../domain/length-policy.js';
import {
  CampaignContentSessionRepository,
  type CampaignContentSessionWithMessages,
} from '../db/session-repository.js';
import {
  CampaignContentContextClient,
  CampaignContentContextError,
} from '../ummix/context-client.js';
import { CampaignContentEmailProvider } from '../email/campaign-content-email-provider.js';
import type { CampaignContentEmailInput } from '../email/campaign-content-email.js';

export interface CampaignContentUser {
  id: string;
  role: string;
  userType: string;
}

export class CampaignContentHttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'CampaignContentHttpError';
  }
}

export class CampaignContentService {
  constructor(
    private readonly config: AppConfig,
    private readonly repository: CampaignContentSessionRepository,
    private readonly contextClient: CampaignContentContextClient,
    private readonly contentRepository: CampaignContentRepository | null = null,
    private readonly generator: CampaignContentGenerator | null = null,
    private readonly lengthPolicy: CampaignContentLengthPolicyService | null = null,
    private readonly emailProvider: CampaignContentEmailProvider | null = null,
  ) {}

  async createOrResumeSession(input: {
    campaignId: string;
    token: string;
    user: CampaignContentUser;
  }): Promise<CampaignContentSessionView> {
    this.ensureEnabled();
    const context = await this.getWritableContext(input.campaignId, input.token, input.user);
    const snapshot = toSnapshot(context);
    const missingFields = missingBriefingFields(snapshot, {});
    const status: CampaignContentSessionStatus = missingFields.length
      ? 'collecting'
      : 'ready_to_generate';
    const currentQuestionKey = missingFields[0] ?? null;
    const session = await this.repository.createOrFindActive({
      campaignId: input.campaignId,
      userId: input.user.id,
      campaignSnapshot: snapshot,
      answers: {},
      currentQuestionKey,
      status,
      expiresAt: createSessionExpiry(context.endDate),
      initialMessage: currentQuestionKey
        ? {
            text: questionForBriefingField(currentQuestionKey),
            type: 'question',
            metadata: { questionKey: currentQuestionKey },
          }
        : {
            text: 'Já tenho as informações necessárias para preparar o conteúdo.',
            type: 'status',
            metadata: { status: 'ready_to_generate' },
          },
    });
    return this.toView(session);
  }

  async addMessage(input: {
    campaignId: string;
    sessionId: string;
    token: string;
    user: CampaignContentUser;
    clientMessageId: string;
    text: string;
    expectedSessionVersion: number;
  }): Promise<CampaignContentSessionView> {
    this.ensureEnabled();
    await this.getWritableContext(input.campaignId, input.token, input.user);
    const existing = await this.repository.findOwned(
      input.campaignId,
      input.sessionId,
      input.user.id,
    );
    if (!existing) throw new CampaignContentHttpError(404, 'Sessão de conteúdo não encontrada.');
    if (new Date(existing.session.expiresAt).getTime() <= Date.now()) {
      throw new CampaignContentHttpError(410, 'Esta sessão de conteúdo expirou. Inicie uma nova sessão.');
    }
    if (!['collecting', 'ready_to_generate'].includes(existing.session.status)) {
      throw new CampaignContentHttpError(409, 'Esta sessão não está recebendo novas respostas.');
    }
    if (existing.messages.filter((message) => message.role === 'user').length >= CAMPAIGN_CONTENT_MAX_MESSAGES) {
      throw new CampaignContentHttpError(429, 'O limite de respostas desta sessão foi atingido.');
    }

    const text = input.text.trim();
    if (!text || text.length > CAMPAIGN_CONTENT_MAX_ANSWER_LENGTH) {
      throw new CampaignContentHttpError(400, 'A resposta deve ter entre 1 e 2.000 caracteres.');
    }
    const answers = applyDeterministicAnswer(
      existing.session.campaignSnapshot,
      existing.session.answers,
      existing.session.currentQuestionKey,
      text,
    );
    const missingFields = missingBriefingFields(existing.session.campaignSnapshot, answers);
    const currentQuestionKey = missingFields[0] ?? null;
    const status: CampaignContentSessionStatus = missingFields.length
      ? 'collecting'
      : 'ready_to_generate';
    const result = await this.repository.appendAnswer({
      campaignId: input.campaignId,
      sessionId: input.sessionId,
      userId: input.user.id,
      clientMessageId: input.clientMessageId,
      expectedVersion: input.expectedSessionVersion,
      answers,
      currentQuestionKey,
      status,
      answerText: text,
      assistantMessage: currentQuestionKey
        ? {
            text: questionForBriefingField(currentQuestionKey),
            type: 'question',
            metadata: { questionKey: currentQuestionKey },
          }
        : {
            text: 'Perfeito. Já tenho as informações necessárias. Agora posso gerar três opções de texto.',
            type: 'status',
            metadata: { status: 'ready_to_generate' },
          },
    });
    if (result.kind === 'not_found') {
      throw new CampaignContentHttpError(404, 'Sessão de conteúdo não encontrada.');
    }
    if (result.kind === 'conflict') {
      throw new CampaignContentHttpError(
        409,
        'A sessão foi atualizada em outra janela. Recarregue antes de continuar.',
      );
    }
    if (!result.value) {
      throw new CampaignContentHttpError(500, 'Sessão de conteúdo sem resultado após atualização.');
    }
    return this.toView(result.value);
  }

  async getState(input: {
    campaignId: string;
    token: string;
    user: CampaignContentUser;
  }): Promise<{
    canGenerate: boolean;
    session: CampaignContentSessionView | null;
    content: CampaignContentGeneratedContent | null;
    draftContent: CampaignContentGeneratedContent | null;
  }> {
    this.ensureEnabled();
    const context = await this.getReadableContext(input.campaignId, input.token, input.user);
    const staff = isStaff(input.user);
    const session = staff
      ? null
      : await this.repository.findLatestActive(input.campaignId, input.user.id);
    const saved = this.contentRepository
      ? staff
        ? await this.contentRepository.findLatestSavedForCampaign(input.campaignId)
        : await this.contentRepository.findLatestSaved(input.campaignId, input.user.id)
      : null;
    const draft = this.contentRepository && session && !staff
      ? await this.contentRepository.findLatestDraft(session.session.id, input.user.id)
      : null;
    return {
      canGenerate: context.canGenerate && !staff,
      session: session ? this.toView(session) : null,
      content: saved ? this.toContentView(saved) : null,
      draftContent: draft ? this.toContentView(draft) : null,
    };
  }

  async generate(input: {
    campaignId: string;
    sessionId: string;
    token: string;
    user: CampaignContentUser;
    generationKey: string;
  }): Promise<CampaignContentGeneratedContent> {
    this.ensureEnabled();
    const context = await this.getWritableContext(input.campaignId, input.token, input.user);
    const dependencies = this.requireGenerationDependencies();
    const session = await this.repository.findOwned(input.campaignId, input.sessionId, input.user.id);
    if (!session) throw new CampaignContentHttpError(404, 'Sessao de conteudo nao encontrada.');
    if (new Date(session.session.expiresAt).getTime() <= Date.now()) {
      throw new CampaignContentHttpError(410, 'Esta sessao de conteudo expirou. Inicie uma nova sessao.');
    }
    if (!['ready_to_generate', 'generating', 'options_ready'].includes(session.session.status)) {
      throw new CampaignContentHttpError(409, 'Esta sessao nao esta pronta para gerar conteudo.');
    }

    const policy = dependencies.lengthPolicy.getPolicyForDuration(
      session.session.campaignSnapshot.mediaChannel,
      session.session.campaignSnapshot.durationSeconds,
    );
    const reserved = await dependencies.contentRepository.reserveGeneration({
      campaignId: input.campaignId,
      sessionId: input.sessionId,
      userId: input.user.id,
      generationKey: input.generationKey,
      lengthPolicy: policy,
      mediaChannel: session.session.campaignSnapshot.mediaChannel,
      contentFormat: session.session.campaignSnapshot.format,
      modelName: this.config.OPENAI_MODEL,
      promptVersion: 'campaign-content-pt-br-v1',
    });
    if (reserved.kind === 'not_found') {
      throw new CampaignContentHttpError(404, 'Sessao de conteudo nao encontrada.');
    }
    if (reserved.kind === 'limit') {
      throw new CampaignContentHttpError(429, 'O limite de tres geracoes desta sessao foi atingido.');
    }
    if (reserved.kind === 'conflict') {
      throw new CampaignContentHttpError(409, 'A sessao nao esta disponivel para nova geracao.');
    }
    if (reserved.kind === 'existing') {
      return this.toContentView(reserved.value);
    }

    try {
      const generated = await dependencies.generator.generate({
        userId: input.user.id,
        campaignSnapshot: session.session.campaignSnapshot,
        answers: session.session.answers,
        lengthPolicy: policy,
        countWords: dependencies.lengthPolicy.countWords.bind(dependencies.lengthPolicy),
        isWithinPolicy: dependencies.lengthPolicy.isWithinPolicy.bind(dependencies.lengthPolicy),
      });
      const completed = await dependencies.contentRepository.completeGeneration({
        campaignId: input.campaignId,
        sessionId: input.sessionId,
        userId: input.user.id,
        generationId: reserved.value.content.id,
        options: generated.options,
      });
      if (!completed) throw new CampaignContentHttpError(404, 'Geracao de conteudo nao encontrada.');
      return this.toContentView(completed);
    } catch (error) {
      await dependencies.contentRepository.failGeneration({
        campaignId: input.campaignId,
        sessionId: input.sessionId,
        userId: input.user.id,
        generationId: reserved.value.content.id,
      });
      if (error instanceof CampaignContentLlmError) {
        throw new CampaignContentHttpError(503, error.message);
      }
      if (error instanceof CampaignContentHttpError) throw error;
      throw new CampaignContentHttpError(503, 'Nao foi possivel concluir a geracao de conteudo.');
    }
  }

  async saveSelection(input: {
    campaignId: string;
    sessionId: string;
    token: string;
    user: CampaignContentUser;
    generationId: string;
    optionId: string;
    finalText: string;
    expectedSessionVersion: number;
  }): Promise<CampaignContentGeneratedContent> {
    this.ensureEnabled();
    await this.getWritableContext(input.campaignId, input.token, input.user);
    const dependencies = this.requireGenerationDependencies();
    const session = await this.repository.findOwned(input.campaignId, input.sessionId, input.user.id);
    if (!session) throw new CampaignContentHttpError(404, 'Sessao de conteudo nao encontrada.');
    if (new Date(session.session.expiresAt).getTime() <= Date.now()) {
      throw new CampaignContentHttpError(410, 'Esta sessao de conteudo expirou. Inicie uma nova sessao.');
    }
    const finalText = input.finalText.trim();
    if (!finalText || finalText.length > 12_000) {
      throw new CampaignContentHttpError(400, 'O texto final deve ter entre 1 e 12.000 caracteres.');
    }
    const policy = dependencies.lengthPolicy.getPolicyForDuration(
      session.session.campaignSnapshot.mediaChannel,
      session.session.campaignSnapshot.durationSeconds,
    );
    const wordCount = dependencies.lengthPolicy.countWords(finalText);
    if (!dependencies.lengthPolicy.isWithinPolicy(wordCount, policy)) {
      throw new CampaignContentHttpError(
        422,
        `O texto deve ter entre ${policy.minWords} e ${policy.maxWords} palavras; o texto atual tem ${wordCount}.`,
      );
    }
    const result = await dependencies.contentRepository.saveSelection({
      campaignId: input.campaignId,
      sessionId: input.sessionId,
      userId: input.user.id,
      generationId: input.generationId,
      optionId: input.optionId,
      finalText,
      expectedSessionVersion: input.expectedSessionVersion,
      wordCount,
    });
    if (result.kind === 'not_found') {
      throw new CampaignContentHttpError(404, 'Geracao de conteudo nao encontrada.');
    }
    if (result.kind === 'invalid_option') {
      throw new CampaignContentHttpError(422, 'A opcao selecionada nao pertence a esta geracao.');
    }
    if (result.kind === 'conflict') {
      throw new CampaignContentHttpError(409, 'A sessao foi atualizada em outra janela. Recarregue antes de salvar.');
    }
    if ((result.kind === 'saved' || result.kind === 'duplicate') && this.emailProvider) {
      void this.dispatchEmail(input.campaignId, result.value.content.id);
    }
    return this.toContentView(result.value);
  }

  async retryEmail(input: {
    campaignId: string;
    generationId: string;
    token: string;
    user: CampaignContentUser;
  }): Promise<CampaignContentGeneratedContent> {
    this.ensureEnabled();
    if (!isStaff(input.user)) {
      throw new CampaignContentHttpError(403, 'Apenas a administracao pode reenviar esta notificacao.');
    }
    if (input.user.role.toLowerCase() === 'gestor') {
      await this.getReadableContext(input.campaignId, input.token, input.user);
    }
    const contentRepository = this.contentRepository;
    const emailProvider = this.emailProvider;
    if (!contentRepository || !emailProvider || !emailProvider.isEnabled()) {
      throw new CampaignContentHttpError(503, 'A notificacao administrativa ainda nao esta configurada.');
    }

    const claim = await contentRepository.claimEmailDelivery(input.campaignId, input.generationId);
    if (claim.kind === 'not_found') {
      throw new CampaignContentHttpError(404, 'Conteudo salvo nao encontrado.');
    }
    if (claim.kind === 'sending') {
      throw new CampaignContentHttpError(409, 'Este e-mail ja esta sendo enviado.');
    }
    if (claim.kind === 'unavailable') {
      throw new CampaignContentHttpError(409, 'Este conteudo nao esta disponivel para envio.');
    }
    if (claim.kind === 'sent') return this.toEmailContentView(claim.value);

    try {
      await emailProvider.send(toEmailInput(claim.value));
      await contentRepository.markEmailSent(input.generationId);
      return this.toEmailContentView({
        ...claim.value,
        content: { ...claim.value.content, emailStatus: 'sent' },
      });
    } catch (error) {
      await contentRepository.markEmailFailed(
        input.generationId,
        error instanceof Error ? error.message : 'Falha desconhecida no envio.',
      );
      throw new CampaignContentHttpError(503, 'Nao foi possivel enviar a notificacao administrativa.');
    }
  }

  private async dispatchEmail(campaignId: string, contentId: string): Promise<void> {
    const contentRepository = this.contentRepository;
    const emailProvider = this.emailProvider;
    if (!contentRepository || !emailProvider || !emailProvider.isEnabled()) return;

    try {
      const claim = await contentRepository.claimEmailDelivery(campaignId, contentId);
      if (claim.kind !== 'claimed') return;
      try {
        await emailProvider.send(toEmailInput(claim.value));
        await contentRepository.markEmailSent(contentId);
      } catch (error) {
        await contentRepository.markEmailFailed(
          contentId,
          error instanceof Error ? error.message : 'Falha desconhecida no envio.',
        );
      }
    } catch {
      // O conteúdo permanece pendente para a rotina de retry/admin quando a reserva falha.
    }
  }

  private async getWritableContext(
    campaignId: string,
    token: string,
    user: CampaignContentUser,
  ): Promise<CampaignContentContext> {
    if (isStaff(user)) {
      throw new CampaignContentHttpError(
        403,
        'A administração pode consultar o conteúdo, mas não iniciar ou alterar a sessão.',
      );
    }
    const context = await this.getReadableContext(campaignId, token, user);
    if (context.userId !== user.id) {
      throw new CampaignContentHttpError(403, 'Você não pode iniciar conteúdo para esta campanha.');
    }
    if (!context.canGenerate) {
      throw new CampaignContentHttpError(
        403,
        'Esta campanha ainda não está elegível para gerar conteúdo.',
      );
    }
    return context;
  }

  private async getReadableContext(
    campaignId: string,
    token: string,
    user: CampaignContentUser,
  ): Promise<CampaignContentContext> {
    try {
      const context = await this.contextClient.getCampaignContext(campaignId, token);
      if (context.campaignId !== campaignId) {
        throw new CampaignContentHttpError(502, 'O serviço de campanhas retornou contexto divergente.');
      }
      if (!isStaff(user) && context.userId !== user.id) {
        throw new CampaignContentHttpError(403, 'Você não pode acessar esta campanha.');
      }
      return context;
    } catch (error) {
      if (error instanceof CampaignContentHttpError) throw error;
      if (error instanceof CampaignContentContextError) {
        throw new CampaignContentHttpError(error.status, error.message);
      }
      throw new CampaignContentHttpError(502, 'Não foi possível consultar a campanha.');
    }
  }

  private toView(value: CampaignContentSessionWithMessages): CampaignContentSessionView {
    const session = value.session;
    return {
      sessionId: session.id,
      status: session.status,
      version: session.version,
      campaignContext: session.campaignSnapshot,
      answers: session.answers,
      currentQuestionKey: session.currentQuestionKey,
      missingFields: missingBriefingFields(session.campaignSnapshot, session.answers),
      messages: value.messages.map((message) => {
        const view: CampaignContentMessage = {
          id: message.id,
          role: message.role,
          type: message.type,
          text: message.text,
          createdAt: message.createdAt,
        };
        if (message.metadata !== null && message.metadata !== undefined) {
          view.metadata = message.metadata;
        }
        return view;
      }),
      expiresAt: session.expiresAt,
    };
  }

  private ensureEnabled(): void {
    if (!this.config.CAMPAIGN_CONTENT_ENABLED) {
      throw new CampaignContentHttpError(404, 'Conteúdo de campanha com IA indisponível.');
    }
  }

  private requireGenerationDependencies(): {
    contentRepository: CampaignContentRepository;
    generator: CampaignContentGenerator;
    lengthPolicy: CampaignContentLengthPolicyService;
  } {
    if (!this.contentRepository || !this.generator || !this.lengthPolicy) {
      throw new CampaignContentHttpError(503, 'Geracao de conteudo ainda nao esta configurada.');
    }
    return {
      contentRepository: this.contentRepository,
      generator: this.generator,
      lengthPolicy: this.lengthPolicy,
    };
  }

  private toContentView(value: ContentWithSessionVersion): CampaignContentGeneratedContent {
    return {
      generationId: value.content.id,
      status: value.content.status,
      sessionVersion: value.sessionVersion,
      lengthPolicy: value.content.lengthPolicy,
      options: value.content.options,
      selectedOptionId: value.content.selectedOptionId,
      selectedTextOriginal: value.content.selectedTextOriginal,
      finalText: value.content.finalText,
      isEdited: value.content.isEdited,
      wordCount: value.content.wordCount,
      emailStatus: value.content.emailStatus,
    };
  }

  private toEmailContentView(value: CampaignContentEmailDelivery): CampaignContentGeneratedContent {
    return this.toContentView({ content: value.content, sessionVersion: 0 });
  }
}

function toSnapshot(context: CampaignContentContext): CampaignContentCampaignSnapshot {
  return {
    campaignName: context.campaignName,
    brandName: context.brandName,
    objective: context.objective,
    mediaChannel: context.mediaChannel,
    format: context.format,
    durationSeconds: context.durationSeconds,
    paymentStatus: context.paymentStatus,
    startDate: context.startDate,
    endDate: context.endDate,
    targetAudience: context.targetAudience,
    contextVersion: context.contextVersion,
  };
}

function isStaff(user: CampaignContentUser): boolean {
  const role = user.role.toLowerCase();
  return role === 'admin' || role === 'gestor';
}

function toEmailInput(value: CampaignContentEmailDelivery): CampaignContentEmailInput {
  const { content } = value;
  if (!content.selectedTextOriginal || !content.finalText || content.wordCount === null) {
    throw new Error('Conteudo salvo incompleto para notificacao administrativa.');
  }
  return {
    campaignId: content.campaignId,
    contentId: content.id,
    campaignSnapshot: value.campaignSnapshot,
    selectedTextOriginal: content.selectedTextOriginal,
    finalText: content.finalText,
    isEdited: content.isEdited,
    wordCount: content.wordCount,
    lengthPolicy: content.lengthPolicy,
  };
}
