import { z } from 'zod';

import { resourceProviderEnum } from '@/db/schema';
import { ttsLicenseStatusSchema } from '@/domains/bibles/bibles.types';
import { jsonValueSchema, llmRequestSchema } from '@/lib/llm/request-cache';

import { computeLicenseReviewHash } from './license-artifact.hash';
import { licenseVoteSchema } from './license-model-contract';
import { LICENSE_NORMALIZER_VERSION } from './license-normalizer';

export const LICENSE_ARTIFACT_SCHEMA_VERSION = 4;
export const LICENSE_REVIEW_HASH_DOMAIN_VERSION = 4;
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

const evidenceContract = z
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
  })
  .passthrough();

const legacyClassificationSchema = z
  .object({
    normalizedText: z.string(),
    exampleNotice: z.string(),
    status: ttsLicenseStatusSchema,
    source: z.enum(['table', 'rule', 'gemini', 'manual']),
    rationale: text,
    rule: rule.optional(),
    samples: z.array(sample),
    evidenceContract: evidenceContract.optional(),
    automaticDecision: decision.optional(),
    rowNote: text.optional(),
  })
  .passthrough();

const v3ClassificationSchema = legacyClassificationSchema.extend({
  reviewState: z.enum(['unreviewed', 'llm_reviewed', 'human_reviewed']).optional(),
  decisionAt: z.string().datetime({ offset: true }).nullable().optional(),
  reviewedBy: text.nullable().optional(),
  humanReviewedAt: z.string().datetime({ offset: true }).nullable().optional(),
});

// Legacy note-only edits carry no author or event clock. Keep the note from
// the decision record separate from subsequent anonymous edits.
const rowNoteProvenance = z
  .object({
    originalRowNote: text.nullable(),
    priorAnonymousNotes: z.array(text),
    author: z.null(),
  })
  .strict();

const reviewSnapshot = z
  .object({
    status: ttsLicenseStatusSchema,
    source: legacyClassificationSchema.shape.source,
    rationale: z.string().nullable(),
    rowNote: text.nullable(),
    rowNoteProvenance: rowNoteProvenance.optional(),
    reviewComment: text.nullable(),
    reviewState: v3ClassificationSchema.shape.reviewState.unwrap(),
    decisionAt: z.string().datetime({ offset: true }).nullable(),
    reviewedBy: text.nullable(),
    humanReviewedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();

export const licenseClassificationSchema = v3ClassificationSchema.extend({
  rationale: z.union([text, z.literal('')]),
  reviewComment: text.optional(),
  rowNoteProvenance: rowNoteProvenance.optional(),
  reviewHistory: z.array(reviewSnapshot).optional(),
});

const artifactShape = {
  normalizerVersion: z.literal(LICENSE_NORMALIZER_VERSION),
  classificationRun: evidenceContract.extend({
    createdAt: z.string().datetime().optional(),
    snapshotAt: z.string().datetime().optional(),
    acquiredAt: z.string().datetime().optional(),
  }),
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
  historicalAttestation: z
    .object({
      schemaVersion: z.literal(2),
      hashDomainVersion: z.literal(2),
      reviewedBy: text,
      reviewReason: text,
      reviewedAt: z.string().datetime(),
      reviewContentHash: digest,
    })
    .strict()
    .optional(),
};

const { historicalAttestation, ...currentArtifactShape } = artifactShape;
const historicalAssertion = z.discriminatedUnion('schemaVersion', [
  historicalAttestation.unwrap(),
  historicalAttestation
    .unwrap()
    .extend({ schemaVersion: z.literal(3), hashDomainVersion: z.literal(3) }),
]);

export const licenseArtifactSchema = z
  .object({
    schemaVersion: z.literal(LICENSE_ARTIFACT_SCHEMA_VERSION),
    hashDomainVersion: z.literal(LICENSE_REVIEW_HASH_DOMAIN_VERSION),
    ...currentArtifactShape,
    historicalAttestations: z.array(historicalAssertion).optional(),
    classifications: z.array(licenseClassificationSchema),
  })
  .passthrough();

const legacyArtifactSchema = z
  .object({
    schemaVersion: z.literal(2),
    hashDomainVersion: z.literal(2),
    ...currentArtifactShape,
    classifications: z.array(legacyClassificationSchema),
  })
  .passthrough();

const v3ArtifactSchema = legacyArtifactSchema.extend({
  historicalAttestation,
  schemaVersion: z.literal(3),
  hashDomainVersion: z.literal(3),
  classifications: z.array(v3ClassificationSchema),
});

export type V3LicenseArtifact = z.infer<typeof v3ArtifactSchema>;
export type LicenseArtifact = z.infer<typeof licenseArtifactSchema>;
export type LicenseClassification = z.infer<typeof licenseClassificationSchema>;
export type LegacyLicenseArtifact = z.infer<typeof legacyArtifactSchema>;

/** Keep promoted extension names, including the envelope's own previous value. */
function preserveExtensions(value: Record<string, unknown>, version: 2 | 3, names: string[]) {
  const entries = [...names, 'migrationExtensions']
    .filter((key) => Object.hasOwn(value, key))
    .map((key) => [key, value[key]] as const);
  for (const [key] of entries) delete value[key];
  if (entries.length)
    value.migrationExtensions = { schemaVersion: version, fields: Object.fromEntries(entries) };
}

/** Validate the original domain before assigning any new ownership or binding. */
function migrateArtifact(value: unknown, version: 2 | 3): LicenseArtifact {
  (version === 2 ? legacyArtifactSchema : v3ArtifactSchema).parse(value);
  const old = structuredClone(value) as LegacyLicenseArtifact | V3LicenseArtifact;
  const hash = computeLicenseReviewHash(old);
  if (hash !== old.reviewContentHash)
    throw new Error(`Legacy v${version} review content hash mismatch`);
  if (old.attestation && old.attestation.reviewContentHash !== hash)
    throw new Error(`Legacy v${version} attestation is bound to another revision`);

  preserveExtensions(
    old,
    version,
    version === 2 ? ['historicalAttestations', 'historicalAttestation'] : ['historicalAttestations']
  );
  const assertions: z.infer<typeof historicalAssertion>[] =
    old.schemaVersion === 3 && old.historicalAttestation ? [old.historicalAttestation] : [];
  if (old.attestation)
    assertions.push(
      old.schemaVersion === 2
        ? { ...old.attestation, schemaVersion: 2, hashDomainVersion: 2 }
        : { ...old.attestation, schemaVersion: 3, hashDomainVersion: 3 }
    );
  delete old.attestation;
  delete old.historicalAttestation;
  const rows = old.classifications.map((row) => {
    const promoted = ['reviewComment', 'reviewHistory', 'rowNoteProvenance'];
    if (version === 2) promoted.push('reviewState', 'decisionAt', 'reviewedBy', 'humanReviewedAt');
    preserveExtensions(row, version, promoted);
    if (version === 2)
      Object.assign(row, {
        reviewState:
          row.source === 'gemini' || row.automaticDecision?.source === 'gemini'
            ? 'llm_reviewed'
            : 'unreviewed',
        decisionAt: null,
        reviewedBy: null,
        humanReviewedAt: null,
      });
    return row;
  });
  const artifact: LicenseArtifact = {
    ...old,
    schemaVersion: LICENSE_ARTIFACT_SCHEMA_VERSION,
    hashDomainVersion: LICENSE_REVIEW_HASH_DOMAIN_VERSION,
    classifications: rows,
    reviewState: 'incomplete',
    ...(assertions.length ? { historicalAttestations: assertions } : {}),
  };
  licenseArtifactSchema.parse(artifact);
  artifact.reviewContentHash = computeLicenseReviewHash(artifact);
  return artifact;
}

export function parseLicenseArtifact(value: unknown): LicenseArtifact {
  // Validate without reconstructing: Zod filters inert JSON keys such as __proto__.
  jsonValueSchema.parse(value);
  if (
    typeof value === 'object' &&
    value !== null &&
    'schemaVersion' in value &&
    (value.schemaVersion === 2 || value.schemaVersion === 3)
  )
    return migrateArtifact(value, value.schemaVersion);
  licenseArtifactSchema.parse(value);
  return structuredClone(value) as LicenseArtifact;
}
