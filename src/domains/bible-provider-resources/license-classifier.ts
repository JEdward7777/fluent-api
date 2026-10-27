import type { TtsLicenseStatus } from '@/domains/bibles/bibles.types';
import type { LlmTransport } from '@/lib/llm/structured-request';

import { createGoogleTransport } from '@/lib/llm/google-transport';
import { createRequestCache } from '@/lib/llm/request-cache';
import { requestStructuredResponse } from '@/lib/llm/structured-request';

import {
  buildLicenseSampleRequest,
  LICENSE_CLASSIFICATION_PROMPT,
  LICENSE_CLASSIFICATION_PROMPT_HASH,
  LICENSE_INFERENCE_SETTINGS,
  LICENSE_VOTE_JSON_SCHEMA,
  parseLicenseVote,
} from './license-model-contract';
import { LICENSE_NORMALIZER_VERSION, normalizeLicenseNotice } from './license-normalizer';
import { LICENSE_RULE_SET_HASH, matchLicenseRule } from './license-rules';

interface ClassifierOptions {
  apiKey: string;
  model?: string;
  sampleCount?: number;
  cacheDir?: string;
  noCache?: boolean;
  transport?: LlmTransport;
  sleep?: (milliseconds: number) => Promise<unknown>;
  random?: () => number;
}
interface AuthoritativeClassification {
  status: TtsLicenseStatus;
  rationale: string;
}

/** No persistence or review side effects: exact authoritative rows, then rules, then complete samples. */
export function createLicenseClassifier(options: ClassifierOptions) {
  const modelReference = options.model ?? 'google:gemini-3.8-flash';
  const match = /^google:([^\s:]+)$/.exec(modelReference);
  if (!match)
    throw new Error(`Unsupported model reference: ${modelReference}. Use google:<model-id>`);
  if (!options.apiKey.trim()) throw new Error('A nonempty GEMINI_API_KEY is required');
  const sampleCount = options.sampleCount ?? 3;
  if (!Number.isInteger(sampleCount) || sampleCount < 2)
    throw new Error('Sample count must be an integer of at least two');
  const model = match[1];
  const transport = options.transport ?? createGoogleTransport(options.apiKey);
  const cache = createRequestCache(options.cacheDir);
  return async (
    notice: string,
    authoritative: ReadonlyMap<string, AuthoritativeClassification> = new Map()
  ) => {
    const normalizedText = normalizeLicenseNotice(notice);
    const base = {
      normalizedText,
      provider: 'google' as const,
      model,
      sampleCount,
      normalizerVersion: LICENSE_NORMALIZER_VERSION,
      ruleSetHash: LICENSE_RULE_SET_HASH,
      prompt: LICENSE_CLASSIFICATION_PROMPT,
      promptHash: LICENSE_CLASSIFICATION_PROMPT_HASH,
      responseSchema: LICENSE_VOTE_JSON_SCHEMA,
      settings: LICENSE_INFERENCE_SETTINGS,
    };
    const known = authoritative.get(normalizedText);
    if (known)
      return {
        ...base,
        source: 'table' as const,
        decision: known.status,
        rationale: known.rationale,
        samples: [],
      };
    const rule = matchLicenseRule(notice);
    if (rule)
      return {
        ...base,
        source: 'rule' as const,
        decision: rule.decision,
        rationale: rule.rationale,
        rule,
        samples: [],
      };
    const settled = await Promise.allSettled(
      Array.from({ length: sampleCount }, async (_, offset) => {
        const index = offset + 1;
        const request = buildLicenseSampleRequest(notice, 'google', model, index);
        return {
          index,
          ...(await requestStructuredResponse({
            request,
            transport,
            cache,
            parse: parseLicenseVote,
            noCache: options.noCache,
            sleep: options.sleep,
            random: options.random,
          })),
        };
      })
    );
    const samples = settled.map((sample) => {
      if (sample.status === 'rejected') throw sample.reason;
      return sample.value;
    });
    const first = samples[0].result.decision;
    const decision =
      first !== 'unknown' && samples.every((sample) => sample.result.decision === first)
        ? first
        : 'unknown';
    return {
      ...base,
      source: 'gemini' as const,
      decision,
      rationale:
        'Only unanimous allowed or unanimous forbidden samples determine a non-unknown classification.',
      samples,
    };
  };
}
