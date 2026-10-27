import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { hashCanonicalJson } from './canonical-json';
import { makeLlmRequest } from './llm.test-fixtures';
import { createRequestCache, llmRequestHash } from './request-cache';

vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn() } }));
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'fluent-llm-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const pathFor = (hash: string) =>
  join(directory, hash.slice(0, 2), hash.slice(2, 4), `${hash}.json`);

describe('canonical request-addressed cache', () => {
  it('uses JCS key ordering with ordered message arrays and excludes transport credentials', () => {
    const request = makeLlmRequest();
    const reordered = {
      settings: request.settings,
      responseSchema: request.responseSchema,
      messages: request.messages,
      model: request.model,
      provider: request.provider,
    };
    const transportEnvelope = { ...request, apiKey: 'secret-api-key', timeout: 1000 };
    expect(llmRequestHash(request)).toBe(llmRequestHash(reordered));
    expect(llmRequestHash(request)).toBe(llmRequestHash(transportEnvelope));
    expect(llmRequestHash(request)).toBe(hashCanonicalJson(JSON.parse(JSON.stringify(request))));
    expect(hashCanonicalJson({ a: 1, b: 'é' })).toBe(hashCanonicalJson({ b: 'é', a: 1 }));
    expect(() => hashCanonicalJson({ value: Number.NaN })).toThrow();
  });
  it.each(['provider', 'model', 'messages', 'responseSchema', 'settings'] as const)(
    'changes request identity for semantic %s changes',
    (field) => {
      const original = makeLlmRequest();
      const changed = makeLlmRequest({
        [field]:
          field === 'messages'
            ? [...original.messages].reverse()
            : field === 'settings'
              ? { temperature: 0.3 }
              : field === 'responseSchema'
                ? { type: 'string' }
                : 'changed',
      });
      expect(llmRequestHash(changed)).not.toBe(llmRequestHash(original));
    }
  );
  it('uses two-directory fanout, retains evidence only, and reads across instances', async () => {
    const request = makeLlmRequest();
    const hash = llmRequestHash(request);
    const cache = createRequestCache(directory);
    expect(await cache.read(request)).toBeNull();
    await cache.write(request, 'response');
    const content = await readFile(pathFor(hash), 'utf8');
    expect(JSON.parse(content)).toMatchObject({
      version: 1,
      requestHash: hash,
      provider: request.provider,
      model: request.model,
      response: 'response',
    });
    expect(content).not.toContain('apiKey');
    expect(await createRequestCache(directory).read(request)).toBe('response');
    await rm(pathFor(hash));
    expect(await cache.read(request)).toBe('response'); // memory level
  });
  it.each([
    'invalid JSON',
    JSON.stringify({ version: 1 }),
    JSON.stringify({
      version: 1,
      requestHash: 'wrong',
      provider: 'google',
      model: 'wrong',
      response: 'untrusted',
      storedAt: '2026-10-27T00:00:00.000Z',
    }),
  ])('ignores corrupt cache data %j', async (content) => {
    const request = makeLlmRequest();
    await createRequestCache(directory).write(request, 'valid');
    await writeFile(pathFor(llmRequestHash(request)), content);
    expect(await createRequestCache(directory).read(request)).toBeNull();
  });
});
