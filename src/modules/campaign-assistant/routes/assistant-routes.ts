import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../../../config.js';
import { AssistantHttpError, AssistantService } from '../services/assistant-service.js';
import { UmmixApiError, UmmixClient, type UmmixUser } from '../ummix/ummix-client.js';

interface AuthenticatedRequest extends FastifyRequest {
  assistantAuth: {
    token: string;
    user: UmmixUser;
  };
}

const idParamsSchema = z.object({ id: z.string().uuid() });
const createSessionSchema = z.object({ clientId: z.string().uuid().optional() });
const messageSchema = z.object({ message: z.string().trim().min(1).max(2000) });
const locationSelectionSchema = z.object({
  cityIds: z.array(z.string().uuid()).min(1).max(10),
});
const audienceClarificationSchema = z.object({
  alternativeId: z.string().trim().min(1).max(80),
});

export async function assistantRoutes(
  app: FastifyInstance,
  options: {
    config: AppConfig;
    assistant: AssistantService;
    ummix: UmmixClient;
  },
): Promise<void> {
  app.addHook('preHandler', async (rawRequest, reply) => {
    if (!options.config.CAMPAIGN_ASSISTANT_ENABLED) {
      return reply.code(404).send({ message: 'Assistente não disponível' });
    }
    const authorization = rawRequest.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) {
      return reply.code(401).send({ message: 'Token de autenticação ausente' });
    }
    const token = authorization.slice('Bearer '.length).trim();
    try {
      const user = await options.ummix.getCurrentUser(token);
      (rawRequest as AuthenticatedRequest).assistantAuth = { token, user };
    } catch {
      return reply.code(401).send({ message: 'Sessão inválida ou expirada' });
    }
  });

  app.get('/context', async (rawRequest) => {
    const request = rawRequest as AuthenticatedRequest;
    return options.assistant.getContext(
      request.assistantAuth.token,
      request.assistantAuth.user,
    );
  });

  app.post('/sessions', async (rawRequest, reply) => {
    const request = rawRequest as AuthenticatedRequest;
    const body = createSessionSchema.parse(rawRequest.body ?? {});
    const session = await options.assistant.createSession({
      token: request.assistantAuth.token,
      user: request.assistantAuth.user,
      ...(body.clientId ? { clientId: body.clientId } : {}),
    });
    return reply.code(201).send(session);
  });

  app.get('/sessions/:id', async (rawRequest) => {
    const request = rawRequest as AuthenticatedRequest;
    const { id } = idParamsSchema.parse(rawRequest.params);
    return options.assistant.getSession(
      id,
      request.assistantAuth.user.id,
      request.assistantAuth.token,
    );
  });

  app.post('/sessions/:id/messages', async (rawRequest) => {
    const request = rawRequest as AuthenticatedRequest;
    const { id } = idParamsSchema.parse(rawRequest.params);
    const { message } = messageSchema.parse(rawRequest.body);
    return options.assistant.sendMessage({
      id,
      message,
      token: request.assistantAuth.token,
      user: request.assistantAuth.user,
    });
  });

  app.post('/sessions/:id/locations', async (rawRequest) => {
    const request = rawRequest as AuthenticatedRequest;
    const { id } = idParamsSchema.parse(rawRequest.params);
    const { cityIds } = locationSelectionSchema.parse(rawRequest.body);
    return options.assistant.selectLocations({
      id,
      cityIds,
      token: request.assistantAuth.token,
      user: request.assistantAuth.user,
    });
  });

  app.post('/sessions/:id/audience/clarification', async (rawRequest) => {
    const request = rawRequest as AuthenticatedRequest;
    const { id } = idParamsSchema.parse(rawRequest.params);
    const { alternativeId } = audienceClarificationSchema.parse(rawRequest.body);
    return options.assistant.confirmAudienceClarification({
      id,
      alternativeId,
      token: request.assistantAuth.token,
      user: request.assistantAuth.user,
    });
  });

  app.post('/sessions/:id/finalize', async (rawRequest) => {
    const request = rawRequest as AuthenticatedRequest;
    const { id } = idParamsSchema.parse(rawRequest.params);
    return options.assistant.finalize({
      id,
      token: request.assistantAuth.token,
      user: request.assistantAuth.user,
    });
  });

  app.post('/sessions/:id/review-reached', async (rawRequest, reply) => {
    const request = rawRequest as AuthenticatedRequest;
    const { id } = idParamsSchema.parse(rawRequest.params);
    await options.assistant.markReviewReached(id, request.assistantAuth.user);
    return reply.code(204).send();
  });

  app.delete('/sessions/:id', async (rawRequest, reply) => {
    const request = rawRequest as AuthenticatedRequest;
    const { id } = idParamsSchema.parse(rawRequest.params);
    await options.assistant.deleteSession(id, request.assistantAuth.user.id);
    return reply.code(204).send();
  });
}

export function assistantErrorHandler(
  error: Error,
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
  if (error instanceof AssistantHttpError) {
    return reply.code(error.statusCode).send({ message: error.message });
  }
  if (error instanceof UmmixApiError) {
    return reply.code(error.status).send({ message: error.message });
  }
  return reply.code(500).send({ message: 'Erro interno do assistente' });
}
