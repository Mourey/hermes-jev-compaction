import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  JevClient,
  OPENROUTER_DECISIONS_URL,
  SYSTEM_ONE_URL,
  jevEndpointFromEnv,
  parseProvider,
  resolveJevEndpoint,
} from '../src/index.js';

describe('resolveJevEndpoint', () => {
  it('defaults to TypeSafe, and to OpenRouter when only an OpenRouter key is present', () => {
    expect(resolveJevEndpoint()).toEqual({
      baseUrl: SYSTEM_ONE_URL,
      provider: 'typesafe',
      keyName: 'TYPESAFE_API_KEY',
    });
    expect(resolveJevEndpoint({ keys: { OPENROUTER_API_KEY: 'or' } })).toEqual({
      baseUrl: OPENROUTER_DECISIONS_URL,
      provider: 'openrouter',
      keyName: 'OPENROUTER_API_KEY',
      apiKey: 'or',
    });
    expect(resolveJevEndpoint({ keys: { TYPESAFE_API_KEY: 'ts', OPENROUTER_API_KEY: 'or' } })).toMatchObject({
      baseUrl: SYSTEM_ONE_URL,
      apiKey: 'ts',
    });
  });

  it('sends the endpoint its own key when both are present', () => {
    const keys = { TYPESAFE_API_KEY: 'ts', OPENROUTER_API_KEY: 'or' };
    expect(resolveJevEndpoint({ provider: 'openrouter', keys })).toMatchObject({
      baseUrl: OPENROUTER_DECISIONS_URL,
      apiKey: 'or',
    });
    expect(resolveJevEndpoint({ baseUrl: OPENROUTER_DECISIONS_URL, keys })).toMatchObject({
      provider: 'openrouter',
      apiKey: 'or',
    });
    // A key stored under the other name still reaches the endpoint.
    expect(
      resolveJevEndpoint({ baseUrl: OPENROUTER_DECISIONS_URL, keys: { TYPESAFE_API_KEY: 'only' } }),
    ).toMatchObject({ apiKey: 'only', keyName: 'OPENROUTER_API_KEY' });
  });

  it('lets an explicit URL win over the provider and keeps custom endpoints on TypeSafe naming', () => {
    expect(
      resolveJevEndpoint({ baseUrl: 'http://localhost:8080/v1/systemone', provider: 'openrouter' }),
    ).toEqual({
      baseUrl: 'http://localhost:8080/v1/systemone',
      provider: 'custom',
      keyName: 'TYPESAFE_API_KEY',
    });
    expect(resolveJevEndpoint({ apiKey: 'explicit', keys: { TYPESAFE_API_KEY: 'ts' } }).apiKey).toBe(
      'explicit',
    );
    expect(resolveJevEndpoint({ baseUrl: '  ', provider: 'bogus' }).baseUrl).toBe(SYSTEM_ONE_URL);
  });

  it('parses providers case-insensitively and rejects others', () => {
    expect(parseProvider(' OpenRouter ')).toBe('openrouter');
    expect(parseProvider('typesafe')).toBe('typesafe');
    expect(parseProvider('anthropic')).toBeUndefined();
  });

  it('reads the environment names', () => {
    expect(
      jevEndpointFromEnv({ FAST_JEV_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'or', TYPESAFE_API_KEY: 'ts' }),
    ).toMatchObject({ baseUrl: OPENROUTER_DECISIONS_URL, apiKey: 'or' });
    expect(jevEndpointFromEnv({ TYPESAFE_BASE_URL: 'http://local/jev', FAST_JEV_API_KEY: 'k' })).toMatchObject({
      baseUrl: 'http://local/jev',
      apiKey: 'k',
    });
    expect(
      jevEndpointFromEnv({ FAST_JEV_BASE_URL: 'http://a', TYPESAFE_BASE_URL: 'http://b' }).baseUrl,
    ).toBe('http://a');
  });
});

describe('JevClient endpoint selection', () => {
  afterEach(() => vi.unstubAllEnvs());

  function recorder(calls: Array<{ url: string; auth: string | null }>) {
    return (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') });
      return new Response('{"answers":{}}', { status: 200 });
    }) as typeof fetch;
  }

  it('reaches OpenRouter from the environment alone', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'or-env');
    const calls: Array<{ url: string; auth: string | null }> = [];
    await new JevClient({ fetch: recorder(calls) }).ask('s', {});
    expect(calls).toEqual([{ url: OPENROUTER_DECISIONS_URL, auth: 'Bearer or-env' }]);
  });

  it('honours the provider option and keeps an empty apiKey meaning no key', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', 'ts-env');
    vi.stubEnv('OPENROUTER_API_KEY', 'or-env');
    const calls: Array<{ url: string; auth: string | null }> = [];
    await new JevClient({ provider: 'openrouter', fetch: recorder(calls) }).ask('s', {});
    await new JevClient({ fetch: recorder(calls) }).ask('s', {});
    expect(calls).toEqual([
      { url: OPENROUTER_DECISIONS_URL, auth: 'Bearer or-env' },
      { url: SYSTEM_ONE_URL, auth: 'Bearer ts-env' },
    ]);
    await expect(new JevClient({ apiKey: '', provider: 'openrouter' }).ask('s', {})).rejects.toThrow(
      /OPENROUTER_API_KEY is not configured/,
    );
  });
});
