import type {
  On,
  PluginOptions,
  Register,
  SessionMessage,
  ToolResultSummary,
  ToolUseSummary,
  TurnCompleteInput,
} from 'claude-code';

import { compact, reductionRatio, resolveOptions } from '../src/compact.js';
import { parseEnv } from '../src/dotenv.js';
import { resolveJevEndpoint, type JevEndpoint, type JevKeyName, type JevKeys } from '../src/endpoint.js';
import { buildJevRequest, DEFAULT_MODEL, parseJevResponse } from '../src/request.js';
import type {
  CompactOptions,
  CompactResult,
  JevAsker,
  Message,
  ToolResult,
  ToolUse,
} from '../src/types.js';

const HOOK_DEFAULTS = {
  compactAtPercent: 60,
  minReductionRatio: 0.25,
  model: DEFAULT_MODEL,
};

export type HookFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type HookFetchResponse = {
  status: number;
  ok: boolean;
  text: string;
};

/** The shape of `$.http.fetch`, so the hook can be driven without an engine. */
export type HookFetch = (url: string, init?: HookFetchInit) => Promise<HookFetchResponse>;

export type HookConfig = CompactOptions & {
  apiKey?: string;
  /** Jev endpoint; unset follows `provider`, then whichever key is present. */
  baseUrl?: string;
  /** `typesafe` or `openrouter`; unset picks TypeSafe when its key is present. */
  provider?: string;
  /** The key name a missing key is reported under. */
  keyName?: JevKeyName;
  /** A dotenv file to read the key from when the environment has none. */
  envFile?: string;
  compactAtPercent: number;
  minReductionRatio: number;
  model: string;
};

function optionNumber(options: PluginOptions, key: string, fallback: number): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionString(options: PluginOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Reads the plugin's `userConfig` values; anything missing takes the defaults. */
export function resolveHookConfig(options: PluginOptions): HookConfig {
  const numbers: Partial<Omit<CompactOptions, 'goal'>> = {};
  for (const key of [
    'keepThreshold',
    'preserveRecentMessages',
    'maxStateTokens',
    'maxRequestTokens',
    'truncateHeadChars',
  ] as const) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) numbers[key] = value;
  }
  const config: HookConfig = {
    ...numbers,
    compactAtPercent: optionNumber(options, 'compactAtPercent', HOOK_DEFAULTS.compactAtPercent),
    minReductionRatio: optionNumber(
      options,
      'minReductionRatio',
      HOOK_DEFAULTS.minReductionRatio,
    ),
    model: optionString(options, 'model') ?? HOOK_DEFAULTS.model,
  };
  const apiKey = optionString(options, 'apiKey');
  if (apiKey) config.apiKey = apiKey;
  const baseUrl = optionString(options, 'baseUrl');
  if (baseUrl) config.baseUrl = baseUrl;
  const provider = optionString(options, 'provider');
  if (provider) config.provider = provider;
  const envFile = optionString(options, 'envFile');
  if (envFile) config.envFile = envFile;
  const goal = optionString(options, 'goal');
  if (goal) config.goal = goal;
  return config;
}

/** A `JevAsker` over the engine's `$.http.fetch`. */
export function jevAsker(
  fetchFn: HookFetch,
  apiKey: string,
  model: string,
  baseUrl?: string,
): JevAsker {
  return {
    async ask(state, questions) {
      const request = buildJevRequest({ apiKey, model, baseUrl }, state, questions);
      const response = await fetchFn(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
      return parseJevResponse(response.status, response.ok, response.text);
    },
  };
}

function toolUseSummary(tool: ToolUse): ToolUseSummary {
  const summary: ToolUseSummary = {
    tool_use_id: tool.tool_use_id,
    tool: tool.tool,
    input: tool.input,
  };
  if (tool.text !== undefined) summary.text = tool.text;
  if (tool.isError) summary.isError = true;
  return summary;
}

function toolResultSummary(result: ToolResult): ToolResultSummary {
  return {
    tool_use_id: result.tool_use_id,
    text: result.text,
    isError: result.isError ?? false,
  };
}

/**
 * Maps the library's output back onto session messages. Whatever came back
 * unchanged (a message, a tool use, a tool result) is the engine's own object,
 * handle included; anything rebuilt is a fresh message without a handle, so the
 * engine takes the edited content instead of its original.
 */
export function toSessionMessages(
  input: readonly SessionMessage[],
  output: readonly Message[],
): SessionMessage[] {
  const messages = new Map<Message, SessionMessage>();
  const uses = new Map<ToolUse, ToolUseSummary>();
  const results = new Map<ToolResult, ToolResultSummary>();
  for (const message of input) {
    messages.set(message, message);
    for (const tool of message.toolUses) uses.set(tool, tool);
    for (const result of message.toolResults ?? []) results.set(result, result);
  }
  return output.map((message) => {
    const own = messages.get(message);
    if (own) return own;
    const rebuilt: SessionMessage = {
      role: message.role,
      text: message.text,
      toolUses: message.toolUses.map((tool) => uses.get(tool) ?? toolUseSummary(tool)),
    };
    if (message.toolResults && message.toolResults.length > 0) {
      rebuilt.toolResults = message.toolResults.map(
        (result) => results.get(result) ?? toolResultSummary(result),
      );
    }
    return rebuilt;
  });
}

export type SessionCompaction = {
  result: CompactResult;
  messages: SessionMessage[];
};

/** Runs the library over a session transcript; throws when the key is missing or Jev fails. */
export async function compactSession(
  messages: readonly SessionMessage[],
  config: HookConfig,
  fetchFn: HookFetch,
): Promise<SessionCompaction> {
  if (!config.apiKey) throw new Error(`${config.keyName ?? 'TYPESAFE_API_KEY'} is not configured`);
  const result = await compact(
    messages,
    jevAsker(fetchFn, config.apiKey, config.model, config.baseUrl),
    config,
  );
  return { result, messages: toSessionMessages(messages, result.messages) };
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function summarize(result: CompactResult): string {
  const { stats } = result;
  const parts = [
    stats.kept > 0 ? `${stats.kept} kept` : '',
    stats.resultsDropped > 0 ? `${stats.resultsDropped} results truncated` : '',
    stats.callsDropped > 0 ? `${stats.callsDropped} call_dropped` : '',
    stats.pinned > 0 ? `${stats.pinned} pinned` : '',
  ].filter(Boolean);
  return `${percent(reductionRatio(result))} reduction; ${
    parts.join(', ') || 'no tool calls'
  }; state ~${stats.stateTokens} tokens (${stats.stateStage}) in ${stats.requests} request(s)`;
}

const UI_LOG_MAX_CHARS = 4096;

export function decisionLog(result: CompactResult): string {
  return result.decisions
    .filter((d) => d.reason !== 'pinned')
    .map(
      (d) =>
        `${d.id}:${d.tool}:${d.action}/call=${d.keepCall.toFixed(2)}/result=${d.keepResult.toFixed(2)}`,
    )
    .join(' ');
}

export function decisionLogLines(
  result: CompactResult,
  maxChars: number = UI_LOG_MAX_CHARS,
): string[] {
  const entries = decisionLog(result).split(' ').filter(Boolean);
  if (entries.length === 0) return ['decisions: (none)'];
  const chunks: string[] = [];
  let current = '';
  for (const entry of entries) {
    const next = current ? `${current} ${entry}` : entry;
    if (current && next.length > maxChars - 24) {
      chunks.push(current);
      current = entry;
    } else current = next;
  }
  chunks.push(current);
  return chunks.map((chunk, index) =>
    chunks.length === 1
      ? `decisions: ${chunk}`
      : `decisions (${index + 1}/${chunks.length}): ${chunk}`,
  );
}

/** The names a key may be stored under, in the order they are tried. */
const KEY_NAMES = ['TYPESAFE_API_KEY', 'OPENROUTER_API_KEY'] as const;

function settingEnv(settings: Readonly<Record<string, unknown>>, name: string): string | undefined {
  const env = settings['env'];
  if (!env || typeof env !== 'object') return undefined;
  const value = (env as Record<string, unknown>)[name];
  return typeof value === 'string' && value ? value : undefined;
}

/** The Jev keys the given dotenv file holds; empty when it cannot be read. */
export async function dotenvKeys(
  $: { fs: { read: (path: string) => Promise<string> } },
  path: string,
): Promise<JevKeys> {
  const keys: JevKeys = {};
  try {
    const parsed = parseEnv(await $.fs.read(path));
    for (const name of KEY_NAMES) {
      const value = parsed[name];
      if (value) keys[name] = value;
    }
  } catch {
    // A missing or unreadable file is not an error: the key is simply not there.
  }
  return keys;
}

/**
 * The key the given dotenv file holds, or `undefined` when it cannot be read.
 * An absolute path is read as given; a relative one is under the session's
 * working directory, as `$.fs.read` reads it.
 */
export async function dotenvKey(
  $: { fs: { read: (path: string) => Promise<string> } },
  path: string,
): Promise<string | undefined> {
  const keys = await dotenvKeys($, path);
  return keys.TYPESAFE_API_KEY ?? keys.OPENROUTER_API_KEY;
}

type KeyEngine = {
  env: { get: (name: string) => Promise<string | undefined> };
  settings: { read: () => Promise<Readonly<Record<string, unknown>>> };
  fs: { read: (path: string) => Promise<string> };
};

/**
 * The endpoint and key for this compaction. Each value comes from the plugin
 * option, then the environment, then the settings' `env` block; keys missing
 * from all three are read from `envFile`. The key sent is the endpoint's own
 * (`OPENROUTER_API_KEY` for OpenRouter), the other name being the fallback.
 */
export async function resolveEndpoint($: KeyEngine, config: HookConfig): Promise<JevEndpoint> {
  const settings = await $.settings.read();
  // The names are spelled literally: `claude plugin validate` reads them off
  // this source, and a name it cannot see is refused.
  const keys: JevKeys = {
    TYPESAFE_API_KEY: (await $.env.get('TYPESAFE_API_KEY')) || settingEnv(settings, 'TYPESAFE_API_KEY'),
    OPENROUTER_API_KEY:
      (await $.env.get('OPENROUTER_API_KEY')) || settingEnv(settings, 'OPENROUTER_API_KEY'),
  };
  if (!config.apiKey && config.envFile && KEY_NAMES.some((name) => !keys[name])) {
    const fromFile = await dotenvKeys($, config.envFile);
    for (const name of KEY_NAMES) keys[name] ||= fromFile[name];
  }
  return resolveJevEndpoint({
    apiKey: config.apiKey,
    baseUrl:
      config.baseUrl ??
      ((await $.env.get('FAST_JEV_BASE_URL')) || settingEnv(settings, 'FAST_JEV_BASE_URL')),
    provider:
      config.provider ??
      ((await $.env.get('FAST_JEV_PROVIDER')) || settingEnv(settings, 'FAST_JEV_PROVIDER')),
    keys,
  });
}

export async function getApiKey($: KeyEngine, config: HookConfig): Promise<string | undefined> {
  return (await resolveEndpoint($, config)).apiKey;
}

function notify(
  $: {
    ui: {
      log: (text: string) => void;
      toast: (text: string, options?: { timeoutMs?: number }) => void;
    };
  },
  text: string,
): void {
  $.ui.log(text);
  $.ui.toast(text, { timeoutMs: 15_000 });
}

export const register: Register = (on: On, options: PluginOptions) => {
  const configured = resolveHookConfig(options);
  let compacting = false;

  on('session.compact', async ($, event, next) => {
    try {
      const endpoint = await resolveEndpoint($, configured);
      const config: HookConfig = {
        ...configured,
        apiKey: endpoint.apiKey,
        baseUrl: endpoint.baseUrl,
        keyName: endpoint.keyName,
      };
      const { result, messages } = await compactSession(event.messages, config, async (url, init) => {
        const response = await $.http.fetch(url, init);
        return { status: response.status, ok: response.ok, text: response.text };
      });
      for (const line of decisionLogLines(result)) $.ui.log(line);
      if (reductionRatio(result) < config.minReductionRatio) {
        notify(
          $,
          `fallback to built-in summary (below ${percent(config.minReductionRatio)} minimum: ${summarize(result)})`,
        );
        return next(event);
      }
      notify(
        $,
        `kept ${messages.length}/${event.messages.length} messages, no summary (${summarize(result)})`,
      );
      return { messages };
    } catch (error) {
      notify(
        $,
        `fallback to built-in summary (${error instanceof Error ? error.message : String(error)})`,
      );
      return next(event);
    }
  });

  on('turn.complete', async ($, event: TurnCompleteInput, next) => {
    if (compacting) return next(event);
    try {
      const { context } = await $.session.usage();
      if ((context.percent ?? 0) < configured.compactAtPercent) return next(event);
      compacting = true;
      await $.session.compact();
    } catch (error) {
      $.ui.log(
        `auto-compact skipped (${error instanceof Error ? error.message : String(error)})`,
      );
    } finally {
      compacting = false;
    }
    return next(event);
  });
};

export { resolveOptions };
