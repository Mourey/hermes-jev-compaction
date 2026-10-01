#!/usr/bin/env node
// Jev compaction vs each harness's built-in summary, on live agent sessions.
//
// Every run builds a fresh fixture repo with eight planted facts (random
// values): three in the user's prompt, three inside files the agent reads,
// two in the output of a command it runs. The agent does filler work, the
// session is compacted (Jev or built-in), then the agent answers a recall
// question with tools disabled. Facts recalled, context tokens before/after,
// compaction latency and cost are recorded.
//
// Usage: node bench/compaction-bench.mjs [--reps 3] [--harness claude,pi] [--arms jev,builtin] [--pi-model id]
// Needs: claude, pi on PATH; OPENROUTER_API_KEY (Jev and Pi's model).

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => {
    if (arg.startsWith('--')) pairs.push([arg.slice(2), all[i + 1]]);
    return pairs;
  }, []),
);
const REPS = Number(args.reps ?? 3);
const HARNESSES = (args.harness ?? 'claude,pi').split(',');
const ARMS = (args.arms ?? 'jev,builtin').split(',');
const OUT_DIR = resolve(args.out ?? join(ROOT, 'docs', 'benchmarks'));
const WORK_ROOT = resolve(args.work ?? join(tmpdir(), 'fast-jev-bench'));
const PI_MODEL = args['pi-model'] ?? 'deepseek/deepseek-v4-flash-0731';
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';

// ---------------------------------------------------------------- fixture

const WORDS = ['amber', 'basalt', 'cobalt', 'delta', 'ember', 'falcon', 'garnet', 'harbor', 'indigo',
  'juniper', 'kestrel', 'lumen', 'marble', 'nimbus', 'onyx', 'pylon', 'quartz', 'raven', 'sierra', 'tundra'];
const NAMES = ['Ines Varga', 'Tomas Okafor', 'Priya Lindqvist', 'Mateo Haddad', 'Yuki Brennan', 'Sana Kowalski'];
const pick = (list) => list[randomInt(list.length)];

function filler(kind, lines) {
  const out = [];
  for (let i = 0; i < lines; i++) {
    if (kind === 'ts') {
      out.push(`export function ${pick(WORDS)}Step${i}(input: number[]): number {\n  return input.reduce((sum, value) => sum + value * ${i % 7 + 1}, ${i});\n}\n`);
    } else {
      out.push(`- ${pick(WORDS)} ${pick(WORDS)}: ${randomBytes(6).toString('hex')} shipped in sprint ${i % 40}; owner ${pick(WORDS)} team, follow-up tracked.`);
    }
  }
  return out.join('\n');
}

function makeFixture(dir) {
  rmSync(dir, { recursive: true, force: true });
  const facts = {
    codename: `${pick(WORDS).toUpperCase()}-${pick(WORDS).toUpperCase()}`,
    owner: pick(NAMES),
    forbidden_dir: pick(['vendor/', 'generated/', 'legacy/']),
    port: String(randomInt(20000, 39999)),
    database: `${pick(WORDS)}_${pick(WORDS)}_${randomInt(10, 99)}`,
    surcharge_bps: String(randomInt(101, 997)),
    build_id: `b-${randomBytes(4).toString('hex')}`,
    failing_test: `tests/${pick(WORDS)}.test.ts:${randomInt(20, 400)}`,
  };
  const write = (path, text) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  write('config/service.yaml', [
    '# service configuration',
    ...filler('md', 60).split('\n').map((l) => `# ${l}`),
    'server:',
    `  port: ${facts.port}`,
    '  host: 0.0.0.0',
    'storage:',
    `  database: ${facts.database}`,
    '  pool: 12',
    ...filler('md', 60).split('\n').map((l) => `# ${l}`),
  ].join('\n'));
  write('src/pricing.ts', [
    filler('ts', 40),
    `/** Basis-point surcharge applied to every invoice. */\nexport const SURCHARGE_BPS = ${facts.surcharge_bps};\n`,
    filler('ts', 40),
  ].join('\n'));
  const [file, line] = facts.failing_test.split(':');
  write('scripts/diag.sh', `#!/usr/bin/env bash\necho "diag: collecting"\necho "BUILD-ID: ${facts.build_id}"\necho "FAIL ${file}:${line} expected 2 received 3"\necho "1 failed, 41 passed"\n`);
  for (const name of ['alpha', 'bravo', 'charlie']) write(`lib/${name}.ts`, filler('ts', 70));
  write('docs/notes.md', `# Notes\n\n${filler('md', 220)}\n`);
  write('docs/changelog.md', `# Changelog\n\n## 4.${randomInt(1, 9)}.${randomInt(0, 9)}\n- maintenance release\n\n## 4.0.0\n- initial\n`);
  return facts;
}

const PROMPTS = (facts) => [
  `The release codename is ${facts.codename} and the ticket owner is ${facts.owner}. Never modify anything under ${facts.forbidden_dir}. ` +
    'Investigate the service: read config/service.yaml and src/pricing.ts, run `bash scripts/diag.sh`, then summarize what you found in two sentences.',
  'Now read lib/alpha.ts, lib/bravo.ts, lib/charlie.ts and docs/notes.md, and tell me how many exported functions each .ts file has. Keep the answer short.',
  'Read docs/changelog.md and tell me the latest version number only.',
];
const RECALL =
  'Do NOT use any tools. From memory of this conversation only, answer with a single JSON object with these keys: ' +
  'codename, owner, forbidden_dir, port, database, surcharge_bps, build_id, failing_test (as file:line). ' +
  'Use null for anything you do not remember. Output only the JSON.';

function score(facts, text) {
  let parsed = {};
  const match = text.match(/\{[\s\S]*\}/);
  try { parsed = match ? JSON.parse(match[0]) : {}; } catch { parsed = {}; }
  const norm = (v) => String(v ?? '').toLowerCase().replace(/\/+$/, '').trim();
  const hits = {};
  for (const [key, expected] of Object.entries(facts)) {
    const got = norm(parsed[key]);
    hits[key] = got !== '' && (got === norm(expected) || got.includes(norm(expected)));
  }
  return hits;
}

const CATEGORY = {
  codename: 'prompt', owner: 'prompt', forbidden_dir: 'prompt',
  port: 'file', database: 'file', surcharge_bps: 'file',
  build_id: 'command', failing_test: 'command',
};

// ---------------------------------------------------------------- claude

function claudeSessionFile(sessionId) {
  const base = join(homedir(), '.claude', 'projects');
  for (const project of readdirSync(base)) {
    const file = join(base, project, `${sessionId}.jsonl`);
    if (existsSync(file)) return file;
  }
  throw new Error(`session file for ${sessionId} not found`);
}

const contextOf = (u) =>
  (u?.input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0);

function runClaude(arm, dir, facts) {
  const base = ['-p', '--model', CLAUDE_MODEL, '--output-format', 'json',
    '--setting-sources', 'project', '--strict-mcp-config'];
  if (arm === 'jev') base.push('--plugin-dir', ROOT);
  const env = { ...process.env, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1', FAST_JEV_PROVIDER: 'openrouter' };
  const call = (extra, prompt) => {
    const t = Date.now();
    const r = spawnSync('claude', [...base, ...extra, prompt], { cwd: dir, env, encoding: 'utf8', maxBuffer: 64 << 20 });
    if (r.status !== 0) throw new Error(`claude failed: ${r.stderr.slice(-500)}`);
    return { json: JSON.parse(r.stdout), ms: Date.now() - t };
  };
  const tools = ['--allowedTools=Read,Glob,Grep,Bash(bash scripts/diag.sh)'];
  const [p1, p2, p3] = PROMPTS(facts);
  const first = call(tools, p1);
  const sid = first.json.session_id;
  call([...tools, '--resume', sid], p2);
  call([...tools, '--resume', sid], p3);

  const debugFile = join(dir, '..', `compact-${arm}.debug`);
  const compact = call(['--resume', sid, '--debug-file', debugFile], '/compact');
  const debug = existsSync(debugFile) ? readFileSync(debugFile, 'utf8') : '';
  const jevApplied = /kept \d+\/\d+ messages, no summary/.test(debug);
  const jevNote = (debug.match(/fast-jev-compaction\): (kept [^\n]*|fallback[^\n]*)/) ?? [])[1] ?? '';

  const recall = call(['--resume', sid, '--disallowedTools=Read,Glob,Grep,Bash,Edit,Write,Task,WebFetch,WebSearch,NotebookEdit'], RECALL);

  const lines = readFileSync(claudeSessionFile(sid), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const assistants = lines.filter((e) => e.type === 'assistant' && e.message?.usage);
  const boundary = lines.findIndex((e) => e.type === 'system' && e.subtype === 'compact_boundary');
  const before = [...lines.slice(0, boundary < 0 ? lines.length : boundary)].reverse().find((e) => e.type === 'assistant' && e.message?.usage);
  const after = assistants.at(-1);
  return {
    contextBefore: contextOf(before?.message?.usage),
    contextAfter: contextOf(after?.message?.usage),
    compactMs: compact.ms,
    compactCostUsd: compact.json.total_cost_usd ?? 0,
    jevApplied,
    note: jevNote || (arm === 'builtin' ? 'built-in summary' : 'no Jev log line'),
    recallText: recall.json.result ?? '',
    recallUsedTools: (recall.json.num_turns ?? 1) > 1,
  };
}

// ---------------------------------------------------------------- pi

async function runPi(arm, dir, facts) {
  mkdirSync(join(dir, '.pi'), { recursive: true });
  writeFileSync(join(dir, '.pi', 'settings.json'), JSON.stringify({ compaction: { enabled: false, keepRecentTokens: 2000 } }));
  const argv = ['--mode', 'rpc', '-a', '-ne', '--no-session', '-nc', '--provider', 'openrouter', '--model', PI_MODEL];
  if (arm === 'jev') argv.push('-e', join(ROOT, 'pi', 'extension.ts'));
  const env = { ...process.env, FAST_JEV_PROVIDER: 'openrouter' };
  const child = spawn('pi', argv, { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const waiters = [];
  let lastUsage;
  let notes = [];
  let toolCalls = 0;
  let lastText = '';
  createInterface({ input: child.stdout }).on('line', (line) => {
    let e;
    try { e = JSON.parse(line); } catch { return; }
    if (e.type === 'message_end' && e.message?.role === 'assistant') {
      lastUsage = e.message.usage;
      const text = (e.message.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('');
      if (text) lastText = text;
    }
    if (e.type === 'tool_execution_start') toolCalls++;
    if (e.type === 'extension_ui_request' && e.method === 'notify') notes.push(e.message);
    for (const w of [...waiters]) if (w.match(e)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(e); }
  });
  const waitFor = (match, ms = 600_000) => new Promise((res, rej) => {
    waiters.push({ match, resolve: res });
    setTimeout(() => rej(new Error(`pi timeout; stderr: ${stderr.slice(-400)}`)), ms).unref();
  });
  const prompt = async (message) => {
    child.stdin.write(`${JSON.stringify({ type: 'prompt', message })}\n`);
    await waitFor((e) => e.type === 'agent_end');
  };
  try {
    for (const p of PROMPTS(facts)) await prompt(p);
    const contextBefore = (lastUsage?.input ?? 0) + (lastUsage?.cacheRead ?? 0) + (lastUsage?.cacheWrite ?? 0);
    const t = Date.now();
    child.stdin.write(`${JSON.stringify({ id: 'c', type: 'compact' })}\n`);
    const res = await waitFor((e) => e.type === 'response' && e.command === 'compact');
    const compactMs = Date.now() - t;
    if (!res.success) throw new Error(`compact failed: ${res.error}`);
    const jevApplied = res.data?.details?.format === 'fast-jev-pi-context-v2';
    toolCalls = 0;
    lastText = '';
    await prompt(RECALL);
    const contextAfter = (lastUsage?.input ?? 0) + (lastUsage?.cacheRead ?? 0) + (lastUsage?.cacheWrite ?? 0);
    return {
      contextBefore,
      contextAfter,
      compactMs,
      compactCostUsd: res.data?.usage?.cost?.total ?? 0,
      jevApplied,
      note: notes.find((n) => /kept original|fallback/.test(n)) ?? (arm === 'builtin' ? 'built-in summary' : ''),
      recallText: lastText,
      recallUsedTools: toolCalls > 0,
    };
  } finally {
    child.kill();
  }
}

// ---------------------------------------------------------------- main

const runs = [];
mkdirSync(OUT_DIR, { recursive: true });
for (let rep = 1; rep <= REPS; rep++) {
  for (const harness of HARNESSES) {
    for (const arm of ARMS) {
      const dir = join(WORK_ROOT, `${harness}-${arm}-${rep}`, 'repo');
      const facts = makeFixture(dir);
      spawnSync('git', ['init', '-q'], { cwd: dir });
      const started = Date.now();
      process.stdout.write(`[${harness}/${arm}/rep ${rep}] `);
      try {
        const r = harness === 'claude' ? runClaude(arm, dir, facts) : await runPi(arm, dir, facts);
        const hits = score(facts, r.recallText);
        const recalled = Object.values(hits).filter(Boolean).length;
        const run = { harness, arm, rep, ...r, hits, recalled, total: Object.keys(facts).length, facts, wallMs: Date.now() - started };
        runs.push(run);
        console.log(`recalled ${recalled}/8, ctx ${r.contextBefore} -> ${r.contextAfter}, compact ${r.compactMs}ms $${r.compactCostUsd.toFixed(4)}, jev=${r.jevApplied}${r.recallUsedTools ? ' TOOLS-USED' : ''}`);
      } catch (error) {
        runs.push({ harness, arm, rep, error: String(error?.message ?? error) });
        console.log(`ERROR ${String(error?.message ?? error).slice(0, 300)}`);
      }
    }
  }
}

// ---------------------------------------------------------------- report

const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const rows = [];
for (const harness of HARNESSES) {
  for (const arm of ARMS) {
    const ok = runs.filter((r) => r.harness === harness && r.arm === arm && !r.error);
    const byCat = (cat) => {
      const keys = Object.keys(CATEGORY).filter((k) => CATEGORY[k] === cat);
      return mean(ok.map((r) => keys.filter((k) => r.hits[k]).length / keys.length));
    };
    rows.push({
      harness, arm, runs: ok.length,
      errors: runs.filter((r) => r.harness === harness && r.arm === arm && r.error).length,
      recall: mean(ok.map((r) => r.recalled / r.total)),
      prompt: byCat('prompt'), file: byCat('file'), command: byCat('command'),
      ctxBefore: mean(ok.map((r) => r.contextBefore)),
      ctxAfter: mean(ok.map((r) => r.contextAfter)),
      compactMs: mean(ok.map((r) => r.compactMs)),
      compactCostUsd: mean(ok.map((r) => r.compactCostUsd)),
      jevApplied: ok.filter((r) => r.jevApplied).length,
      toolViolations: ok.filter((r) => r.recallUsedTools).length,
    });
  }
}
const pct = (x) => (Number.isNaN(x) ? 'n/a' : `${Math.round(x * 100)}%`);
const md = [
  `# Compaction benchmark: Jev vs built-in (${stamp})`,
  '',
  `Agent models: Claude Code ${CLAUDE_MODEL}; Pi openrouter/${PI_MODEL}. Jev via OpenRouter Decisions. ${REPS} rep(s) per cell.`,
  'Recall: 8 planted facts (3 in the prompt, 3 in files read, 2 in command output), asked after compaction with tools disabled.',
  'Context: tokens of the last request before compaction vs the recall request after it.',
  '',
  '| Harness | Arm | Runs | Recall | Prompt facts | File facts | Command facts | Context before → after | Compaction time | Compaction cost | Jev applied | Errors |',
  '| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |',
  ...rows.map((r) => `| ${r.harness} | ${r.arm} | ${r.runs} | ${pct(r.recall)} | ${pct(r.prompt)} | ${pct(r.file)} | ${pct(r.command)} | ${Math.round(r.ctxBefore)} → ${Math.round(r.ctxAfter)} | ${(r.compactMs / 1000).toFixed(1)}s | $${r.compactCostUsd.toFixed(4)} | ${r.arm === 'jev' ? `${r.jevApplied}/${r.runs}` : '-'} | ${r.errors} |`),
  '',
  rows.some((r) => r.toolViolations) ? `Recall turns that used tools despite the instruction: ${rows.map((r) => `${r.harness}/${r.arm}=${r.toolViolations}`).join(', ')}.` : 'No recall turn used tools.',
  '',
  'Notes per run:',
  ...runs.map((r) => `- ${r.harness}/${r.arm}/rep ${r.rep}: ${r.error ? `ERROR ${r.error.slice(0, 200)}` : `${r.recalled}/8 [missed: ${Object.keys(r.hits).filter((k) => !r.hits[k]).join(', ') || 'none'}] — ${r.note}`}`),
  '',
].join('\n');
writeFileSync(join(OUT_DIR, `compaction-${stamp}.json`), JSON.stringify({ stamp, reps: REPS, rows, runs }, null, 2));
writeFileSync(join(OUT_DIR, `compaction-${stamp}.md`), md);
console.log(`\n${md}\nWrote ${join(OUT_DIR, `compaction-${stamp}.md`)}`);
