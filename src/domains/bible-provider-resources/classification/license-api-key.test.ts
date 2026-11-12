import { describe, expect, it } from 'vitest';

import { licenseApiKey } from './license-api-key';

describe('license provider key', () => {
  it('uses the canonical Google AI key', () => {
    expect(licenseApiKey({ GOOGLE_AI_API_KEY: '  canonical  ', GEMINI_API_KEY: 'legacy' })).toBe(
      'canonical'
    );
  });

  it('rejects blank or missing canonical keys even with a legacy key', () => {
    expect(licenseApiKey({ GOOGLE_AI_API_KEY: '  ', GEMINI_API_KEY: 'legacy' })).toBe('');
    expect(licenseApiKey({ GEMINI_API_KEY: 'legacy' })).toBe('');
  });
});
