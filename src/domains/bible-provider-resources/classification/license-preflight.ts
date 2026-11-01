import { createHash } from 'node:crypto';

import { createRequestCache } from '@/lib/llm/request-cache';

import type { LicenseDatabaseSnapshot } from './license-database.types';

import { buildLicenseSampleRequest, parseLicenseVote } from '../license-model-contract';
import { normalizeLicenseNotice } from '../license-normalizer';
import { matchLicenseRule } from '../license-rules';

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
}

/** Mirrors analysis precedence and the structured-request cache validation without transport calls. */
export async function inspectLicensePreflight(input: {
  database?: LicenseDatabaseSnapshot;
  jsonClassificationKeys?: string[];
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
  const examples = new Map<string, string>();
  if (input.database) {
    for (const row of input.database.context.resources) {
      if (!row.rawNotice?.trim()) continue;
      const key = normalizeLicenseNotice(row.rawNotice);
      if (!examples.has(key)) examples.set(key, row.rawNotice);
    }
    for (const row of input.database.classifications)
      if (!examples.has(row.normalizedText)) examples.set(row.normalizedText, row.normalizedText);
    const known = new Set(input.database.classifications.map((row) => row.normalizedText));
    for (const [key, notice] of [...examples].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (known.has(key)) {
        tableHits++;
        continue;
      }
      if (matchLicenseRule(notice)) {
        ruleHits++;
        continue;
      }
      modelKeys++;
      for (let index = 1; index <= input.sampleCount; index++) {
        const request = buildLicenseSampleRequest(
          notice,
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
          normalizedText: key,
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
  } else {
    for (const key of input.jsonClassificationKeys ?? []) examples.set(key, key);
  }
  const validCacheHits = samples.filter((sample) => sample.validCacheHit).length;
  const expectedUncachedRequests = samples.length - validCacheHits;
  return {
    source: input.database ? 'database' : 'json',
    distinctKeys: examples.size,
    historicalClassificationKeys: input.database ? 0 : examples.size,
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
  };
}
