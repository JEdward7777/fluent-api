import { ApiError, GoogleGenAI } from '@google/genai';

import type { LlmTransport } from './structured-request';

import { LlmTransportError } from './structured-request';

function retryableStatus(status: number) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function retryAfterMilliseconds(value: string | null): number | undefined {
  if (value === null || !value.trim()) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : Math.max(0, timestamp - Date.now());
}

/** Direct Developer API only. Disable SDK retries; the structured runner owns all five attempts. */
export function createGoogleTransport(apiKey: string): LlmTransport {
  if (!apiKey.trim()) throw new Error('A nonempty GOOGLE_AI_API_KEY is required');
  return async (request) => {
    if (request.provider !== 'google') throw new LlmTransportError(false);
    // Per attempt, not shared across concurrent samples: failures after an HTTP success
    // are malformed/unreadable provider output, while pre-fetch config failures are terminal.
    let successfulResponseReceived = false;
    const client = new GoogleGenAI({
      apiKey,
      vertexai: false,
      httpOptions: {
        timeout: 60_000,
        retryOptions: { attempts: 1 },
        fetch: async (url, init) => {
          let response: Response;
          try {
            response = await globalThis.fetch(url, init);
          } catch {
            throw new LlmTransportError(true);
          }
          if (!response.ok)
            throw new LlmTransportError(
              retryableStatus(response.status),
              response.status,
              retryAfterMilliseconds(response.headers.get('retry-after'))
            );
          successfulResponseReceived = true;
          return response;
        },
      },
    });
    try {
      const response = await client.models.generateContent({
        model: request.model,
        contents: request.messages
          .filter((message) => message.role !== 'system')
          .map((message) => ({
            role: message.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: message.content }],
          })),
        config: {
          systemInstruction: request.messages
            .filter((message) => message.role === 'system')
            .map((message) => message.content)
            .join('\n\n'),
          responseMimeType: 'application/json',
          responseJsonSchema: request.responseSchema,
          ...request.settings,
        },
      });
      return response.text ?? '';
    } catch (error) {
      if (error instanceof LlmTransportError) throw error;
      if (successfulResponseReceived) throw new LlmTransportError(true);
      if (error instanceof ApiError)
        throw new LlmTransportError(retryableStatus(error.status), error.status);
      if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))
        throw new LlmTransportError(true);
      throw new LlmTransportError(false);
    }
  };
}
