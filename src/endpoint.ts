import { SYSTEM_ONE_URL } from './request.js';

/** OpenRouter's Decisions endpoint: same request body and `answers` as System One. */
export const OPENROUTER_DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';

export type JevProvider = 'typesafe' | 'openrouter';
export type JevKeyName = 'TYPESAFE_API_KEY' | 'OPENROUTER_API_KEY';
export type JevKeys = Partial<Record<JevKeyName, string>>;

export interface JevEndpointInput {
  /** An explicit key; wins over every named key. */
  apiKey?: string;
  /** An explicit endpoint; wins over `provider`. */
  baseUrl?: string;
  /** `typesafe` or `openrouter`; anything else is ignored. */
  provider?: string;
  /** Keys found under their usual names (environment, settings, dotenv). */
  keys?: JevKeys;
}

export interface JevEndpoint {
  baseUrl: string;
  provider: JevProvider | 'custom';
  apiKey?: string;
  /** The name the key is expected under, for "not configured" messages. */
  keyName: JevKeyName;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function parseProvider(value: string | undefined): JevProvider | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'typesafe' || normalized === 'openrouter' ? normalized : undefined;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function providerOf(url: string): JevProvider | 'custom' {
  const host = hostOf(url);
  if (host === 'openrouter.ai' || host?.endsWith('.openrouter.ai')) return 'openrouter';
  if (host === hostOf(SYSTEM_ONE_URL)) return 'typesafe';
  return 'custom';
}

/**
 * Picks the Jev endpoint and the key to send to it.
 *
 * Endpoint: `baseUrl`, else `provider`, else TypeSafe when a TypeSafe key is
 * present, else OpenRouter when only an OpenRouter key is, else TypeSafe.
 * Key: `apiKey`, else the endpoint's own key name first and the other as a
 * fallback (a key stored under the other name still reaches its endpoint).
 */
export function resolveJevEndpoint(input: JevEndpointInput = {}): JevEndpoint {
  const keys = input.keys ?? {};
  const typesafeKey = nonEmpty(keys.TYPESAFE_API_KEY);
  const openRouterKey = nonEmpty(keys.OPENROUTER_API_KEY);
  const explicitUrl = nonEmpty(input.baseUrl);
  const chosen =
    parseProvider(input.provider) ??
    (typesafeKey ? 'typesafe' : openRouterKey ? 'openrouter' : 'typesafe');
  const baseUrl =
    explicitUrl ?? (chosen === 'openrouter' ? OPENROUTER_DECISIONS_URL : SYSTEM_ONE_URL);
  const provider = explicitUrl ? providerOf(explicitUrl) : chosen;
  const keyName: JevKeyName =
    provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'TYPESAFE_API_KEY';
  const apiKey =
    nonEmpty(input.apiKey) ??
    (provider === 'openrouter' ? openRouterKey ?? typesafeKey : typesafeKey ?? openRouterKey);
  const endpoint: JevEndpoint = { baseUrl, provider, keyName };
  if (apiKey) endpoint.apiKey = apiKey;
  return endpoint;
}

/**
 * The model id to send. OpenRouter serves Jev by minor version only
 * (`jev-latest`, `jev-1.13`, `typesafe/jev-1.13`) and rejects TypeSafe's
 * patch pins, so `jev-1.13.0` becomes `typesafe/jev-1.13` there.
 */
export function jevModelFor(provider: JevEndpoint['provider'], model: string | undefined): string | undefined {
  if (provider !== 'openrouter' || model === undefined) return model;
  const pin = /^jev-(\d+\.\d+)\.\d+$/.exec(model.trim());
  return pin ? `typesafe/jev-${pin[1]}` : model;
}

/**
 * The same resolution from process environment variables:
 * `FAST_JEV_BASE_URL` (or `TYPESAFE_BASE_URL`), `FAST_JEV_PROVIDER`,
 * `FAST_JEV_API_KEY`, `TYPESAFE_API_KEY` and `OPENROUTER_API_KEY`.
 */
export function jevEndpointFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  overrides: Omit<JevEndpointInput, 'keys'> = {},
): JevEndpoint {
  return resolveJevEndpoint({
    apiKey: overrides.apiKey ?? env.FAST_JEV_API_KEY,
    baseUrl: overrides.baseUrl ?? env.FAST_JEV_BASE_URL ?? env.TYPESAFE_BASE_URL,
    provider: overrides.provider ?? env.FAST_JEV_PROVIDER,
    keys: {
      TYPESAFE_API_KEY: env.TYPESAFE_API_KEY,
      OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
    },
  });
}
