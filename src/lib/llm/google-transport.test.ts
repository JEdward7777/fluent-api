import { afterEach, describe, expect, it, vi } from 'vitest';

import type { createRequestCache } from './request-cache';

import { createGoogleTransport } from './google-transport';
import { makeLlmRequest } from './llm.test-fixtures';
import { requestStructuredResponse } from './structured-request';

vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn() } }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const generatedResponse = (text = '{"rationale":"Permitted","decision":"allowed"}') =>
  new Response(
    JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
    }),
    { headers: { 'content-type': 'application/json' } }
  );

describe('direct Google SDK transport (fake fetch, no live calls)', () => {
  it('sends the audited messages/schema/settings using the Developer API', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(generatedResponse());
    vi.stubGlobal('fetch', fetch);
    const request = makeLlmRequest();
    expect(await createGoogleTransport('fake-test-key')(request)).toContain('"decision":"allowed"');
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toContain('generativelanguage.googleapis.com');
    expect(String(url)).toContain('gemini-3.8-flash:generateContent');
    const body: unknown = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      systemInstruction: { parts: [{ text: request.messages[0].content }] },
      contents: [{ role: 'user', parts: [{ text: request.messages[1].content }] }],
      generationConfig: {
        temperature: 1,
        responseMimeType: 'application/json',
        responseJsonSchema: request.responseSchema,
      },
    });
  });
  it.each([400, 401, 403, 404, 408, 429, 500, 503])(
    'preserves HTTP %s error semantics without hidden SDK retries',
    async (status) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(
          new Response('upstream rejected request', { status, headers: { 'Retry-After': '2.5' } })
        );
      vi.stubGlobal('fetch', fetch);
      await expect(createGoogleTransport('fake-test-key')(makeLlmRequest())).rejects.toMatchObject({
        retryable: status === 408 || status === 429 || status >= 500,
        status,
        retryAfterMs: 2500,
      });
      expect(fetch).toHaveBeenCalledOnce();
    }
  );
  it('preserves HTTP-date Retry-After', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-27T00:00:00Z'));
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        new Response('', {
          status: 429,
          headers: { 'Retry-After': 'Tue, 27 Oct 2026 00:00:05 GMT' },
        })
      )
    );
    await expect(createGoogleTransport('fake-test-key')(makeLlmRequest())).rejects.toMatchObject({
      retryable: true,
      retryAfterMs: 5000,
    });
  });
  it.each([new TypeError('fetch failed'), new DOMException('timed out', 'TimeoutError')])(
    'retries network/timeout failures',
    async (failure) => {
      vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockRejectedValue(failure));
      await expect(createGoogleTransport('fake-test-key')(makeLlmRequest())).rejects.toMatchObject({
        retryable: true,
      });
    }
  );
  it('retries a connection reset while consuming a successful HTTP response body', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.error(new TypeError('terminated'));
      },
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(new Response(body, { headers: { 'Content-Type': 'application/json' } }))
    );
    await expect(createGoogleTransport('fake-test-key')(makeLlmRequest())).rejects.toMatchObject({
      retryable: true,
    });
  });
  it('retries malformed upstream JSON after HTTP 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(
          new Response('invalid JSON', { headers: { 'Content-Type': 'application/json' } })
        )
    );
    await expect(createGoogleTransport('fake-test-key')(makeLlmRequest())).rejects.toMatchObject({
      retryable: true,
    });
  });
  it('keeps five total attempts and honors capped Retry-After through the real SDK', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(
        async () => new Response('', { status: 429, headers: { 'Retry-After': '120' } })
      );
    vi.stubGlobal('fetch', fetch);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const cache = { read: vi.fn().mockResolvedValue(null), write: vi.fn() } satisfies ReturnType<
      typeof createRequestCache
    >;
    await expect(
      requestStructuredResponse({
        request: makeLlmRequest(),
        transport: createGoogleTransport('fake-test-key'),
        parse: JSON.parse,
        cache,
        sleep,
      })
    ).rejects.toThrow('exhausted 5 attempts');
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([60000, 60000, 60000, 60000]);
    expect(cache.write).not.toHaveBeenCalled();
  });
  it.each(['null', '{"candidates":[{"content":{"parts":{}}}]}'])(
    'retries malformed HTTP-200 provider envelopes %s for five total attempts',
    async (body) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementation(
          async () => new Response(body, { headers: { 'Content-Type': 'application/json' } })
        );
      vi.stubGlobal('fetch', fetch);
      const sleep = vi.fn().mockResolvedValue(undefined);
      const cache = { read: vi.fn().mockResolvedValue(null), write: vi.fn() } satisfies ReturnType<
        typeof createRequestCache
      >;
      await expect(
        requestStructuredResponse({
          request: makeLlmRequest(),
          transport: createGoogleTransport('fake-test-key'),
          parse: JSON.parse,
          cache,
          sleep,
        })
      ).rejects.toThrow('exhausted 5 attempts');
      expect(fetch).toHaveBeenCalledTimes(5);
      expect(sleep).toHaveBeenCalledTimes(4);
      expect(cache.write).not.toHaveBeenCalled();
    }
  );

  it('keeps SDK configuration failures terminal with response state isolated per call', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response('null', { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    const transport = createGoogleTransport('fake-test-key');
    await expect(transport(makeLlmRequest())).rejects.toMatchObject({ retryable: true });
    const request = makeLlmRequest({ settings: { tools: 'invalid-not-an-array' } });
    await expect(transport(request)).rejects.toMatchObject({ retryable: false });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('rejects missing credentials and unsupported providers before fetching', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal('fetch', fetch);
    expect(() => createGoogleTransport(' ')).toThrow('GEMINI_API_KEY');
    await expect(
      createGoogleTransport('fake-test-key')(makeLlmRequest({ provider: 'openrouter' }))
    ).rejects.toMatchObject({ retryable: false });
    expect(fetch).not.toHaveBeenCalled();
  });
});
