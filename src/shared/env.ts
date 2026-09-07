// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export const MIN_SALT_LENGTH = 16;

export const COMMAND_NAMES = [
  'crawl',
  'harvest',
  'load',
  'layer1',
  'layer2',
  'audit',
  'analyze',
  'report',
  'seeds',
] as const;

export type CommandName = (typeof COMMAND_NAMES)[number];

export const GCP_COMMANDS = [
  'load',
  'layer1',
  'layer2',
  'audit',
  'analyze',
  'report',
  'seeds',
] as const;

const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));

export const DEFAULT_CONFIG_PATH = path.join(PACKAGE_ROOT, 'config', 'default.yaml');

export const appConfigSchema = z.object({
  layer2: z.object({
    cosine_distance_threshold: z.coerce.number().positive(),
    embedding_model: z.string().min(1),
    task_type: z.string().min(1),
    review_embed_batch_rows: z.coerce.number().int().positive(),
    comment_char_cap: z.coerce.number().int().positive(),
  }),
  cross_store: z.object({
    cosine_distance_threshold: z.coerce.number().positive(),
  }),
  gemini: z.object({
    model: z.string().min(1),
    thinking_budget: z.coerce.number().int().nonnegative(),
    thinking_level: z.string().min(1),
    temperature: z.coerce.number(),
    max_output_tokens: z.coerce.number().int().positive(),
  }),
  audit: z.object({
    concurrency: z.coerce.number().int().min(5).max(10),
    default_limit_non_prod: z.coerce.number().int().positive(),
    max_reviews_per_run: z.coerce.number().int().positive(),
  }),
  seed_version: z.string().min(1),
  prompt_version: z.string().min(1),
});

export type AppConfig = z.infer<typeof appConfigSchema>;

const hmacEnvSchema = z.object({
  REVIEWER_ID_SALT: z.string().min(MIN_SALT_LENGTH),
  APP_ENV: z.enum(['dev', 'test', 'prod']),
  LOG_LEVEL: z.string().min(1),
});

export type HmacEnv = z.infer<typeof hmacEnvSchema>;

const gcpEnvSchema = z.object({
  GCP_PROJECT: z.string().min(1, 'GCP_PROJECT is required'),
  GCP_LOCATION: z.string().min(1, 'GCP_LOCATION is required'),
  BQ_DATASET: z.string().min(1, 'BQ_DATASET is required'),
  GCS_STAGING_BUCKET: z.string().optional(),
  BQ_CONNECTION_ID: z.string().optional(),
  // Gemini generateContent is not published in asia-east1; BQ/embeddings stay GCP_LOCATION.
  GEMINI_LOCATION: z.string().optional(),
});

export type GcpEnv = z.infer<typeof gcpEnvSchema>;

export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvError';
  }
}

export function assertSalt(value: string | undefined): string {
  if (value === undefined || value === '') {
    throw new EnvError(
      'REVIEWER_ID_SALT is required (min 16 characters) and must not be empty',
    );
  }
  if (value.length < MIN_SALT_LENGTH) {
    throw new EnvError(
      `REVIEWER_ID_SALT must be at least ${MIN_SALT_LENGTH} characters (got ${String(value.length)})`,
    );
  }
  return value;
}

export function loadDefaultConfig(configPath = DEFAULT_CONFIG_PATH): AppConfig {
  const raw: unknown = parseYaml(readFileSync(configPath, 'utf8'));
  return appConfigSchema.parse(raw);
}

function overlayEnvOnConfig(base: AppConfig, env: NodeJS.ProcessEnv): AppConfig {
  return appConfigSchema.parse({
    ...base,
    layer2: {
      ...base.layer2,
      cosine_distance_threshold:
        env['COSINE_DISTANCE_THRESHOLD'] ?? base.layer2.cosine_distance_threshold,
      embedding_model: env['EMBEDDING_MODEL'] ?? base.layer2.embedding_model,
    },
    cross_store: {
      cosine_distance_threshold:
        env['CROSS_STORE_COSINE_DISTANCE_THRESHOLD'] ??
        base.cross_store.cosine_distance_threshold,
    },
    gemini: {
      ...base.gemini,
      model: env['GEMINI_MODEL'] ?? base.gemini.model,
      thinking_budget: env['GEMINI_THINKING_BUDGET'] ?? base.gemini.thinking_budget,
      thinking_level: env['GEMINI_THINKING_LEVEL'] ?? base.gemini.thinking_level,
      temperature: env['GEMINI_TEMPERATURE'] ?? base.gemini.temperature,
      max_output_tokens: env['GEMINI_MAX_OUTPUT_TOKENS'] ?? base.gemini.max_output_tokens,
    },
    audit: {
      ...base.audit,
      concurrency: env['AUDIT_CONCURRENCY'] ?? base.audit.concurrency,
      max_reviews_per_run:
        env['MAX_GEMINI_REVIEWS_PER_RUN'] ?? base.audit.max_reviews_per_run,
    },
    seed_version: env['SEED_VERSION'] ?? base.seed_version,
    prompt_version: env['PROMPT_VERSION'] ?? base.prompt_version,
  });
}

export function commandRequiresGcp(command: CommandName, dryRun: boolean): boolean {
  if (dryRun) {
    return false;
  }
  return (GCP_COMMANDS as readonly string[]).includes(command);
}

export class BrightDataCredentialsError extends Error {
  readonly exitCode = 1;

  constructor(message: string) {
    super(message);
    this.name = 'BrightDataCredentialsError';
  }
}

const BROWSER_COUNTRY_SUFFIX_RE = /-country-[a-z]{2}$/i;

export type BrightDataBrowserEnv = {
  username: string;
  password: string;
};

export function loadBrightDataBrowserEnv(
  env: NodeJS.ProcessEnv = process.env,
): BrightDataBrowserEnv {
  const username = env['BRIGHTDATA_BROWSERAPI_USERNAME'];
  const password = env['BRIGHTDATA_BROWSERAPI_PASSWORD'];
  if (username === undefined || username === '' || password === undefined || password === '') {
    throw new BrightDataCredentialsError(
      'BRIGHTDATA_BROWSERAPI_USERNAME and BRIGHTDATA_BROWSERAPI_PASSWORD are required for live harvest',
    );
  }
  if (BROWSER_COUNTRY_SUFFIX_RE.test(username)) {
    throw new BrightDataCredentialsError(
      'BRIGHTDATA_BROWSERAPI_USERNAME must not already end in -country-xx; remove the country suffix from the env username; harvest appends -country-<iso>',
    );
  }
  return { username, password };
}

export class ScrapingBeeCredentialsError extends Error {
  readonly exitCode = 1;

  constructor(
    message = 'SCRAPINGBEE_API_KEY is required for --transport scrapingbee live harvest',
  ) {
    super(message);
    this.name = 'ScrapingBeeCredentialsError';
  }
}

export function loadScrapingBeeEnv(env: NodeJS.ProcessEnv = process.env): { apiKey: string } {
  const apiKey = env['SCRAPINGBEE_API_KEY'];
  if (apiKey === undefined || apiKey === '' || apiKey === 'YOUR_API_KEY') {
    throw new ScrapingBeeCredentialsError();
  }
  return { apiKey };
}

export type LoadEnvOptions = {
  command: CommandName;
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
  configPath?: string;
};

export type LoadedEnv = {
  hmac: HmacEnv;
  config: AppConfig;
  gcp?: GcpEnv;
};

export function loadEnv(opts: LoadEnvOptions): LoadedEnv {
  const env = opts.env ?? process.env;
  const salt = assertSalt(env['REVIEWER_ID_SALT']);
  const hmac = hmacEnvSchema.parse({
    REVIEWER_ID_SALT: salt,
    APP_ENV: env['APP_ENV'] ?? 'dev',
    LOG_LEVEL: env['LOG_LEVEL'] ?? 'info',
  });
  const config = overlayEnvOnConfig(loadDefaultConfig(opts.configPath), env);
  const dryRun = opts.dryRun === true;
  if (!commandRequiresGcp(opts.command, dryRun)) {
    return { hmac, config };
  }
  const gcp = gcpEnvSchema.parse({
    GCP_PROJECT: env['GCP_PROJECT'],
    GCP_LOCATION: env['GCP_LOCATION'],
    BQ_DATASET: env['BQ_DATASET'],
    GCS_STAGING_BUCKET: env['GCS_STAGING_BUCKET'],
    BQ_CONNECTION_ID: env['BQ_CONNECTION_ID'],
    GEMINI_LOCATION: env['GEMINI_LOCATION'],
  });
  return { hmac, config, gcp };
}

export function isProd(hmac: HmacEnv, iAmProdFlag = false): boolean {
  return iAmProdFlag || hmac.APP_ENV === 'prod';
}
