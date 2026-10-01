# hermes-jev-compaction — Hermes integration notes

Start with the [README](README.md). Languages: [English](README.md) · [Русский](HERMES.ru.md) · [中文](HERMES.zh-CN.md).

This fork adds a Hermes Agent port of fast-jev-compaction: map an OpenAI-chat
transcript onto the library's `Message[]`, run the Jev decision engine
(TypeSafe System One API, `jev-1.13.0`), and map the result back.

Nothing else from upstream is changed: same library, same tests, same
semantics. The upstream Claude Code hooks are irrelevant for Hermes
(Hermes has no compaction hook event; compression lives in core) — so this
port ships a **library adapter + on-demand CLI** instead.

## Install

```bash
git clone https://github.com/deadczarvc/hermes-jev-compaction
cd fast-jev-compaction
npm install && npm run build
```

Requires Node >= 18.

## CLI: hermes-compact

```bash
export TYPESAFE_API_KEY=...   # your TypeSafe key (console.typesafe.ai)
node bin/hermes-compact.mjs transcript.json --out compacted.json
```

Input: JSON array of OpenAI-chat messages, `{"messages": [...]}` or JSONL.
Output: JSON `{"messages": [...], "stats": {...}}`.

Key options: `--model jev-1.13.0` (pin; default `jev-latest`), `--goal`,
`--keep-threshold`, `--preserve-recent`, `--max-state-tokens`,
`--max-request-tokens`, `--truncate-head`, `--provider`, `--base-url`,
`--dry-run` (mapping report, no key needed). Full list:
`node bin/hermes-compact.mjs --help`.

## OpenRouter

OpenRouter serves the same Jev model at
`https://openrouter.ai/api/alpha/decisions`, with the same request body and
`answers` as TypeSafe System One. Every path that calls Jev (library, CLI and
the Hermes plugin) picks the endpoint and key the same way:

- **Endpoint:** an explicit base URL (`FAST_JEV_BASE_URL`, or
  `TYPESAFE_BASE_URL`) wins. Otherwise `FAST_JEV_PROVIDER` (`typesafe` |
  `openrouter`) decides. With neither set, TypeSafe is used when
  `TYPESAFE_API_KEY` is set, else OpenRouter when only `OPENROUTER_API_KEY`
  is set, else TypeSafe.
- **Key:** `FAST_JEV_API_KEY` (or an explicit `apiKey`) wins. Otherwise the
  endpoint's own key is used first: `OPENROUTER_API_KEY` for OpenRouter,
  `TYPESAFE_API_KEY` for anything else, with the other name as a fallback.
  The TypeSafe key is never sent to OpenRouter while an OpenRouter key exists.
- **Model:** OpenRouter serves Jev by minor version only (`jev-latest`,
  `jev-1.13`, `typesafe/jev-1.13`) and rejects TypeSafe patch pins. On
  OpenRouter, `jev-1.13.0` is therefore sent as `typesafe/jev-1.13`.
- A missing key is reported by the name the chosen endpoint expects, e.g.
  `OPENROUTER_API_KEY is not configured`.

```bash
# Only an OpenRouter key: OpenRouter is chosen automatically
export OPENROUTER_API_KEY=...
node bin/hermes-compact.mjs transcript.json --out compacted.json

# Both keys: choose OpenRouter explicitly
node bin/hermes-compact.mjs transcript.json --provider openrouter --out compacted.json
FAST_JEV_PROVIDER=openrouter node bin/hermes-compact.mjs transcript.json
```

In Hermes, the plugin reads the same variables through the profile's secret
scope (the profile `.env`, then the process environment). It also accepts two
config keys, which win over the variables:

```yaml
context:
  engine: jev
  jev:
    provider: openrouter        # or typesafe
    # base_url: https://...     # explicit endpoint; wins over provider
```

`hermes config set` warns that `context.jev.provider` is not a recognized key.
That warning is expected (pass `--force` to skip it); the plugin reads the key
itself. The Hermes 0.21.x context-engine loader finds a user engine by its
directory name, so installing the plugin as `~/.hermes/plugins/jev/` makes
`context.engine: jev` resolve without a `plugins.enabled` entry. Each
compaction logs the endpoint host and outcome to `agent.log`, for example
`jev-context-engine: Jev via openrouter.ai answered 1 request(s): kept 0,
results truncated 0, calls dropped 4`. A failure logs the exception class
and HTTP status, never the key.

## Library use

```ts
import { fromHermes, toHermes, hermesGoal } from './src/hermes.js';
import { compactMessages } from './dist/index.js';

const { messages, systemTexts } = fromHermes(hermesTranscript);
const result = await compactMessages(messages, {
  model: 'jev-1.13.0',
  goal: hermesGoal(systemTexts),
});
const compacted = toHermes(result.messages);
```

Semantics are identical to the library: kept messages stay verbatim (original
objects), dropped results keep a bounded head + note, dropped calls disappear
with their results. `HermesMessage.content` may be a string or a content-part
array; tool calls may be nested (`function: {name, arguments}`) or flat
(`name`, `arguments`). Non-text content parts (e.g. images) are ignored by
the text mapping — tool inputs keep their full structured content.

## Testing

```bash
npx vitest run   # 54/54 vitest; pytest: 103/103 (see README for the PYTHONPATH)
```

## Why on-demand, not a hook

Hermes 0.21.x exposes shell hooks on `pre_tool_call`, `post_tool_call`,
`pre_llm_call`, `on_session_start` — no compaction event, and compression
lives in `agent/conversation_compression.py` (core). Patching core dies on the
next update. An issue proposing a compaction hook/extension point is filed
upstream of the agent; until then the supported integration is this CLI +
library adapter, invoked on demand from a session or a scheduled job.
