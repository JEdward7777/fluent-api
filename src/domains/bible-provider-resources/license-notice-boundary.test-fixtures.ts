import { hashCanonicalJson } from '@/lib/llm/canonical-json';
import { llmRequestHash } from '@/lib/llm/request-cache';

import type { LicenseClassification } from './license-artifact.schemas';

import { buildLicenseSampleRequest } from './license-model-contract';
import { normalizeLicenseNotice } from './license-normalizer';

export const noticeForms = {
  empty: '',
  whitespace: '  ',
  normalizesEmpty: '© 2025',
  ordinary: 'Copyright © 2025 Example Publisher',
  nonFixedPoint: 'Copy©right restrictions',
};

export const producers = [
  'table',
  'manual',
  'manual-table',
  'rule',
  'manual-rule',
  'gemini',
  'manual-gemini',
] as const;

export const noticeMatrixSigner = {
  reviewedBy: 'Historic file signer',
  reviewedAt: '2025-04-03T00:00:00.000Z',
  reviewReason: 'Checked the notice matrix case',
};

export function noticeBoundaryInput(
  producer: (typeof producers)[number],
  exampleNotice: string,
  version: 2 | 3 | 4
) {
  const prompt = 'Check the notice';
  const model = { provider: 'test', model: 'model', sampleCount: 2, settings: {} };
  const contract = {
    prompt,
    promptHash: hashCanonicalJson(prompt),
    ruleSetHash: 'a'.repeat(64),
    responseSchema: {},
    models: [model],
  };
  const manual = producer.startsWith('manual');
  const source =
    producer === 'manual'
      ? undefined
      : (producer.replace('manual-', '') as 'table' | 'gemini' | 'rule');
  const proposal = {
    source: source ?? 'table',
    status: 'allowed' as const,
    rationale: 'Recorded decision',
  };
  const row: LicenseClassification = {
    normalizedText: normalizeLicenseNotice(exampleNotice),
    exampleNotice,
    status: 'allowed',
    source: manual ? 'manual' : proposal.source,
    rationale: manual ? 'Human ruling' : proposal.rationale,
    ...(manual && source ? { automaticDecision: proposal } : {}),
    ...(source === 'rule'
      ? {
          rule: {
            id: 'test-rule',
            priority: 1,
            matchedExcerpt: exampleNotice.trim() || 'absent',
            decision: proposal.status,
            rationale: proposal.rationale,
          },
        }
      : {}),
    samples:
      source === 'gemini'
        ? [1, 2].map((index) => {
            const request = buildLicenseSampleRequest(
              exampleNotice,
              model.provider,
              model.model,
              index,
              { prompt, responseSchema: {}, settings: {} }
            );
            const result = { rationale: 'Test vote', decision: 'allowed' as const };
            return {
              index,
              provider: model.provider,
              model: model.model,
              request,
              requestHash: llmRequestHash(request),
              result,
              response: JSON.stringify(result),
            };
          })
        : [],
    ...(version === 2
      ? {}
      : {
          reviewState: manual
            ? ('human_reviewed' as const)
            : source === 'gemini'
              ? ('llm_reviewed' as const)
              : ('unreviewed' as const),
          reviewedBy: manual ? 'Historic row reviewer' : null,
          decisionAt: manual ? '2025-04-01T00:00:00.000Z' : null,
          humanReviewedAt: manual ? '2025-04-01T00:00:00.000Z' : null,
        }),
  };
  return { catalog: [], classificationRun: contract, classifications: [row] };
}
