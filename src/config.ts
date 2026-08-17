import 'dotenv/config';
import { z } from 'zod';

const encryptionKeySchema = z.string().refine(
  (value) => {
    try {
      return Buffer.from(value, 'base64').length === 32;
    } catch {
      return false;
    }
  },
  { message: 'deve ser uma chave base64 de 32 bytes' },
);

const booleanFromString = (defaultValue: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(defaultValue)
    .transform((value) => value === 'true');

const emailList = z.preprocess(
  (value) => typeof value === 'string' ? value.split(',').map((item) => item.trim()).filter(Boolean) : value,
  z.array(z.string().email()).default(['falecoma@ummix.com.br', 'tecnologia@ummix.com.br']),
);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3010),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().min(1),
  UMMIX_API_URL: z.string().url().transform((value) => value.replace(/\/$/, '')),
  UMMIX_WEB_URL: z.string().url().transform((value) => value.replace(/\/$/, '')),
  AI_WEB_ORIGIN: z.string().url().default('http://localhost:3007'),
  CAMPAIGN_ASSISTANT_ENABLED: booleanFromString('true'),
  CAMPAIGN_CONTENT_ENABLED: booleanFromString('false'),
  UMMIX_SERVICE_TOKEN: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(32).optional(),
  ),
  AI_HANDOFF_ENCRYPTION_KEY: encryptionKeySchema,
  AI_HANDOFF_TTL_SECONDS: z.coerce.number().int().min(30).max(300).default(60),
  SESSION_TTL_MINUTES: z.coerce.number().int().min(15).max(1440).default(120),
  MESSAGE_LIMIT_PER_WINDOW: z.coerce.number().int().min(1).max(100).default(20),
  MESSAGE_WINDOW_MINUTES: z.coerce.number().int().min(1).max(60).default(10),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().min(1).default('gpt-5.6-luna'),
  CAMPAIGN_CONTENT_LENGTH_POLICY_VERSION: z.string().min(1).default('pt-br-v1'),
  CAMPAIGN_CONTENT_MIN_WORDS_PER_SECOND: z.coerce.number().positive().default(2.2),
  CAMPAIGN_CONTENT_MAX_WORDS_PER_SECOND: z.coerce.number().positive().default(2.6),
  CAMPAIGN_CONTENT_EMAIL_ENABLED: booleanFromString('false'),
  CAMPAIGN_CONTENT_ADMIN_EMAILS: emailList,
  CAMPAIGN_CONTENT_EMAIL_API_KEY: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().optional(),
  ),
  CAMPAIGN_CONTENT_EMAIL_API_URL: z.string().url().default('https://api.brevo.com/v3/smtp/email'),
  CAMPAIGN_CONTENT_EMAIL_FROM: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().email().optional(),
  ),
  CAMPAIGN_CONTENT_EMAIL_FROM_NAME: z.string().min(1).default('Ummix Ads'),
  CAMPAIGN_CONTENT_EMAIL_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),
}).superRefine((config, context) => {
  const integrationEnabled = config.CAMPAIGN_ASSISTANT_ENABLED || config.CAMPAIGN_CONTENT_ENABLED;
  if (config.NODE_ENV === 'production' && integrationEnabled && !config.UMMIX_SERVICE_TOKEN) {
    context.addIssue({
      code: 'custom',
      path: ['UMMIX_SERVICE_TOKEN'],
      message: 'é obrigatório quando um módulo de campanha está habilitado em produção',
    });
  }
  if (config.NODE_ENV === 'production' && config.CAMPAIGN_CONTENT_ENABLED && !config.OPENAI_API_KEY) {
    context.addIssue({
      code: 'custom',
      path: ['OPENAI_API_KEY'],
      message: 'é obrigatório quando o conteúdo de campanha está habilitado em produção',
    });
  }
  if (config.CAMPAIGN_CONTENT_EMAIL_ENABLED) {
    if (!config.CAMPAIGN_CONTENT_EMAIL_API_KEY) {
      context.addIssue({
        code: 'custom',
        path: ['CAMPAIGN_CONTENT_EMAIL_API_KEY'],
        message: 'é obrigatório quando o envio administrativo está habilitado',
      });
    }
    if (!config.CAMPAIGN_CONTENT_EMAIL_FROM) {
      context.addIssue({
        code: 'custom',
        path: ['CAMPAIGN_CONTENT_EMAIL_FROM'],
        message: 'é obrigatório quando o envio administrativo está habilitado',
      });
    }
  }
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(environment);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Configuração inválida: ${details}`);
  }
  return parsed.data;
}
