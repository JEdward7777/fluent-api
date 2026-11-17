import { hashCanonicalJson } from '@/lib/llm/canonical-json';

import type {
  LegacyLicenseArtifact,
  LicenseArtifact,
  LicenseClassification,
} from './license-artifact.schemas';

// Explicit, locale-independent ordering. Every sort operates on newly mapped arrays.
const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

function ownedContract(run: LicenseArtifact['classificationRun']) {
  return {
    prompt: run.prompt,
    promptHash: run.promptHash,
    ruleSetHash: run.ruleSetHash,
    responseSchema: run.responseSchema,
    models: run.models
      .map((model) => ({
        provider: model.provider,
        model: model.model,
        sampleCount: model.sampleCount,
        settings: model.settings,
      }))
      .sort(
        (left, right) => compare(left.provider, right.provider) || compare(left.model, right.model)
      ),
  };
}

/** This projection is shared by artifact hashing and cross-storage conflict checks. */
export function ownedLicenseClassification(row: LicenseClassification, includeDecisionAt = true) {
  return {
    normalizedText: row.normalizedText,
    exampleNotice: row.exampleNotice,
    status: row.status,
    source: row.source,
    rationale: row.rationale,
    reviewState: row.reviewState ?? null,
    decisionAt: includeDecisionAt ? (row.decisionAt ?? null) : null,
    reviewedBy: row.reviewedBy ?? null,
    humanReviewedAt: row.humanReviewedAt ?? null,
    rowNote: row.rowNote ?? null,
    evidenceContract: row.evidenceContract ? ownedContract(row.evidenceContract) : null,
    automaticDecision: row.automaticDecision
      ? {
          source: row.automaticDecision.source,
          status: row.automaticDecision.status,
          rationale: row.automaticDecision.rationale,
        }
      : null,
    rule: row.rule
      ? {
          id: row.rule.id,
          priority: row.rule.priority,
          decision: row.rule.decision,
          rationale: row.rule.rationale,
          matchedExcerpt: row.rule.matchedExcerpt,
        }
      : null,
    samples: row.samples
      .map((sample) => ({
        index: sample.index,
        provider: sample.provider,
        model: sample.model,
        requestHash: sample.requestHash,
        request: {
          provider: sample.request.provider,
          model: sample.request.model,
          messages: sample.request.messages,
          responseSchema: sample.request.responseSchema,
          settings: sample.request.settings,
        },
        response: sample.response,
        result: { rationale: sample.result.rationale, decision: sample.result.decision },
      }))
      .sort(
        (left, right) =>
          compare(left.provider, right.provider) ||
          compare(left.model, right.model) ||
          left.index - right.index
      ),
  };
}

/**
 * Hash-domain version 3: row review facts are owned alongside decision evidence.
 * Attestation, review markers/hash, acquisition/file times, cache diagnostics and every
 * passthrough extension are excluded. Promoting an extension requires a domain-version change.
 */
function hashOwnedArtifact(
  artifact: LicenseArtifact | LegacyLicenseArtifact,
  legacy: boolean
): string {
  return hashCanonicalJson({
    schemaVersion: artifact.schemaVersion,
    hashDomainVersion: artifact.hashDomainVersion,
    normalizerVersion: artifact.normalizerVersion,
    classificationRun: ownedContract(artifact.classificationRun),
    catalog: artifact.catalog
      .map((bible) => ({
        provider: bible.provider,
        externalId: bible.externalId,
        bibleId: bible.bibleId,
        name: bible.name,
        abbreviation: bible.abbreviation,
        rawNotice: bible.rawNotice,
      }))
      .sort(
        (left, right) =>
          compare(left.provider, right.provider) || compare(left.externalId, right.externalId)
      ),
    classifications: artifact.classifications
      .map((row) => {
        const owned = ownedLicenseClassification(row);
        if (!legacy) return owned;
        const {
          reviewState: _reviewState,
          decisionAt: _decisionAt,
          reviewedBy: _reviewedBy,
          humanReviewedAt: _humanReviewedAt,
          ...v2
        } = owned;
        return v2;
      })
      .sort((left, right) => compare(left.normalizedText, right.normalizedText)),
  });
}

/** Exact v2 owned projection; verify it before any version or attestation conversion. */
export function computeLegacyLicenseReviewHash(artifact: LegacyLicenseArtifact): string {
  return hashOwnedArtifact(artifact, true);
}

export function computeLicenseReviewHash(artifact: LicenseArtifact): string {
  return hashOwnedArtifact(artifact, false);
}
