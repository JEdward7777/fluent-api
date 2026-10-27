import { hashCanonicalJson } from '@/lib/llm/canonical-json';
import { llmRequestHash } from '@/lib/llm/request-cache';

import type { LicenseArtifact, LicenseClassification } from './license-artifact.schemas';

import { createLicenseArtifact } from './license-artifact';
import {
  buildLicenseSampleRequest,
  LICENSE_CLASSIFICATION_PROMPT,
  LICENSE_INFERENCE_SETTINGS,
  LICENSE_VOTE_JSON_SCHEMA,
  parseLicenseVote,
} from './license-model-contract';
import { normalizeLicenseNotice } from './license-normalizer';
import { LICENSE_RULE_SET_HASH, matchLicenseRule } from './license-rules';

export const REVIEWER = {
  reviewedBy: 'Named team reviewer',
  reviewReason: 'Spot-checked the exact candidate and retained unknown notes.',
  reviewedAt: '2026-10-27T00:00:00.000Z',
};

export function makeLicenseArtifact(): LicenseArtifact {
  const models = ['recorded-model-a', 'recorded-model-b'].map((model) => ({
    provider: 'google',
    model,
    sampleCount: 3,
    settings: structuredClone(LICENSE_INFERENCE_SETTINGS),
  }));
  const exampleNotice = 'Publisher-specific terms require interpretation.';
  const samples = models.flatMap((model) =>
    [1, 2, 3].map((index) => {
      const request = buildLicenseSampleRequest(exampleNotice, model.provider, model.model, index);
      const response = JSON.stringify({
        rationale: 'The stated use is permitted.',
        decision: 'allowed',
      });
      return {
        index,
        provider: model.provider,
        model: model.model,
        request,
        requestHash: llmRequestHash(request),
        response,
        result: parseLicenseVote(response),
        cacheHit: false,
        attempts: 1,
      };
    })
  );
  const reserved = 'Copyright © 2026 All rights reserved. CC BY.';
  const rule = matchLicenseRule(reserved)!;
  const known = 'Terms available on request.';
  const classifications: LicenseClassification[] = [
    {
      normalizedText: normalizeLicenseNotice(reserved),
      exampleNotice: reserved,
      status: rule.decision,
      rationale: rule.rationale,
      source: 'rule',
      rule,
      samples: [],
    },
    {
      normalizedText: normalizeLicenseNotice(exampleNotice),
      exampleNotice,
      status: 'allowed',
      rationale: 'The complete sample set is unanimous.',
      source: 'gemini',
      samples,
    },
    {
      normalizedText: normalizeLicenseNotice(known),
      exampleNotice: known,
      status: 'unknown',
      rationale: 'An authoritative retained unknown decision.',
      source: 'table',
      samples: [],
      rowNote: 'The reviewer retained this unresolved case.',
    },
  ];
  return createLicenseArtifact({
    classificationRun: {
      prompt: LICENSE_CLASSIFICATION_PROMPT,
      promptHash: hashCanonicalJson(LICENSE_CLASSIFICATION_PROMPT),
      ruleSetHash: LICENSE_RULE_SET_HASH,
      responseSchema: structuredClone(LICENSE_VOTE_JSON_SCHEMA),
      models,
      createdAt: '2026-10-27T00:00:00.000Z',
    },
    catalog: classifications.map((row, index) => ({
      provider: 'dbl' as const,
      externalId: `text-${index + 1}`,
      bibleId: index + 1,
      name: `Bible ${index + 1}`,
      abbreviation: `B${index + 1}`,
      rawNotice: row.exampleNotice,
    })),
    classifications,
  });
}
