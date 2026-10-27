import { setTimeout } from 'node:timers/promises';

import { logger } from '@/lib/logger';

import type { createRequestCache, LlmRequest } from './request-cache';

import { llmRequestHash } from './request-cache';

export class LlmTransportError extends Error {
  constructor(
    readonly retryable: boolean,
    readonly status?: number,
    readonly retryAfterMs?: number
  ) {
    super(status === undefined ? 'LLM transport failed' : `LLM HTTP ${status}`);
  }
}

export type LlmTransport = (request: LlmRequest) => Promise<string>;

interface RequestOptions<T> {
  request: LlmRequest;
  transport: LlmTransport;
  parse: (text: string) => T;
  cache: ReturnType<typeof createRequestCache>;
  noCache?: boolean;
  sleep?: (milliseconds: number) => Promise<unknown>;
  random?: () => number;
}

export async function requestStructuredResponse<T>(options: RequestOptions<T>) {
  const { request: input, transport, parse, cache } = options;
  // Freeze the semantic snapshot independently of caller-owned objects/transport credentials.
  const request = structuredClone({
    provider: input.provider,
    model: input.model,
    messages: input.messages,
    responseSchema: input.responseSchema,
    settings: input.settings,
  });
  const requestHash = llmRequestHash(request);
  const provenance = { provider: request.provider, model: request.model, requestHash, request };
  if (!options.noCache) {
    const cached = await cache.read(request);
    if (cached !== null) {
      try {
        return {
          ...provenance,
          response: cached,
          result: parse(cached),
          cacheHit: true,
          attempts: 0,
        };
      } catch {
        logger.warn({
          message: 'Ignoring invalid structured LLM cache response',
          context: provenance,
        });
      }
    }
  }
  const sleep = options.sleep ?? setTimeout;
  const random = options.random ?? Math.random;
  for (let attempt = 1; attempt <= 5; attempt++) {
    let retryAfterMs: number | undefined;
    let response: string | undefined;
    try {
      response = await transport(request);
    } catch (error) {
      if (!(error instanceof LlmTransportError) || !error.retryable) {
        const status =
          error instanceof LlmTransportError && error.status !== undefined
            ? ` (HTTP ${error.status})`
            : '';
        throw new Error(
          `LLM request failed immediately${status}: ${request.provider}:${request.model}, request ${requestHash}, attempt ${attempt}`
        );
      }
      retryAfterMs = error.retryAfterMs;
    }
    if (response !== undefined) {
      let parsed: { value: T } | null = null;
      try {
        parsed = { value: parse(response) };
      } catch {
        /* Invalid/refused structured output is retryable, never a vote. */
      }
      if (parsed) {
        await cache.write(request, response);
        return {
          ...provenance,
          response,
          result: parsed.value,
          cacheHit: false,
          attempts: attempt,
        };
      }
    }
    if (attempt === 5)
      throw new Error(
        `LLM request exhausted 5 attempts: ${request.provider}:${request.model}, request ${requestHash}`
      );
    const backoff = 1000 * 2 ** (attempt - 1) * (0.8 + random() * 0.4);
    await sleep(retryAfterMs === undefined ? backoff : Math.min(Math.max(0, retryAfterMs), 60_000));
  }
  throw new Error('Unreachable LLM retry state');
}
