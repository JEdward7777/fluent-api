import type { LlmRequest } from './request-cache';

export function makeLlmRequest(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    provider: 'google',
    model: 'gemini-3.8-flash',
    messages: [
      { role: 'system', content: 'Explain, then decide.' },
      { role: 'user', content: 'Notice' },
    ],
    responseSchema: {
      type: 'object',
      properties: { rationale: { type: 'string' }, decision: { type: 'string' } },
      required: ['rationale', 'decision'],
    },
    settings: { temperature: 1 },
    ...overrides,
  };
}
