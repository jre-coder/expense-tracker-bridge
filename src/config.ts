/**
 * Bridge configuration. The file holds NAMES of environment variables, never
 * secrets: the schema is strict (no field exists in which a token could be
 * stored) and every string value is scanned for credential shapes.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { scanText } from './redaction.js';

export const CONFIG_FILENAME = 'expense-bridge.config.json';
export const PROVIDERS = ['anthropic', 'openai', 'ollama'] as const;
export type ProviderName = (typeof PROVIDERS)[number];

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const REPO = /^[A-Za-z0-9][\w-]*\/(?!\.{1,2}$)[\w.-]+$/;

const DEFAULT_MODELS: Record<ProviderName, string> = {
  anthropic: 'claude-opus-5-5',
  openai: 'gpt-4.1',
  ollama: 'llama3.1',
};
const DEFAULT_KEY_ENV: Record<ProviderName, string | undefined> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  ollama: undefined,
};
export const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434';

const envName = (field: string) =>
  z.string().regex(ENV_NAME, `${field} must be the NAME of an environment variable (e.g. GITHUB_TOKEN), never its value`);

export const ConfigSchema = z
  .object({
    /** owner/name of the GitHub repository to read. */
    repo: z.string().regex(REPO, 'repo must be owner/name'),
    github_token_env: envName('github_token_env').default('GITHUB_TOKEN'),
    provider: z.enum(PROVIDERS),
    model: z.string().min(1),
    /** Env var holding the LLM key; required for anthropic and openai. */
    provider_key_env: envName('provider_key_env').optional(),
    /** Override the provider endpoint (Ollama host, proxy). */
    provider_base_url: z.string().url().optional(),
    /** Base URL of the Expense Tracker API, e.g. https://<project>.supabase.co/functions/v1 */
    api_base_url: z.string().url(),
    bridge_key_env: envName('bridge_key_env').default('EXPENSE_BRIDGE_KEY'),
    /** The project this bridge key is scoped to; the server double-checks it. */
    project_ref: z.string().min(1),
    cursor_file: z.string().min(1).default('.expense-bridge/cursor.json'),
    queue_file: z.string().min(1).default('.expense-bridge/queue.json'),
    feedback_file: z.string().min(1).default('.expense-bridge/feedback.json'),
    /** Upper bound on the diff text handed to YOUR model. Never sent anywhere else. */
    max_diff_chars: z.number().int().positive().default(60_000),
    resolution_min_confidence: z.number().min(0).max(1).default(0.6),
    identifier_density_threshold: z.number().positive().default(3),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    if (cfg.provider !== 'ollama' && !cfg.provider_key_env) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['provider_key_env'], message: `provider_key_env is required for provider "${cfg.provider}"` });
    }
    for (const [key, value] of Object.entries(cfg)) {
      if (typeof value !== 'string') continue;
      const hit = scanText(value, { allowedHosts: [] }).findings.find((f) => f.class.startsWith('secret:'));
      if (hit) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `looks like a credential (${hit.class}); the config file must never contain secrets` });
      }
    }
  });

export type Config = z.infer<typeof ConfigSchema>;
export type ConfigInput = z.input<typeof ConfigSchema>;

export interface DefaultConfigOptions {
  repo: string;
  provider: ProviderName;
  model?: string;
  api_base_url: string;
  project_ref: string;
}

export function defaultConfig(opts: DefaultConfigOptions): Config {
  const input: ConfigInput = {
    repo: opts.repo,
    provider: opts.provider,
    model: opts.model ?? DEFAULT_MODELS[opts.provider],
    api_base_url: opts.api_base_url,
    project_ref: opts.project_ref,
  };
  const keyEnv = DEFAULT_KEY_ENV[opts.provider];
  if (keyEnv) input.provider_key_env = keyEnv;
  if (opts.provider === 'ollama') input.provider_base_url = OLLAMA_DEFAULT_BASE_URL;
  return ConfigSchema.parse(input);
}

export function loadConfig(path: string): Config {
  if (!existsSync(path)) throw new Error(`No config at ${path}. Run \`expense-bridge init\` first.`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.') || '<root>'}: ${i.message}`).join('\n');
    throw new Error(`${path} is invalid:\n${issues}`);
  }
  return parsed.data;
}

export function writeConfig(path: string, config: Config): void {
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
}

export type SecretKind = 'github' | 'bridge' | 'provider';
export interface Secrets {
  githubToken: string | null;
  bridgeKey: string | null;
  providerKey: string | null;
}

/** Secrets come from the environment only. Error messages name the variable, never a value. */
export function resolveSecrets(
  config: Config,
  env: Record<string, string | undefined>,
  options: { need?: SecretKind[] } = {},
): Secrets {
  const need = new Set<SecretKind>(options.need ?? ['github', 'bridge', 'provider']);
  const read = (name: string, purpose: string): string => {
    const value = env[name];
    if (!value) throw new Error(`Environment variable ${name} is not set (${purpose}).`);
    return value;
  };
  const githubToken = need.has('github') ? read(config.github_token_env, 'GitHub token for reading pull requests') : null;
  const bridgeKey = need.has('bridge') ? read(config.bridge_key_env, 'Expense Tracker bridge key') : null;
  let providerKey: string | null = null;
  if (need.has('provider') && config.provider_key_env) {
    providerKey = read(config.provider_key_env, `${config.provider} API key`);
  }
  return { githubToken, bridgeKey, providerKey };
}
