import type { Buffer } from 'node:buffer';

import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { makeCommandFixture } from './license-command.test-fixtures';

async function invoke(
  directory: string,
  args: string[],
  keys: { GOOGLE_AI_API_KEY?: string; GEMINI_API_KEY?: string }
) {
  return new Promise<{ code: number | null; output: string }>((done, reject) => {
    const child = spawn(
      process.execPath,
      [
        resolve('node_modules/tsx/dist/cli.mjs'),
        '--tsconfig',
        resolve('tsconfig.json'),
        resolve('src/db/scripts/classify-licenses.ts'),
        ...args,
      ],
      {
        cwd: directory,
        // No app .env, DATABASE_URL, DBL credentials, auth settings, or inherited provider key.
        env: { PATH: process.env.PATH, HOME: process.env.HOME, ...keys },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    let output = '';
    child.stdout.on('data', (data: Buffer) => {
      output += data.toString();
    });
    child.stderr.on('data', (data: Buffer) => {
      output += data.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => done({ code, output }));
  });
}

describe('actual offline developer entry without application environment', () => {
  it('runs JSON-to-JSON with only the Google AI key and writes exact authority without DB/DBL initialization', async () => {
    const f = await makeCommandFixture();
    try {
      const result = await invoke(
        f.dir,
        [
          '--source=json',
          '--destination=json',
          '--yes',
          `--input=${f.input}`,
          `--output=${f.output}`,
          '--report-formats=none',
        ],
        { GOOGLE_AI_API_KEY: 'mock-offline-key' }
      );
      expect(result.code, result.output).toBe(2);
      expect(JSON.parse(await readFile(f.output, 'utf8')).reviewContentHash).toBe(
        f.artifact.reviewContentHash
      );
      expect(result.output).toContain('Production impact is unavailable');
      expect(await readFile(f.input, 'utf8')).toBe(f.sourceBytes);
    } finally {
      await f.cleanup();
    }
  }, 30000);
  it('rejects missing credential and omitted configuration before source access with usable help', async () => {
    const f = await makeCommandFixture();
    try {
      const result = await invoke(
        f.dir,
        ['--source=json', '--destination=json', '--input=/missing', '--yes'],
        { GOOGLE_AI_API_KEY: '' }
      );
      expect(result.code).toBe(1);
      expect(result.output).toContain('GOOGLE_AI_API_KEY');
      const omission = await invoke(f.dir, ['--yes'], { GOOGLE_AI_API_KEY: 'mock' });
      expect(omission.code).toBe(1);
      expect(omission.output).toContain('Select both');
      expect(omission.output).toContain('Usage: npm run db:classify:licenses');
    } finally {
      await f.cleanup();
    }
  }, 30000);
  it('does not accept the legacy key alone', async () => {
    const f = await makeCommandFixture();
    try {
      const result = await invoke(
        f.dir,
        ['--source=json', '--destination=json', '--input=/missing', '--yes'],
        { GEMINI_API_KEY: 'legacy-only' }
      );
      expect(result.code).toBe(1);
      expect(result.output).toContain('GOOGLE_AI_API_KEY');
      expect(result.output).not.toContain('JSON source not found');
    } finally {
      await f.cleanup();
    }
  }, 30000);
  it('loads a local model before CLI validation and lets --model override it', async () => {
    const f = await makeCommandFixture();
    try {
      await writeFile(resolve(f.dir, '.env'), 'GOOGLE_AI_MODEL=openrouter:unsupported\n');
      const args = ['--source=json', '--destination=json', '--input=/missing', '--yes'];
      const invalid = await invoke(f.dir, args, { GOOGLE_AI_API_KEY: 'offline-test-key' });
      expect(invalid.code).toBe(1);
      expect(invalid.output).toContain('Unsupported model prefix');
      expect(invalid.output).not.toContain('JSON source not found');
      const explicit = await invoke(f.dir, [...args, '--model=google:chosen'], {
        GOOGLE_AI_API_KEY: 'offline-test-key',
      });
      expect(explicit.output).toContain('JSON source not found');
    } finally {
      await f.cleanup();
    }
  }, 30000);
  it('shows the local model in actual browser setup before Inspect', async () => {
    const f = await makeCommandFixture();
    await writeFile(resolve(f.dir, '.env'), 'GOOGLE_AI_MODEL=gemini-2.5-flash-lite\n');
    const child = spawn(
      process.execPath,
      [
        resolve('node_modules/tsx/dist/cli.mjs'),
        '--tsconfig',
        resolve('tsconfig.json'),
        resolve('src/db/scripts/classify-licenses.ts'),
        '--ui=web',
      ],
      {
        cwd: f.dir,
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    const closed = new Promise<void>((done) => child.once('close', () => done()));
    let startupTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const url = await Promise.race([
        new Promise<string>((done, reject) => {
          let output = '';
          child.stdout.on('data', (data: Buffer) => {
            output += data.toString();
            const match = /Open (http:\/\/127\.0\.0\.1:\d+\/#\S+)/.exec(output);
            if (match) done(match[1]);
          });
          child.once('error', reject);
          child.once('close', (code) =>
            reject(new Error(`Workbench exited before setup: ${code}`))
          );
        }),
        new Promise<never>((_, reject) => {
          startupTimeout = setTimeout(
            () => reject(new Error('Workbench did not start within 10 seconds')),
            10000
          );
        }),
      ]);
      clearTimeout(startupTimeout);
      const address = new URL(url);
      const response = await fetch(`${address.origin}/api/setup`, {
        headers: { 'x-workbench-token': address.hash.slice(1) },
      });
      expect(response.status).toBe(200);
      const setup = await response.json();
      expect(setup).toMatchObject({ state: 'configuring', model: 'google:gemini-2.5-flash-lite' });
      expect(setup.inspected).toBeNull();
      const edited = await fetch(`${address.origin}/api/setup`, {
        method: 'POST',
        headers: {
          'x-workbench-token': address.hash.slice(1),
          origin: address.origin,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          configurationRevision: setup.configurationRevision,
          discardReviewedState: false,
          source: 'json',
          destination: 'json',
          input: setup.input,
          output: setup.output,
          model: 'google:editor-choice',
          sampleCount: setup.sampleCount,
          force: setup.force,
          noCache: setup.noCache,
          cacheDir: setup.cacheDir,
          reportFormats: setup.reportFormats,
          reportDir: setup.reportDir,
          preserveExistingNonUnknowns: setup.preserveExistingNonUnknowns,
        }),
      });
      expect(edited.status).toBe(200);
      expect(await edited.json()).toMatchObject({ model: 'google:editor-choice' });
    } finally {
      clearTimeout(startupTimeout);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await closed;
      await f.cleanup();
    }
  }, 30000);
  it('keeps help and practice independent of a malformed local model', async () => {
    const f = await makeCommandFixture();
    try {
      await writeFile(resolve(f.dir, '.env'), 'GOOGLE_AI_MODEL=openrouter:unsupported\n');
      const help = await invoke(f.dir, ['--help'], {});
      expect(help.code).toBe(0);
      expect(help.output).toContain('Usage: npm run db:classify:licenses');
      expect(help.output).not.toContain('Unsupported model');
      const practice = await invoke(f.dir, ['--practice'], {});
      expect(practice.output).toContain('requires explicit --ui=web');
      expect(practice.output).not.toContain('Unsupported model');
    } finally {
      await f.cleanup();
    }
  }, 30000);
});
