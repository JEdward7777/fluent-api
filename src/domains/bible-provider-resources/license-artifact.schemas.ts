import { z } from 'zod';

import { resourceProviderEnum } from '@/db/schema';
import { ttsLicenseStatusSchema } from '@/domains/bibles/bibles.types';
import { jsonValueSchema, llmRequestSchema } from '@/lib/llm/request-cache';

import { licenseVoteSchema } from './license-model-contract';
import { LICENSE_NORMALIZER_VERSION } from './license-normalizer';

export const LICENSE_ARTIFACT_SCHEMA_VERSION = 1;
export const LICENSE_REVIEW_HASH_DOMAIN_VERSION = 1;
export const LICENSE_CLASSIFICATIONS_PATH =
  'docs/features/tts-license-ingestion/reference/license-classifications.json';
const text = z.string().refine((value) => value.trim().length > 0, 'Must not be blank');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const decision = z
  .object({
    status: ttsLicenseStatusSchema,
    rationale: text,
    source: z.enum(['table', 'rule', 'gemini']),
  })
  .strict();
const rule = z
  .object({
    id: text,
    priority: z.number().int(),
    decision: ttsLicenseStatusSchema,
    rationale: text,
    matchedExcerpt: text,
  })
  .strict();
const sample = z
  .object({
    index: z.number().int().min(1),
    provider: text,
    model: text,
    requestHash: digest,
    request: llmRequestSchema,
    response: z.string(),
    result: licenseVoteSchema,
    cacheHit: z.boolean().optional(),
    attempts: z.number().int().min(0).optional(),
  })
  .passthrough();

export const licenseClassificationSchema = z
  .object({
    normalizedText: z.string(),
    exampleNotice: z.string(),
    status: ttsLicenseStatusSchema,
    source: z.enum(['table', 'rule', 'gemini', 'manual']),
    rationale: text,
    rule: rule.optional(),
    samples: z.array(sample),
    automaticDecision: decision.optional(),
    rowNote: text.optional(),
  })
  .passthrough();

export const licenseArtifactSchema = z
  .object({
    schemaVersion: z.literal(LICENSE_ARTIFACT_SCHEMA_VERSION),
    hashDomainVersion: z.literal(LICENSE_REVIEW_HASH_DOMAIN_VERSION),
    normalizerVersion: z.literal(LICENSE_NORMALIZER_VERSION),
    classificationRun: z
      .object({
        prompt: text,
        promptHash: digest,
        ruleSetHash: digest,
        responseSchema: z.record(jsonValueSchema),
        models: z
          .array(
            z
              .object({
                provider: text,
                model: text,
                sampleCount: z.number().int().min(2),
                settings: z.record(jsonValueSchema),
              })
              .passthrough()
          )
          .min(1),
        createdAt: z.string().datetime().optional(),
        snapshotAt: z.string().datetime().optional(),
        acquiredAt: z.string().datetime().optional(),
      })
      .passthrough(),
    catalog: z.array(
      z
        .object({
          provider: z.enum(resourceProviderEnum.enumValues),
          externalId: text,
          bibleId: z.number().int().positive().nullable(),
          name: text,
          abbreviation: text,
          rawNotice: z.string().nullable(),
        })
        .passthrough()
    ),
    classifications: z.array(licenseClassificationSchema),
    reviewContentHash: digest,
    reviewState: z.literal('incomplete').optional(),
    attestation: z
      .object({
        reviewedBy: text,
        reviewReason: text,
        reviewedAt: z.string().datetime(),
        reviewContentHash: digest,
      })
      .strict()
      .optional(),
  })
  .passthrough();

export type LicenseArtifact = z.infer<typeof licenseArtifactSchema>;
export type LicenseClassification = z.infer<typeof licenseClassificationSchema>;

/** JSON-only validation and a deep clone also detach passthrough extension values. */
export function parseLicenseArtifact(value: unknown): LicenseArtifact {
  // Validate without taking Zod's reconstructed objects: Zod intentionally filters
  // __proto__ keys, but a JSON document may legitimately own that inert data key.
  // No schema coercions/defaults/transforms are permitted for owned artifact fields.
  jsonValueSchema.parse(value);
  licenseArtifactSchema.parse(value);
  return structuredClone(value) as LicenseArtifact;
}
