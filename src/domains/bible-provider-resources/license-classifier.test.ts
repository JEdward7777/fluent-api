import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LlmRequest } from '@/lib/llm/request-cache';

import { hashCanonicalJson } from '@/lib/llm/canonical-json';
import { llmRequestHash } from '@/lib/llm/request-cache';
import { LlmTransportError } from '@/lib/llm/structured-request';

import { createLicenseClassifier } from './license-classifier';
import { normalizeLicenseNotice } from './license-normalizer';

vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn() } }));
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'fluent-license-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const notice = 'Publisher-specific use terms require interpretation.';
const vote = (decision: string) =>
  JSON.stringify({ rationale: 'A concise evidence-based reason.', decision });
const indexOf = (request: LlmRequest) =>
  Number(/Independent sample index: (\d+)/.exec(request.messages[1].content)?.[1]);
const options = () => ({
  apiKey: 'mock-key',
  cacheDir: directory,
  sleep: vi.fn().mockResolvedValue(undefined),
});

describe('license classifier', () => {
  it.each(['allowed', 'forbidden', 'unknown'] as const)(
    'uses authoritative exact %s before automatic ARR',
    async (status) => {
      const transport = vi.fn();
      const classify = createLicenseClassifier({ ...options(), transport });
      const raw = 'Copyright © 2026 All rights reserved. CC BY.';
      const known = new Map([
        [normalizeLicenseNotice(raw), { status, rationale: 'Named reviewer decision.' }],
      ]);
      expect(await classify(raw, known)).toMatchObject({
        source: 'table',
        decision: status,
        rationale: 'Named reviewer decision.',
        provider: 'google',
        model: 'gemini-3.8-flash',
        sampleCount: 3,
        samples: [],
      });
      expect(transport).not.toHaveBeenCalled();
      expect(await readdir(directory)).toEqual([]);
    }
  );
  it('only uses exact normalized matches; authoritative unknown is not a pending inference', async () => {
    const transport = vi.fn().mockResolvedValue(vote('allowed'));
    const classify = createLicenseClassifier({ ...options(), transport });
    expect(
      await classify(
        notice,
        new Map([
          [
            `${normalizeLicenseNotice(notice)} different`,
            { status: 'unknown', rationale: 'Different notice' },
          ],
        ])
      )
    ).toMatchObject({ source: 'gemini', decision: 'allowed' });
    expect(transport).toHaveBeenCalledTimes(3);
  });
  it('stops at the first automatic rule without sampling', async () => {
    const transport = vi.fn();
    const classify = createLicenseClassifier({ ...options(), transport });
    expect(await classify('CC BY-NC-ND; All rights reserved.')).toMatchObject({
      source: 'rule',
      decision: 'forbidden',
      rule: { id: 'all-rights-reserved', matchedExcerpt: 'All rights reserved' },
    });
    expect(transport).not.toHaveBeenCalled();
  });
  const decisions = ['allowed', 'forbidden', 'unknown'] as const;
  const combinations = decisions.flatMap((a) =>
    decisions.flatMap((b) => decisions.map((c) => [a, b, c]))
  );
  it.each(combinations.map((votes) => ({ label: votes.join('/'), votes })))(
    'aggregates all complete votes $label unanimously only',
    async ({ votes }) => {
      const transport = vi.fn(async (request: LlmRequest) => vote(votes[indexOf(request) - 1]));
      const result = await createLicenseClassifier({ ...options(), transport })(notice);
      expect(result.decision).toBe(
        votes.every((decision) => decision === votes[0]) && votes[0] !== 'unknown'
          ? votes[0]
          : 'unknown'
      );
      expect(result.samples).toHaveLength(3);
      for (const sample of result.samples) {
        expect(sample.result.decision).toBe(votes[sample.index - 1]);
        expect(sample.requestHash).toBe(llmRequestHash(sample.request));
        expect(sample.response).toBe(vote(votes[sample.index - 1]));
        expect(sample.provider).toBe('google');
        expect(sample.model).toBe('gemini-3.8-flash');
        expect(sample.request.messages[0].content).toBe(result.prompt);
      }
      expect(hashCanonicalJson(result.prompt)).toBe(result.promptHash);
    }
  );
  it('reuses indexed evidence across reruns/count increases and has no arbitrary sample cap', async () => {
    const transport = vi.fn().mockResolvedValue(vote('allowed'));
    await createLicenseClassifier({ ...options(), transport })(notice);
    expect(transport).toHaveBeenCalledTimes(3);
    const larger = await createLicenseClassifier({ ...options(), transport, sampleCount: 25 })(
      notice
    );
    expect(transport).toHaveBeenCalledTimes(25);
    expect(larger.samples.filter((sample) => sample.cacheHit)).toHaveLength(3);
    const unchanged = await createLicenseClassifier({ ...options(), transport, sampleCount: 25 })(
      notice
    );
    expect(unchanged.samples.every((sample) => sample.cacheHit)).toBe(true);
    expect(transport).toHaveBeenCalledTimes(25);
    expect(transport.mock.calls[0][0].messages[1].content).not.toContain('sample count');
  });
  it('refreshes every indexed sample with noCache', async () => {
    const transport = vi.fn().mockResolvedValue(vote('allowed'));
    await createLicenseClassifier({ ...options(), transport })(notice);
    transport.mockResolvedValue(vote('forbidden'));
    expect(
      await createLicenseClassifier({ ...options(), transport, noCache: true })(notice)
    ).toMatchObject({ decision: 'forbidden' });
    expect(transport).toHaveBeenCalledTimes(6);
    expect(await createLicenseClassifier({ ...options(), transport })(notice)).toMatchObject({
      decision: 'forbidden',
    });
    expect(transport).toHaveBeenCalledTimes(6);
  });
  it('aborts incomplete samples and preserves completed successes for a retry', async () => {
    const transport = vi.fn(async (request: LlmRequest) => {
      if (indexOf(request) === 2) throw new LlmTransportError(true, 503);
      return vote('allowed');
    });
    await expect(createLicenseClassifier({ ...options(), transport })(notice)).rejects.toThrow(
      'exhausted 5 attempts'
    );
    expect(transport).toHaveBeenCalledTimes(7);
    const retry = vi.fn().mockResolvedValue(vote('allowed'));
    const result = await createLicenseClassifier({ ...options(), transport: retry })(notice);
    expect(retry).toHaveBeenCalledOnce();
    expect(result.samples.filter((sample) => sample.cacheHit)).toHaveLength(2);
    expect(result.decision).toBe('allowed');
  });
  it.each([
    'free text',
    '{"decision":"allowed","rationale":"Wrong order"}',
    '{"rationale":"","decision":"allowed"}',
    '{"rationale":"Reason","decision":"maybe"}',
    '{"rationale":"Reason","decision":"allowed","extra":1}',
  ])('rejects invalid structured vote %s', async (invalid) => {
    const transport = vi.fn().mockResolvedValue(invalid);
    await expect(createLicenseClassifier({ ...options(), transport })(notice)).rejects.toThrow(
      'exhausted 5 attempts'
    );
    expect(transport).toHaveBeenCalledTimes(15);
  });
  it.each([0, 1, 1.5, -3, Infinity, Number.NaN])(
    'rejects invalid sample count %s',
    (sampleCount) => {
      expect(() => createLicenseClassifier({ ...options(), sampleCount })).toThrow(
        'integer of at least two'
      );
    }
  );
  it.each(['openrouter:model', 'gemini-model', 'google:', 'google:bad model'])(
    'rejects unsupported model reference %s',
    (model) => {
      expect(() => createLicenseClassifier({ ...options(), model })).toThrow(
        'Use google:<model-id>'
      );
    }
  );
  it('requires a nonempty key before any classification and supports explicit models', async () => {
    expect(() => createLicenseClassifier({ ...options(), apiKey: ' ' })).toThrow(
      'GOOGLE_AI_API_KEY'
    );
    const transport = vi.fn().mockResolvedValue(vote('allowed'));
    const result = await createLicenseClassifier({
      ...options(),
      model: 'google:configured-model',
      transport,
    })(notice);
    expect(result.samples.every((sample) => sample.model === 'configured-model')).toBe(true);
  });
});
