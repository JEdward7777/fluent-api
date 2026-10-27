import { createHash } from 'node:crypto';

import type { LicenseArtifact } from './license-artifact.schemas';

import { computeLicenseReviewHash } from './license-artifact.hash';
import {
  LICENSE_ARTIFACT_SCHEMA_VERSION,
  LICENSE_REVIEW_HASH_DOMAIN_VERSION,
  licenseArtifactSchema,
  parseLicenseArtifact,
} from './license-artifact.schemas';
import { validateLicenseArtifactContent } from './license-artifact.validation';
import { LICENSE_NORMALIZER_VERSION } from './license-normalizer';

type ArtifactInput = Pick<LicenseArtifact, 'classificationRun' | 'catalog' | 'classifications'> &
  Record<string, unknown>;

function reviewableContent(value: unknown) {
  const checked = checkLicenseArtifactReview(value);
  if (checked.status === 'invalid') throw new Error(checked.reason);
  return checked.artifact;
}

/** Automated candidates never manufacture a reviewer's identity or acceptance. */
export function createLicenseArtifact(input: ArtifactInput): LicenseArtifact {
  const value: Record<string, unknown> = {
    ...structuredClone(input),
    schemaVersion: LICENSE_ARTIFACT_SCHEMA_VERSION,
    hashDomainVersion: LICENSE_REVIEW_HASH_DOMAIN_VERSION,
    normalizerVersion: LICENSE_NORMALIZER_VERSION,
    reviewState: 'incomplete',
    reviewContentHash: '0'.repeat(64),
  };
  delete value.attestation;
  const artifact = parseLicenseArtifact(value);
  validateLicenseArtifactContent(artifact);
  artifact.reviewContentHash = computeLicenseReviewHash(artifact);
  return artifact;
}

/** Import gate: invalid evidence fails; coherent edited content is repaired only as unreviewed. */
export function checkLicenseArtifactReview(value: unknown) {
  let artifact: LicenseArtifact;
  let recomputed: string;
  try {
    artifact = parseLicenseArtifact(value);
    validateLicenseArtifactContent(artifact);
    recomputed = computeLicenseReviewHash(artifact);
  } catch (error) {
    return {
      status: 'invalid' as const,
      reason: error instanceof Error ? error.message : 'Invalid license artifact',
    };
  }
  const reasons: string[] = [];
  if (recomputed !== artifact.reviewContentHash) {
    artifact.reviewContentHash = recomputed;
    delete artifact.attestation;
    artifact.reviewState = 'incomplete';
    reasons.push('Owned content changed; the revised content requires explicit human attestation');
  }
  if (!artifact.attestation) reasons.push('A named reviewer must attest this exact revision');
  else if (artifact.attestation.reviewContentHash !== artifact.reviewContentHash)
    reasons.push('The attestation is bound to another revision');
  if (artifact.reviewState === 'incomplete') reasons.push('The revision is marked incomplete');
  if (artifact.classifications.some((row) => row.status === 'unknown' && !row.rowNote))
    reasons.push('Every retained unknown classification requires a human row note');
  if (reasons.length) {
    delete artifact.attestation;
    artifact.reviewState = 'incomplete';
  }
  return reasons.length
    ? { status: 'review-required' as const, reasons, artifact }
    : { status: 'ready' as const, artifact };
}

/** Own-content edits revoke review; extension/diagnostic-only edits retain its exact binding. */
export function reviseLicenseArtifact(
  value: unknown,
  edit: (draft: LicenseArtifact) => void
): LicenseArtifact {
  const before = reviewableContent(value);
  const draft = structuredClone(before);
  edit(draft);
  for (const row of draft.classifications) {
    const previous = before.classifications.find(
      (candidate) => candidate.normalizedText === row.normalizedText
    );
    const changedDecision =
      previous &&
      (previous.status !== row.status ||
        previous.source !== row.source ||
        previous.rationale !== row.rationale);
    if (changedDecision && row.source !== 'manual') {
      // A refresh cannot inherit a prior human note or unrelated automatic evidence.
      if (row.rowNote === previous.rowNote) delete row.rowNote;
      if (row.source === 'table') {
        row.samples = [];
        delete row.rule;
        delete row.automaticDecision;
      }
    }
  }
  const artifact = parseLicenseArtifact(draft);
  validateLicenseArtifactContent(artifact);
  artifact.reviewContentHash = computeLicenseReviewHash(artifact);
  if (artifact.reviewContentHash !== before.reviewContentHash) {
    delete artifact.attestation;
    artifact.reviewState = 'incomplete';
  }
  return artifact;
}

export function attestLicenseArtifact(
  value: unknown,
  metadata: Omit<NonNullable<LicenseArtifact['attestation']>, 'reviewContentHash'>
): LicenseArtifact {
  const artifact = reviewableContent(value);
  if (artifact.classifications.some((row) => row.status === 'unknown' && !row.rowNote))
    throw new Error('Every retained unknown classification requires a human row note');
  artifact.attestation = licenseArtifactSchema.shape.attestation
    .unwrap()
    .parse({ ...metadata, reviewContentHash: artifact.reviewContentHash });
  delete artifact.reviewState;
  return artifact;
}

/** The caller displays the warning during review; the reason and original proposal remain owned evidence. */
export function overrideLicenseClassification(
  value: unknown,
  normalizedText: string,
  status: LicenseArtifact['classifications'][number]['status'],
  reason: string
) {
  if (!reason.trim()) throw new Error('A human override requires a nonempty rationale');
  let warning: string | null = null;
  const artifact = reviseLicenseArtifact(value, (draft) => {
    const row = draft.classifications.find(
      (candidate) => candidate.normalizedText === normalizedText
    );
    if (!row) throw new Error('No exact normalized classification exists');
    if (row.source !== 'manual')
      row.automaticDecision = { source: row.source, status: row.status, rationale: row.rationale };
    if (row.rule?.id === 'all-rights-reserved' && status !== row.automaticDecision?.status)
      warning =
        'Overriding an automatic all-rights-reserved decision requires explicit human responsibility.';
    row.status = status;
    row.source = 'manual';
    row.rationale = reason;
    delete row.rowNote;
    if (status === 'unknown') row.rowNote = reason;
  });
  return { artifact, warning };
}

/** Whole-file SHA-256 is computed over final bytes and returned separately, never embedded. */
export function serializeLicenseArtifact(value: unknown) {
  const artifact = reviewableContent(value);
  const bytes = `${JSON.stringify(artifact, null, 2)}\n`;
  return { bytes, wholeFileHash: createHash('sha256').update(bytes).digest('hex') };
}
