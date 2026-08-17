import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { ZodError, z } from 'zod';
import type { AppConfig } from '../../config.js';
import { UmmixAuthClient, UmmixAuthClientError } from '../../integrations/ummix-auth-client.js';
import { HandoffCipher } from './handoff-crypto.js';
import { PostgresHandoffRepository } from './handoff-repository.js';
import { HandoffError, HandoffService } from './handoff-service.js';

export async function registerPlatformAuth(
  app: FastifyInstance,
  dependencies: { config: AppConfig; pool: Pool },
): Promise<void> {
  const { config, pool } = dependencies;
  const authClient = new UmmixAuthClient(config.UMMIX_API_URL);
  const handoff = new HandoffService(
    new PostgresHandoffRepository(pool),
    new HandoffCipher(config.AI_HANDOFF_ENCRYPTION_KEY),
    config.AI_HANDOFF_TTL_SECONDS,
  );

  const createHandler = async (request: FastifyRequest) => {
    const accessToken = bearerToken(request.headers.authorization);
    const user = await authClient.getCurrentUser(accessToken);
    return handoff.create(accessToken, user);
  };

  const exchangeHandler = async (request: FastifyRequest) => {
    const body = z
      .object({ handoffToken: z.string().regex(/^[a-f0-9]{64}$/i) })
      .parse(request.body);
    return handoff.consume(body.handoffToken);
  };

  await app.register(
    async (scoped) => {
      scoped.post('/handoff', createHandler);
      scoped.post('/handoff/exchange', exchangeHandler);
      scoped.setErrorHandler(platformAuthErrorHandler);
    },
    { prefix: '/api/auth' },
  );

  await app.register(
    async (scoped) => {
      scoped.post('/exchange', exchangeHandler);
      scoped.setErrorHandler(platformAuthErrorHandler);
    },
    { prefix: '/api/campaign-assistant/auth/handoff' },
  );
}

function bearerToken(authorization: string | undefined): string {
  if (!authorization?.startsWith('Bearer ')) {
    throw new HandoffError('Sessão de autenticação ausente', 401);
  }
  const token = authorization.slice('Bearer '.length).trim();
  if (!token) throw new HandoffError('Sessão de autenticação ausente', 401);
  return token;
}

function platformAuthErrorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (error instanceof HandoffError || error instanceof UmmixAuthClientError) {
    return reply.status(error.status).send({ message: error.message });
  }
  if (error instanceof ZodError) {
    return reply.status(400).send({ message: 'Dados de handoff inválidos' });
  }
  request.log.error({ errorName: error.name }, 'Falha não tratada no handoff');
  return reply.status(500).send({ message: 'Não foi possível concluir o handoff' });
}
