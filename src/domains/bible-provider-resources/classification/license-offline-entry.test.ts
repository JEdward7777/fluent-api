import type { Buffer } from 'node:buffer';

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { makeCommandFixture } from './license-command.test-fixtures';

async function invoke(directory: string, args: string[], key: string) {
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
        env: { PATH: process.env.PATH, HOME: process.env.HOME, GEMINI_API_KEY: key },
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
  it('runs JSON-to-JSON with only a Gemini key and writes exact authority without DB/DBL initialization', async () => {
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
        'mock-offline-key'
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
        ''
      );
      expect(result.code).toBe(1);
      expect(result.output).toContain('GEMINI_API_KEY');
      const omission = await invoke(f.dir, ['--yes'], 'mock');
      expect(omission.code).toBe(1);
      expect(omission.output).toContain('Select both');
      expect(omission.output).toContain('Usage: npm run db:classify:licenses');
    } finally {
      await f.cleanup();
    }
  }, 30000);
});
