import { createHash } from 'node:crypto';

import type { LicenseArtifact, LicenseClassification } from './license-artifact.schemas';

import { computeLicenseReviewHash } from './license-artifact.hash';
import { preserveReplacedReview } from './license-artifact.history';
import {
  LICENSE_ARTIFACT_SCHEMA_VERSION,
  LICENSE_REVIEW_HASH_DOMAIN_VERSION,
  licenseArtifactSchema,
  parseLicenseArtifact,
} from './license-artifact.schemas';
import { validateLicenseArtifactContent } from './license-artifact.validation';
import { LICENSE_NORMALIZER_VERSION } from './license-normalizer';

type ArtifactInput = Pick<LicenseArtifact, 'classificationRun' | 'catalog'> & {
  classifications: Array<
    Omit<LicenseClassification, 'reviewState' | 'decisionAt' | 'reviewedBy' | 'humanReviewedAt'> &
      Partial<
        Pick<LicenseClassification, 'reviewState' | 'decisionAt' | 'reviewedBy' | 'humanReviewedAt'>
      >
  >;
} & Record<string, unknown>;

function reviewableContent(value: unknown) {
  const checked = checkLicenseArtifactReview(value);
  if (checked.status === 'invalid') throw new Error(checked.reason);
  return checked.artifact;
}

/** Automated candidates never manufacture a reviewer's identity or acceptance. */
export function createLicenseArtifact(input: ArtifactInput): LicenseArtifact {
  const value: Record<string, unknown> = {
    ...structuredClone(input),
    classifications: input.classifications.map((row) => ({
      ...structuredClone(row),
      reviewState: row.reviewState ?? (row.source === 'gemini' ? 'llm_reviewed' : 'unreviewed'),
      decisionAt: row.decisionAt ?? null,
      reviewedBy: row.reviewedBy ?? null,
      humanReviewedAt: row.humanReviewedAt ?? null,
    })),
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
      preserveReplacedReview(previous, row);
      delete row.reviewComment;
      delete row.rowNoteProvenance;
      if (row.rowNote === previous.rowNote) delete row.rowNote;
      if (row.source === 'table') {
        row.samples = [];
        delete row.rule;
        delete row.automaticDecision;
        row.reviewState = 'unreviewed';
        row.decisionAt = null;
        row.reviewedBy = null;
        row.humanReviewedAt = null;
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
  artifact.attestation = licenseArtifactSchema.shape.attestation
    .unwrap()
    .parse({ ...metadata, reviewContentHash: artifact.reviewContentHash });
  delete artifact.reviewState;
  return artifact;
}

export function licenseOverrideWarning(
  row: LicenseClassification,
  status: LicenseClassification['status']
): string | null {
  return row.rule?.id === 'all-rights-reserved' &&
    status !== (row.automaticDecision?.status ?? row.status)
    ? 'Overriding an automatic all-rights-reserved decision requires explicit human responsibility.'
    : null;
}

/** The caller displays the warning during review; the reason and original proposal remain owned evidence. */
export function overrideLicenseClassification(
  value: unknown,
  normalizedText: string,
  status: LicenseArtifact['classifications'][number]['status'],
  reason: string,
  unknownNote?: string
) {
  if (!reason.trim()) throw new Error('A human override requires a nonempty rationale');
  if (unknownNote !== undefined && (!unknownNote.trim() || status !== 'unknown'))
    throw new Error('An explicit human row note must be nonempty and requires unknown status');
  let warning: string | null = null;
  const artifact = reviseLicenseArtifact(value, (draft) => {
    const row = draft.classifications.find(
      (candidate) => candidate.normalizedText === normalizedText
    );
    if (!row) throw new Error('No exact normalized classification exists');
    preserveReplacedReview(row, row);
    delete row.reviewComment;
    if (row.source !== 'manual')
      row.automaticDecision = { source: row.source, status: row.status, rationale: row.rationale };
    if (row.reviewState === 'human_reviewed') {
      row.reviewState = row.automaticDecision?.source === 'gemini' ? 'llm_reviewed' : 'unreviewed';
      row.decisionAt = null;
      row.reviewedBy = null;
      row.humanReviewedAt = null;
    }
    warning = licenseOverrideWarning(row, status);
    row.status = status;
    row.source = 'manual';
    row.rationale = reason;
    delete row.rowNote;
    delete row.rowNoteProvenance;
    if (status === 'unknown') row.rowNote = unknownNote ?? reason;
  });
  return { artifact, warning };
}

/** A named human decision is a separate event, including same-status confirmation. */
export function recordHumanLicenseDecision(
  value: unknown,
  normalizedText: string,
  status: LicenseClassification['status'],
  review: string | { reviewComment?: string },
  reviewedBy: string,
  decisionAt: string
): LicenseArtifact {
  if (!reviewedBy.trim()) throw new Error('Human review requires a named reviewer');
  if (typeof review === 'string' && !review.trim())
    throw new Error('A human override requires a nonempty rationale');
  return reviseLicenseArtifact(value, (draft) => {
    const row = draft.classifications.find(
      (candidate) => candidate.normalizedText === normalizedText
    );
    if (!row) throw new Error('No exact normalized classification exists');
    preserveReplacedReview(row, row);
    delete row.reviewComment;
    if (row.source !== 'manual')
      row.automaticDecision = { source: row.source, status: row.status, rationale: row.rationale };
    delete row.rowNote;
    delete row.rowNoteProvenance;
    row.status = status;
    row.source = 'manual';
    // String input is the legacy disposition contract. New reviews keep their
    // optional authored text separate from the original proposal's rationale.
    row.rationale = typeof review === 'string' ? review : '';
    if (typeof review !== 'string' && review.reviewComment?.trim())
      row.reviewComment = review.reviewComment;
    row.reviewState = 'human_reviewed';
    row.decisionAt = decisionAt;
    row.reviewedBy = reviewedBy;
    row.humanReviewedAt = decisionAt;
  });
}

/** Legacy note-only edits do not change the decision's reviewer or clock. */
export function recordAnonymousLicenseNote(value: unknown, normalizedText: string, note: string) {
  if (!note.trim()) throw new Error('A human note must be nonempty');
  return reviseLicenseArtifact(value, (draft) => {
    const row = draft.classifications.find(
      (candidate) => candidate.normalizedText === normalizedText
    );
    if (!row) throw new Error('No exact normalized classification exists');
    if (row.status !== 'unknown')
      throw new Error('Human row notes are for retained unknown classifications');
    if (row.rowNote === note) return;
    if (row.rowNoteProvenance && row.rowNote)
      row.rowNoteProvenance.priorAnonymousNotes.push(row.rowNote);
    else
      row.rowNoteProvenance = {
        originalRowNote: row.rowNote ?? null,
        priorAnonymousNotes: [],
        author: null,
      };
    row.rowNote = note;
  });
}

/** Whole-file SHA-256 is computed over final bytes and returned separately, never embedded. */
export function serializeLicenseArtifact(value: unknown) {
  const artifact = reviewableContent(value);
  const bytes = `${JSON.stringify(artifact, null, 2)}\n`;
  return { bytes, wholeFileHash: createHash('sha256').update(bytes).digest('hex') };
}
