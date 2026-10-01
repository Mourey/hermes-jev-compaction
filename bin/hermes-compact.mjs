#!/usr/bin/env node
// hermes-compact — on-demand Jev compaction for Hermes Agent transcripts.
// Part of hermes-jev-compaction (https://github.com/deadczarvc/hermes-jev-compaction).
//
// Reads an OpenAI-chat-format transcript (JSON array of messages, or an
// object with a `messages` array; JSONL also accepted), compacts it with the
// fast-jev-compaction library, and writes the compacted transcript.
//
// The API key comes from the environment (never pass it as an argument):
// FAST_JEV_API_KEY, else TYPESAFE_API_KEY / OPENROUTER_API_KEY, the endpoint's
// own name first. The endpoint is --base-url / FAST_JEV_BASE_URL, else
// --provider / FAST_JEV_PROVIDER (typesafe | openrouter), else TypeSafe, or
// OpenRouter when only OPENROUTER_API_KEY is set. Default model `jev-latest`
// (currently resolves to jev-1.13.0); pin explicitly with --model jev-1.13.0.

import { readFileSync, writeFileSync } from 'node:fs';
import {
  collectToolCalls,
  compactMessages,
  jevEndpointFromEnv,
  parseProvider,
  resolveOptions,
} from '../dist/index.js';
import { fromHermes, hermesGoal, toHermes } from '../dist/hermes.js';

function usage(code) {
  const lines = [
    'Usage: hermes-compact <transcript.json> [options]',
    '',
    'Input: JSON array of OpenAI-chat messages, {"messages": [...]} or JSONL.',
    'Output: JSON {"messages": [...], "stats": {...}} (compacted transcript).',
    '',
    'Options:',
    '  -o, --out <file>          output file (default: stdout)',
    '  --model <name>            Jev model (default: jev-latest; pin jev-1.13.0)',
    '  --goal <text>             explicit goal (default: system texts, then last user prompts)',
    '  --keep-threshold <n>      min keep probability (default 0.5)',
    '  --preserve-recent <n>     newest messages never touched (default 6)',
    '  --max-state-tokens <n>    state token ceiling (default 25000)',
    '  --max-request-tokens <n>  request token ceiling (default 30000)',
    '  --truncate-head <n>       chars kept of a dropped result (default 300)',
    '  --provider <name>         typesafe | openrouter (default: FAST_JEV_PROVIDER, else by key)',
    '  --base-url <url>          explicit Jev endpoint; wins over --provider',
    '  --dry-run                 map and report only; no Jev requests, no key needed',
    '  -h, --help                this help',
    '',
    'Env: TYPESAFE_API_KEY or OPENROUTER_API_KEY (or FAST_JEV_API_KEY; required unless --dry-run);',
    '     FAST_JEV_PROVIDER, FAST_JEV_BASE_URL (or TYPESAFE_BASE_URL).',
    'With only OPENROUTER_API_KEY set, requests go to OpenRouter.',
  ];
  console.error(lines.join('\n'));
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { model: 'jev-latest', out: null, goal: '', dryRun: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) {
        console.error(`missing value for ${arg}`);
        usage(2);
      }
      return value;
    };
    const number = () => {
      const value = Number(next());
      if (!Number.isFinite(value)) {
        console.error(`not a number for ${arg}`);
        usage(2);
      }
      return value;
    };
    switch (arg) {
      case '--model': opts.model = next(); break;
      case '--out': case '-o': opts.out = next(); break;
      case '--goal': opts.goal = next(); break;
      case '--keep-threshold': opts.keepThreshold = number(); break;
      case '--preserve-recent': opts.preserveRecentMessages = number(); break;
      case '--max-state-tokens': opts.maxStateTokens = number(); break;
      case '--max-request-tokens': opts.maxRequestTokens = number(); break;
      case '--truncate-head': opts.truncateHeadChars = number(); break;
      case '--provider': {
        const value = next();
        if (!parseProvider(value)) {
          console.error(`unknown provider: ${value} (typesafe | openrouter)`);
          usage(2);
        }
        opts.provider = value;
        break;
      }
      case '--base-url': opts.baseUrl = next(); break;
      case '--dry-run': opts.dryRun = true; break;
      case '--help': case '-h': usage(0); break;
      default:
        if (arg.startsWith('-')) {
          console.error(`unknown option: ${arg}`);
          usage(2);
        }
        positional.push(arg);
    }
  }
  return { opts, positional };
}

function loadTranscript(file) {
  const raw = readFileSync(file, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.messages)) return parsed.messages;
  console.error('input must be a JSON array of messages, {"messages": [...]}, or JSONL');
  process.exit(2);
}

const { opts, positional } = parseArgs(process.argv.slice(2));
if (positional.length !== 1) usage(2);

const hermesMessages = loadTranscript(positional[0]);
const transcript = fromHermes(hermesMessages);
const { messages, systemTexts } = transcript;
const goal = hermesGoal(systemTexts, opts.goal);

if (opts.dryRun) {
  const resolved = resolveOptions({ goal, ...opts });
  const calls = collectToolCalls(messages, resolved.preserveRecentMessages);
  const stats = {
    dryRun: true,
    messages: messages.length,
    systemTexts: systemTexts.length,
    toolCalls: calls.length,
    candidates: calls.filter((call) => !call.pinned).length,
    pinned: calls.filter((call) => call.pinned).length,
  };
  const payload = JSON.stringify({ messages: toHermes(messages, transcript), stats }, null, 2);
  if (opts.out) writeFileSync(opts.out, payload);
  else console.log(payload);
  console.error(`dry-run: ${stats.toolCalls} tool calls, ${stats.candidates} candidates, ${stats.pinned} pinned`);
  process.exit(0);
}

const endpoint = jevEndpointFromEnv(process.env, { baseUrl: opts.baseUrl, provider: opts.provider });
if (!endpoint.apiKey) {
  console.error(`${endpoint.keyName} is not configured`);
  process.exit(2);
}

try {
  const result = await compactMessages(messages, {
    apiKey: endpoint.apiKey,
    baseUrl: endpoint.baseUrl,
    model: opts.model,
    goal,
    keepThreshold: opts.keepThreshold,
    preserveRecentMessages: opts.preserveRecentMessages,
    maxStateTokens: opts.maxStateTokens,
    maxRequestTokens: opts.maxRequestTokens,
    truncateHeadChars: opts.truncateHeadChars,
  });
  const payload = JSON.stringify({ messages: toHermes(result.messages, transcript), stats: result.stats }, null, 2);
  if (opts.out) writeFileSync(opts.out, payload);
  else console.log(payload);
  const s = result.stats;
  const reduction =
    s.charsBefore === 0 ? 0 : Math.round(((s.charsBefore - s.charsAfter) / s.charsBefore) * 100);
  console.error(
    `kept ${s.kept}, results truncated ${s.resultsDropped}, calls dropped ${s.callsDropped}, ` +
      `pinned ${s.pinned}; ${reduction}% reduction; state ~${s.stateTokens} tokens ` +
      `(${s.stateStage}) in ${s.requests} request(s) to ${new URL(endpoint.baseUrl).host}, ${s.ms} ms`,
  );
} catch (error) {
  console.error(`compaction failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
