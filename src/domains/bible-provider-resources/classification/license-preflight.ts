import { createHash } from 'node:crypto';

import { createRequestCache } from '@/lib/llm/request-cache';

import type { LicenseClassification } from '../license-artifact.schemas';
import type { LicenseDatabaseSnapshot } from './license-database.types';
import type { LicenseEligibilityRow } from './license-eligibility';

import { buildLicenseSampleRequest, parseLicenseVote } from '../license-model-contract';
import { indexLicenseNoticeExamples } from '../license-normalizer';
import { planLicenseEligibility } from './license-eligibility';
import { storedLicenseDecision } from './license-stored-decision';

export interface LicensePreflightSample {
  normalizedText: string;
  index: number;
  validCacheHit: boolean;
  expectedRequests: number;
  maximumAttempts: number;
  cachedResponseHash: string | null;
}

export interface LicensePreflight {
  source: 'json' | 'database';
  distinctKeys: number;
  historicalClassificationKeys: number;
  tableHits: number;
  ruleHits: number;
  modelKeys: number;
  validCacheHits: number;
  expectedUncachedRequests: number;
  maximumAttempts: number;
  cacheReadEnabled: boolean;
  cost: { status: 'unavailable'; reason: string };
  samples: LicensePreflightSample[];
  rows: LicenseEligibilityRow[];
}

/** Mirrors analysis precedence and the structured-request cache validation without transport calls. */
export async function inspectLicensePreflight(input: {
  database?: LicenseDatabaseSnapshot;
  priorNotices?: (string | null)[];
  jsonClassifications?: LicenseClassification[];
  jsonNotices?: string[];
  rerunRule?: string[];
  rerunModel?: string[];
  model: string;
  sampleCount: number;
  cacheDir?: string;
  noCache: boolean;
}): Promise<LicensePreflight> {
  const samples: LicensePreflightSample[] = [];
  let tableHits = 0;
  let ruleHits = 0;
  let modelKeys = 0;
  const cache = input.noCache ? undefined : createRequestCache(input.cacheDir);
  const notices = input.database
    ? input.database.context.resources.flatMap((row) =>
        row.rawNotice?.trim() ? [row.rawNotice] : []
      )
    : (input.jsonNotices ?? []);
  const examples = indexLicenseNoticeExamples([...notices, ...(input.priorNotices ?? [])]);
  const stored = new Map<string, LicenseClassification>();
  for (const row of input.database?.classifications ?? []) {
    const decision = storedLicenseDecision(row, examples.get(row.normalizedText));
    // Older adapter snapshots omitted review_state. Such rows never opted into
    // automatic reassessment of explicitly unreviewed unknowns.
    if (row.reviewState === undefined && !row.evidence) delete decision.reviewState;
    stored.set(row.normalizedText, decision);
  }
  for (const row of input.jsonClassifications ?? []) stored.set(row.normalizedText, row);
  const rows = planLicenseEligibility({
    notices,
    stored,
    ruleDigests: input.rerunRule ?? [],
    modelDigests: input.rerunModel ?? [],
    source: input.database ? 'database' : 'json',
  });
  for (const row of rows) {
    if (row.action === 'retain') {
      tableHits++;
      continue;
    }
    if (row.action === 'rule' && row.ruleMatches) {
      ruleHits++;
      continue;
    }
    if (row.action === 'model') {
      if (row.exampleNotice === null)
        throw new Error('An original notice is required for reassessment');
      modelKeys++;
      for (let index = 1; index <= input.sampleCount; index++) {
        const request = buildLicenseSampleRequest(
          row.exampleNotice,
          'google',
          input.model.replace(/^google:/, ''),
          index
        );
        const response = (await cache?.read(request)) ?? null;
        let validCacheHit = false;
        if (response !== null) {
          try {
            parseLicenseVote(response);
            validCacheHit = true;
          } catch {
            // The inference path treats a malformed cached vote as a miss.
          }
        }
        samples.push({
          normalizedText: row.normalizedText,
          index,
          validCacheHit,
          expectedRequests: validCacheHit ? 0 : 1,
          maximumAttempts: validCacheHit ? 0 : 5,
          cachedResponseHash:
            validCacheHit && response !== null
              ? createHash('sha256').update(response).digest('hex')
              : null,
        });
      }
    }
  }
  const validCacheHits = samples.filter((sample) => sample.validCacheHit).length;
  const expectedUncachedRequests = samples.length - validCacheHits;
  return {
    source: input.database ? 'database' : 'json',
    distinctKeys: rows.length,
    historicalClassificationKeys: input.database ? 0 : stored.size,
    tableHits,
    ruleHits,
    modelKeys,
    validCacheHits,
    expectedUncachedRequests,
    maximumAttempts: expectedUncachedRequests * 5,
    cacheReadEnabled: !input.noCache,
    cost: {
      status: 'unavailable',
      reason:
        'No locally verified model pricing or output and thinking token estimate is available.',
    },
    samples,
    rows,
  };
}
