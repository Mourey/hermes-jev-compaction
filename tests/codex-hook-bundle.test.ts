import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const bundlePath = 'codex/codex-hook.mjs';

describe('Codex hook bundle', () => {
  it('is up to date with src (run npm run build:codex)', async () => {
    const result = await build({
      entryPoints: ['src/codex-hook.ts'],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node18',
      legalComments: 'none',
      write: false,
      outfile: bundlePath,
    });
    expect(result.outputFiles[0]!.text).toBe(readFileSync(bundlePath, 'utf8'));
  });

  function restore(env: Record<string, string>): string {
    const data = mkdtempSync(join(tmpdir(), 'fast-jev-codex-'));
    const sessionId = 's-1';
    const digest = createHash('sha256').update(sessionId).digest('hex');
    mkdirSync(join(data, 'sessions'), { recursive: true });
    writeFileSync(
      join(data, 'sessions', `${digest}.jsonl`),
      `${JSON.stringify({ kind: 'prompt', prompt: 'Fix the test.' })}\n`,
    );
    const run = spawnSync('node', [bundlePath], {
      input: JSON.stringify({ session_id: sessionId, hook_event_name: 'SessionStart', source: 'compact' }),
      env: { PATH: process.env.PATH ?? '', PLUGIN_DATA: data, ...env },
      encoding: 'utf8',
    });
    expect(run.status).toBe(0);
    return run.stdout;
  }

  it('runs standalone and names the missing key for the chosen endpoint', () => {
    expect(JSON.parse(restore({})).systemMessage).toMatch(/TYPESAFE_API_KEY is not configured/);
    expect(JSON.parse(restore({ FAST_JEV_PROVIDER: 'openrouter' })).systemMessage).toMatch(
      /OPENROUTER_API_KEY is not configured/,
    );
  });
});
