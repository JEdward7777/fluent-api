import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { makeLlmRequest } from './llm.test-fixtures';
import { createRequestCache, llmRequestHash } from './request-cache';
import { LlmTransportError, requestStructuredResponse } from './structured-request';

vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn() } }));
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'fluent-request-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const schema = z.object({ answer: z.string().min(1) }).strict();
const parse = (text: string) => schema.parse(JSON.parse(text));
const response = '{"answer":"valid"}';

describe('structured request retries and cached evidence', () => {
  it('keeps request and validated raw response evidence and makes cache hits free', async () => {
    const request = { ...makeLlmRequest(), apiKey: 'secret-not-semantic', timeout: 1000 };
    const cache = createRequestCache(directory);
    const transport = vi.fn().mockResolvedValue(response);
    const options = { request, cache, transport, parse };
    const fresh = await requestStructuredResponse(options);
    expect(fresh).toMatchObject({
      request: makeLlmRequest(),
      requestHash: llmRequestHash(request),
      response,
      result: { answer: 'valid' },
      attempts: 1,
      cacheHit: false,
    });
    expect(await requestStructuredResponse(options)).toMatchObject({
      ...fresh,
      attempts: 0,
      cacheHit: true,
    });
    expect(transport).toHaveBeenCalledOnce();
    expect(JSON.stringify(fresh)).not.toContain('secret-not-semantic');
    expect(fresh.request).not.toHaveProperty('timeout');
    expect(fresh.request.responseSchema).not.toBe(request.responseSchema);
  });
  it('bypasses lookup with noCache but refreshes successful disk and memory entries', async () => {
    const request = makeLlmRequest();
    const cache = createRequestCache(directory);
    await cache.write(request, response);
    const transport = vi.fn().mockResolvedValue('{"answer":"fresh"}');
    expect(
      await requestStructuredResponse({ request, cache, transport, parse, noCache: true })
    ).toMatchObject({ cacheHit: false, result: { answer: 'fresh' } });
    expect(transport).toHaveBeenCalledOnce();
    expect(await cache.read(request)).toContain('fresh');
    expect(await createRequestCache(directory).read(request)).toContain('fresh');
  });
  it('never counts a malformed cached structured response', async () => {
    const request = makeLlmRequest();
    const cache = createRequestCache(directory);
    await cache.write(request, '{"answer":42}');
    const transport = vi.fn().mockResolvedValue(response);
    expect(await requestStructuredResponse({ request, cache, transport, parse })).toMatchObject({
      cacheHit: false,
      result: { answer: 'valid' },
    });
    expect(transport).toHaveBeenCalledOnce();
  });
  it('retries transient and invalid structured output five total times with bounded exponential jitter', async () => {
    const transport = vi
      .fn()
      .mockRejectedValueOnce(new LlmTransportError(true))
      .mockResolvedValueOnce('refused')
      .mockResolvedValueOnce('{"answer":42}')
      .mockRejectedValueOnce(new LlmTransportError(true, 503))
      .mockResolvedValueOnce(response);
    const sleep = vi.fn().mockResolvedValue(undefined);
    expect(
      await requestStructuredResponse({
        request: makeLlmRequest(),
        cache: createRequestCache(directory),
        transport,
        parse,
        sleep,
        random: () => 0.5,
      })
    ).toMatchObject({ attempts: 5, cacheHit: false });
    expect(transport).toHaveBeenCalledTimes(5);
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([1000, 2000, 4000, 8000]);
  });
  it.each([0, 1])('applies jitter at random %s', async (random) => {
    const transport = vi
      .fn()
      .mockRejectedValueOnce(new LlmTransportError(true))
      .mockResolvedValue(response);
    const sleep = vi.fn().mockResolvedValue(undefined);
    await requestStructuredResponse({
      request: makeLlmRequest(),
      cache: createRequestCache(directory),
      transport,
      parse,
      sleep,
      random: () => random,
    });
    expect(sleep.mock.calls[0][0]).toBeCloseTo(random === 0 ? 800 : 1200);
  });
  it.each([2500, 120000])('honors Retry-After %s capped at sixty seconds', async (delay) => {
    const transport = vi
      .fn()
      .mockRejectedValueOnce(new LlmTransportError(true, 429, delay))
      .mockResolvedValue(response);
    const sleep = vi.fn().mockResolvedValue(undefined);
    await requestStructuredResponse({
      request: makeLlmRequest(),
      cache: createRequestCache(directory),
      transport,
      parse,
      sleep,
    });
    expect(sleep).toHaveBeenCalledWith(Math.min(delay, 60000));
  });
  it.each([400, 401, 403, 404])(
    'fails HTTP %s immediately with request diagnostics',
    async (status) => {
      const request = makeLlmRequest();
      const transport = vi.fn().mockRejectedValue(new LlmTransportError(false, status));
      const sleep = vi.fn();
      await expect(
        requestStructuredResponse({
          request,
          cache: createRequestCache(directory),
          transport,
          parse,
          sleep,
        })
      ).rejects.toThrow(`HTTP ${status}`);
      expect(transport).toHaveBeenCalledOnce();
      expect(sleep).not.toHaveBeenCalled();
    }
  );
  it.each(['invalid output', 'transient transport'])(
    'aborts exhausted %s without caching a vote',
    async (failure) => {
      const request = makeLlmRequest();
      const cache = createRequestCache(directory);
      const transport =
        failure === 'invalid output'
          ? vi.fn().mockResolvedValue('{"answer":""}')
          : vi.fn().mockRejectedValue(new LlmTransportError(true, 500));
      const sleep = vi.fn().mockResolvedValue(undefined);
      await expect(
        requestStructuredResponse({ request, cache, transport, parse, sleep })
      ).rejects.toThrow(`request ${llmRequestHash(request)}`);
      expect(transport).toHaveBeenCalledTimes(5);
      expect(sleep).toHaveBeenCalledTimes(4);
      expect(await cache.read(request)).toBeNull();
    }
  );
});
