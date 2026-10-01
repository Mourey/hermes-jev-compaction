# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
npm install
npm run typecheck        # tsc on src/ (tsconfig.json) AND hooks/ (tsconfig.hooks.json)
npm test                 # vitest run; fake Jev, never touches the network
npx vitest run tests/hook.test.ts            # one file
npx vitest run -t "<test name substring>"    # one test
npm run build            # tsc -> dist/ (library only; hooks are not built)
npm run validate:plugin  # claude plugin validate .claude-plugin/plugin.json
TYPESAFE_API_KEY="$(cat ~/.typesafe_key)" npm run demo   # live network check (examples/demo.ts)
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .  # run the plugin from a checkout
```

`demo/JevDemo/build.sh` builds a scripted SwiftUI animation for screen recording; it never calls the API and is unrelated to the library.

## What this is

One repo, two products:

- **npm library** (`src/`, ESM, NodeNext): verbatim context compaction. It never summarizes or rewrites; it only drops or truncates tool calls/results that TypeSafe's Jev model scores as no longer needed. User/assistant text is never removed from the output.
- **Claude Code function-hook plugin** (repo root is the plugin: `.claude-plugin/`, `hooks/`): `hooks/fast-jev.ts` replaces Claude Code's built-in compaction summary with the pruned original messages, falling back to the built-in summary on any error or when `reductionRatio < minReductionRatio`.

## Architecture

Pipeline in `src/compact.ts` `compact(messages, asker, options)`:

1. `collectToolCalls` (`src/state.ts`) pairs `tool_use` with `tool_result` by `tool_use_id`; calls in the first message or the newest `preserveRecentMessages` are pinned (`isPinned`).
2. `fitState` (`src/state.ts`) builds the Jev `state`: whole conversation, tool results replaced by a one-line note, squeezed into `maxStateTokens` through escalating stages (truncate inputs 1000/200/60 → abridge texts → collapse old messages → one-line old calls → omit/fold old messages). Throws if it still doesn't fit. `estimateTokens` is a heuristic, deliberately calibrated slightly above Jev's real counts — keep that bias if you change it.
3. `questionsFor` asks two `noul` questions per non-pinned call (keep the call? keep the result verbatim?). `batchCalls` splits them so state + questions stays under `maxRequestTokens` (Jev's hard limit is 32k); the full state is resent with each batch, batches run concurrently.
4. `decideCall` maps probabilities vs `keepThreshold` to `keep` / `drop_result` (truncate to `truncateHeadChars` + note) / `drop_call` (remove call and result together).
5. `applyDecisions` rebuilds messages: unchanged messages are returned **as the same object references**, emptied messages are removed, and a result is never left without its call.

Transport is abstracted behind `JevAsker` (`src/types.ts`). `src/request.ts` holds the pure HTTP body builder/response validator; `src/client.ts` (`JevClient`) and `src/messages.ts` (`compactMessages`) are the Node convenience layer using global `fetch` and `process.env.TYPESAFE_API_KEY`.

Failures (Jev error, malformed answer, missing key, unfittable history) **throw**; the caller decides the fallback. Don't swallow them in `src/`.

## Hook constraints (`hooks/fast-jev.ts`)

- The hook runs in Claude Code's function-hook engine, not plain Node. `tsconfig.hooks.json` sets `"types": []`, so no Node globals: the hook must not import `src/client.ts`/`src/messages.ts`. It imports `src/compact.ts`, `src/request.ts`, `src/types.ts` directly (relative `../src/*.js`, no build step) and does HTTP via `$.http.fetch` wrapped in its own `jevAsker`.
- `toSessionMessages` relies on `applyDecisions` preserving object identity: reused objects keep their engine `handle`; rebuilt messages are emitted without one so the engine takes the edited content. Breaking reference identity in `src/` silently breaks the plugin.
- `$.ui.log` lines have a 4096-char host limit; `decisionLogLines` chunks the per-call decision log to fit.
- `turn.complete` triggers `$.session.compact()` at `compactAtPercent` with an in-flight guard.
- `apiKey`, `compactAtPercent`, `minReductionRatio`, `model` are hook-only options; every other `userConfig` option passes straight through to the library. When adding an option, update `.claude-plugin/plugin.json` `userConfig`, `resolveHookConfig`, and the option tables in both `README.md` and `hooks/README.md`.
- `types/claude-code.d.ts` is generated from Claude Code 2.1.274 (mapped as module `claude-code` via tsconfig paths). Function hooks are early access; regenerate and review it after a Claude Code upgrade rather than hand-editing.

## Tests

- `tests/fast-jev-compaction.test.ts`: library, with a fake `JevAsker`.
- `tests/hook.test.ts`: imports `hooks/fast-jev.ts` directly and drives `compactSession` with a fake `HookFetch`, so the hook is testable without the engine.
