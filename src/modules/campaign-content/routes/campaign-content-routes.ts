import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../../../config.js';
import { UmmixApiError, UmmixClient, type UmmixUser } from '../../campaign-assistant/ummix/ummix-client.js';
import {
  CampaignContentHttpError,
  CampaignContentService,
  type CampaignContentUser,
} from '../services/campaign-content-service.js';

interface AuthenticatedRequest extends FastifyRequest {
  campaignContentAuth: {
    token: string;
    user: CampaignContentUser;
  };
}

const campaignParamsSchema = z.object({ campaignId: z.string().uuid() });
const sessionParamsSchema = z.object({
  campaignId: z.string().uuid(),
  sessionId: z.string().uuid(),
});
const emailParamsSchema = z.object({
  campaignId: z.string().uuid(),
  generationId: z.string().uuid(),
});
const emptyBodySchema = z.object({}).strict();
const messageSchema = z.object({
  clientMessageId: z.string().uuid(),
  text: z.string().trim().min(1).max(2_000),
  expectedSessionVersion: z.number().int().min(0),
});
const generationSchema = z.object({
  generationKey: z.string().uuid(),
}).strict();
const selectionSchema = z.object({
  generationId: z.string().uuid(),
  optionId: z.string().trim().min(1).max(80),
  finalText: z.string().trim().min(1).max(12_000),
  expectedSessionVersion: z.number().int().min(0),
}).strict();

export async function campaignContentRoutes(
  app: FastifyInstance,
  options: {
    config: AppConfig;
    service: CampaignContentService;
    ummix: UmmixClient;
  },
): Promise<void> {
  app.addHook('preHandler', async (rawRequest, reply) => {
    if (!options.config.CAMPAIGN_CONTENT_ENABLED) {
      return reply.code(404).send({ message: 'Conteúdo de campanha com IA indisponível' });
    }
    const authorization = rawRequest.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) {
      return reply.code(401).send({ message: 'Token de autenticação ausente' });
    }
    const token = authorization.slice('Bearer '.length).trim();
    if (!token) return reply.code(401).send({ message: 'Token de autenticação ausente' });
    try {
      const user = await options.ummix.getCurrentUser(token);
      (rawRequest as AuthenticatedRequest).campaignContentAuth = {
        token,
        user: toCampaignContentUser(user),
      };
    } catch (error) {
      if (error instanceof UmmixApiError) {
        return reply.code(error.status === 401 || error.status === 403 ? 401 : 502)
          .send({ message: error.status === 401 || error.status === 403
            ? 'Sessão inválida ou expirada'
            : 'Serviço de autenticação indisponível' });
      }
      return reply.code(401).send({ message: 'Sessão inválida ou expirada' });
    }
  });

  app.get('/', async (rawRequest) => {
    const request = rawRequest as AuthenticatedRequest;
    const { campaignId } = campaignParamsSchema.parse(rawRequest.params);
    return options.service.getState({
      campaignId,
      token: request.campaignContentAuth.token,
      user: request.campaignContentAuth.user,
    });
  });

  app.post('/sessions', async (rawRequest, reply) => {
    emptyBodySchema.parse(rawRequest.body ?? {});
    const request = rawRequest as AuthenticatedRequest;
    const { campaignId } = campaignParamsSchema.parse(rawRequest.params);
    const session = await options.service.createOrResumeSession({
      campaignId,
      token: request.campaignContentAuth.token,
      user: request.campaignContentAuth.user,
    });
    return reply.code(201).send(session);
  });

  app.post('/sessions/:sessionId/messages', async (rawRequest) => {
    const request = rawRequest as AuthenticatedRequest;
    const params = sessionParamsSchema.parse(rawRequest.params);
    const body = messageSchema.parse(rawRequest.body);
    return options.service.addMessage({
      ...params,
      ...body,
      token: request.campaignContentAuth.token,
      user: request.campaignContentAuth.user,
    });
  });

  app.post('/sessions/:sessionId/generate', async (rawRequest, reply) => {
    const request = rawRequest as AuthenticatedRequest;
    const params = sessionParamsSchema.parse(rawRequest.params);
    const body = generationSchema.parse(rawRequest.body);
    const result = await options.service.generate({
      ...params,
      ...body,
      token: request.campaignContentAuth.token,
      user: request.campaignContentAuth.user,
    });
    return reply.code(result.status === 'generating' ? 202 : 200).send(result);
  });

  app.put('/sessions/:sessionId/selection', async (rawRequest) => {
    const request = rawRequest as AuthenticatedRequest;
    const params = sessionParamsSchema.parse(rawRequest.params);
    const body = selectionSchema.parse(rawRequest.body);
    return options.service.saveSelection({
      ...params,
      ...body,
      token: request.campaignContentAuth.token,
      user: request.campaignContentAuth.user,
    });
  });

  app.post('/:generationId/email/retry', async (rawRequest) => {
    const request = rawRequest as AuthenticatedRequest;
    const params = emailParamsSchema.parse(rawRequest.params);
    return options.service.retryEmail({
      ...params,
      token: request.campaignContentAuth.token,
      user: request.campaignContentAuth.user,
    });
  });
}

export function campaignContentErrorHandler(
  error: unknown,
  _request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (error instanceof z.ZodError) {
    return reply.code(400).send({
      message: 'Dados inválidos',
      issues: error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  if (error instanceof CampaignContentHttpError) {
    return reply.code(error.statusCode).send({ message: error.message });
  }
  return reply.code(500).send({ message: 'Erro interno do conteúdo de campanha' });
}

function toCampaignContentUser(user: UmmixUser): CampaignContentUser {
  return {
    id: user.id,
    role: user.role,
    userType: user.userType,
  };
}
