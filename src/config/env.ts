import { z } from 'zod';

// Node >= 22 can read .env files natively; a missing file is fine (env may come from the host).
try {
  process.loadEnvFile();
} catch {
  /* no .env file */
}

const optionalString = z
  .string()
  .optional()
  .transform((value) => (value && value.trim() ? value.trim() : undefined));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  CORS_ORIGIN: z.string().default('http://localhost:4200'),

  DATABASE_URL: z.string().min(1).default('postgres://postgres:postgres@localhost:5432/knowledge_hub'),
  DATABASE_SSL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  RESEARCH_PROVIDER: z.enum(['auto', 'claude', 'open-data']).default('auto'),
  ANTHROPIC_API_KEY: optionalString,
  ANTHROPIC_AUTH_TOKEN: optionalString,
  ANTHROPIC_MODEL: z.string().default('claude-opus-5-5'),
  RESEARCH_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
  WEB_SEARCH_MAX_USES: z.coerce.number().int().min(1).max(20).default(6),
  RESEARCH_RATE_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(30),

  CONTACT_EMAIL: optionalString,
  OPENALEX_API_KEY: optionalString,

  // Auth & deployment
  SESSION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  ALLOW_REGISTRATION: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  TRUST_PROXY: z.string().default('loopback'),
  FRONTEND_DIST: optionalString,
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', z.prettifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;

export const corsOrigins = env.CORS_ORIGIN.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

export const hasClaudeCredentials = Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);

export const researchProvider: 'claude' | 'open-data' =
  env.RESEARCH_PROVIDER === 'auto' ? (hasClaudeCredentials ? 'claude' : 'open-data') : env.RESEARCH_PROVIDER;

export const userAgent = `KnowledgeHub/1.0 (${env.CONTACT_EMAIL ?? 'personal research dashboard'})`;

/** Secure cookies require HTTPS; default on in production, off in development. */
export const cookieSecure = env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : env.NODE_ENV === 'production';

/** Express "trust proxy": 'loopback' fits an Nginx on the same machine. */
export const trustProxy: boolean | number | string = /^\d+$/.test(env.TRUST_PROXY)
  ? Number(env.TRUST_PROXY)
  : env.TRUST_PROXY === 'true'
    ? true
    : env.TRUST_PROXY === 'false'
      ? false
      : env.TRUST_PROXY;
