import { createHash } from 'node:crypto';

import type { JsonValue } from '@/lib/llm/canonical-json';

import { hashCanonicalJson } from '@/lib/llm/canonical-json';

import type { LicenseClassification } from '../license-artifact.schemas';
import type { createLicenseClassifier } from '../license-classifier';

type Proposal = Awaited<ReturnType<ReturnType<typeof createLicenseClassifier>>>;

function identity(
  row: LicenseClassification,
  fallback?: LicenseClassification['evidenceContract']
) {
  const digest = (value: object) => hashCanonicalJson(value as unknown as JsonValue);
  const source = row.source === 'manual' ? row.automaticDecision?.source : row.source;
  if (source === 'gemini')
    return digest({
      source,
      status: row.source === 'manual' ? row.automaticDecision!.status : row.status,
      contract: (() => {
        const contract = row.evidenceContract ?? fallback;
        return contract
          ? {
              prompt: contract.prompt,
              promptHash: contract.promptHash,
              ruleSetHash: contract.ruleSetHash,
              responseSchema: contract.responseSchema,
              models: contract.models.map((model) => ({
                provider: model.provider,
                model: model.model,
                sampleCount: model.sampleCount,
                settings: model.settings,
              })),
            }
          : null;
      })(),
      samples: row.samples.map((sample) => ({
        requestHash: sample.requestHash,
        responseDigest: createHash('sha256').update(sample.response).digest('hex'),
        result: sample.result,
      })),
    });
  if (source === 'rule') return digest({ source, rule: row.rule ?? null });
  return null;
}

/** The event clock advances only for materially changed completed evidence. */
export function assessedLicenseRow(input: {
  normalizedText: string;
  exampleNotice: string;
  proposal: Proposal;
  previous?: LicenseClassification;
  classificationRun: LicenseClassification['evidenceContract'];
  previousRun?: LicenseClassification['evidenceContract'];
  now: () => string;
}): LicenseClassification {
  const { proposal, previous } = input;
  const row: LicenseClassification = {
    normalizedText: input.normalizedText,
    exampleNotice: input.exampleNotice,
    status: proposal.decision,
    source: proposal.source,
    rationale: proposal.rationale,
    samples: proposal.samples,
    ...('rule' in proposal ? { rule: proposal.rule } : {}),
    ...(proposal.source === 'gemini' ? { evidenceContract: input.classificationRun } : {}),
    reviewState: proposal.source === 'gemini' ? 'llm_reviewed' : 'unreviewed',
    decisionAt: null,
    reviewedBy: null,
    humanReviewedAt: null,
  };
  if (previous) {
    for (const [key, value] of Object.entries(previous)) {
      if (
        !(key in row) &&
        !['rule', 'automaticDecision', 'rowNote', 'evidenceContract'].includes(key)
      )
        Object.defineProperty(row, key, {
          value: structuredClone(value),
          enumerable: true,
          configurable: true,
          writable: true,
        });
    }
  }
  const identical =
    previous && identity(previous, input.previousRun) === identity(row, input.classificationRun);
  const priorLlmEvent = previous?.reviewState === 'llm_reviewed' ? previous.decisionAt : null;
  row.decisionAt =
    proposal.source === 'rule'
      ? input.now()
      : identical
        ? (priorLlmEvent ?? null)
        : previous
          ? input.now()
          : proposal.samples.every((sample) => sample.cacheHit)
            ? null
            : input.now();
  return row;
}
