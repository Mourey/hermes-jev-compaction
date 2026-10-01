import { jevEndpointFromEnv, jevModelFor, resolveJevEndpoint, type JevKeyName } from './endpoint.js';
import { buildJevRequest, parseJevResponse } from './request.js';
import type { JevAsker, JevQuestions, JevResponse, JevState } from './types.js';

export interface JevClientOptions {
  /**
   * Defaults to the key for the endpoint: `FAST_JEV_API_KEY`, then
   * `TYPESAFE_API_KEY` / `OPENROUTER_API_KEY` (endpoint's own name first).
   * An empty string means no key.
   */
  apiKey?: string;
  /** Defaults to `jev-latest`. */
  model?: string;
  /**
   * Defaults to `FAST_JEV_BASE_URL` / `TYPESAFE_BASE_URL`, else the endpoint
   * of `provider`, else System One, or OpenRouter when only an OpenRouter key is set.
   */
  baseUrl?: string;
  /** `typesafe` or `openrouter`; defaults to `FAST_JEV_PROVIDER`. */
  provider?: string;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/** Asks Jev over HTTP with the global `fetch` (or an injected one). */
export class JevClient implements JevAsker {
  private readonly apiKey: string;
  private readonly model: string | undefined;
  private readonly baseUrl: string;
  private readonly keyName: JevKeyName;
  private readonly fetcher: typeof fetch;

  constructor(options: JevClientOptions = {}) {
    const endpoint =
      options.apiKey === undefined
        ? jevEndpointFromEnv(process.env, { baseUrl: options.baseUrl, provider: options.provider })
        : resolveJevEndpoint({
            apiKey: options.apiKey,
            baseUrl: options.baseUrl ?? process.env.FAST_JEV_BASE_URL ?? process.env.TYPESAFE_BASE_URL,
            provider: options.provider ?? process.env.FAST_JEV_PROVIDER,
          });
    this.apiKey = endpoint.apiKey ?? '';
    this.keyName = endpoint.keyName;
    this.model = jevModelFor(endpoint.provider, options.model);
    this.baseUrl = endpoint.baseUrl;
    this.fetcher = options.fetch ?? fetch;
  }

  async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
    if (!this.apiKey) throw new Error(`${this.keyName} is not configured`);
    const request = buildJevRequest(
      { apiKey: this.apiKey, model: this.model, baseUrl: this.baseUrl },
      state,
      questions,
    );
    const response = await this.fetcher(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
    return parseJevResponse(response.status, response.ok, await response.text());
  }
}
