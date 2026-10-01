import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const CLI = resolve('bin/hermes-compact.mjs');
const transcript = [
  { role: 'system', content: 'You are a coding agent.' },
  { role: 'user', content: 'Fix the failing test.' },
  {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }],
  },
  { role: 'tool', tool_call_id: 'c1', content: 'x'.repeat(2000) },
  { role: 'assistant', content: 'Done.' },
];

// Only what node needs: never the developer's real keys or endpoint overrides.
function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: process.env.HOME, ...extra };
}

function run(args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [CLI, ...args], { env });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.stdout.resume();
    child.on('close', (status) => done({ status, stderr }));
  });
}

describe('hermes-compact endpoint selection', () => {
  const seen: Array<{ url: string; auth: string | undefined }> = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      seen.push({ url: req.url ?? '', auth: req.headers.authorization });
      const { questions } = JSON.parse(body) as { questions: Record<string, unknown> };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { noul: 1 }])) }));
    });
  });
  let base = '';
  let directory = '';
  let input = '';

  beforeAll(async () => {
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    directory = mkdtempSync(join(tmpdir(), 'hermes-cli-endpoint-'));
    input = join(directory, 'input.json');
    writeFileSync(input, JSON.stringify(transcript));
  });

  afterAll(async () => {
    rmSync(directory, { recursive: true, force: true });
    await new Promise((closed) => server.close(closed));
  });

  it('sends --base-url its TypeSafe-named key, over an OpenRouter provider', async () => {
    seen.length = 0;
    const result = await run(
      [input, '--preserve-recent', '1', '--provider', 'openrouter', '--base-url', `${base}/v1/systemone`],
      cleanEnv({ TYPESAFE_API_KEY: 'ts-key', OPENROUTER_API_KEY: 'or-key' }),
    );
    expect(result.status, result.stderr).toBe(0);
    expect(seen).toEqual([{ url: '/v1/systemone', auth: 'Bearer ts-key' }]);
    expect(result.stderr).toContain(`to 127.0.0.1:`);
  });

  it('reads FAST_JEV_BASE_URL and FAST_JEV_API_KEY from the environment', async () => {
    seen.length = 0;
    const result = await run(
      [input, '--preserve-recent', '1'],
      cleanEnv({ FAST_JEV_BASE_URL: `${base}/jev`, FAST_JEV_API_KEY: 'explicit', TYPESAFE_API_KEY: 'ts-key' }),
    );
    expect(result.status, result.stderr).toBe(0);
    expect(seen).toEqual([{ url: '/jev', auth: 'Bearer explicit' }]);
  });

  it('names the key the chosen endpoint expects when it is missing', () => {
    const openrouter = spawnSync(process.execPath, [CLI, input, '--provider', 'openrouter'], {
      encoding: 'utf8',
      env: cleanEnv({}),
    });
    expect(openrouter.status).toBe(2);
    expect(openrouter.stderr).toContain('OPENROUTER_API_KEY is not configured');

    const typesafe = spawnSync(process.execPath, [CLI, input], { encoding: 'utf8', env: cleanEnv({}) });
    expect(typesafe.status).toBe(2);
    expect(typesafe.stderr).toContain('TYPESAFE_API_KEY is not configured');
  });

  it('rejects an unknown provider', () => {
    const run = spawnSync(process.execPath, [CLI, input, '--provider', 'anthropic'], {
      encoding: 'utf8',
      env: cleanEnv({}),
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('unknown provider: anthropic');
  });
});
