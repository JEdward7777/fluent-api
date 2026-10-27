import { vi } from 'vitest';

import type { runLicenseReview } from './license-review';

export function makeLicenseReviewConfig(
  overrides: Partial<Parameters<typeof runLicenseReview>[0]['config']> = {}
): Parameters<typeof runLicenseReview>[0]['config'] {
  return { source: 'json', destination: 'json', interactive: true, formats: 'none', ...overrides };
}
export function scriptedLicenseReviewIo(answers: string[]) {
  let next = 0;
  return {
    ask: vi.fn(async (question: string) => {
      if (next >= answers.length) throw new Error(`Unexpected additional question: ${question}`);
      return answers[next++];
    }),
    write: vi.fn<(message: string) => void>(),
  };
}
