import type { LicenseClassification } from './license-artifact.schemas';

/** Capture only evidence that exists. Legacy manual decisions and notes can be anonymous. */
export function preserveReplacedReview(
  previous: LicenseClassification,
  next: LicenseClassification
) {
  const history = structuredClone(previous.reviewHistory ?? []);
  if (
    previous.source === 'manual' ||
    previous.rowNote !== undefined ||
    previous.reviewState === 'human_reviewed' ||
    previous.reviewComment !== undefined
  ) {
    history.push({
      status: previous.status,
      source: previous.source,
      rationale: previous.rationale || null,
      rowNote: previous.rowNote ?? null,
      ...(previous.rowNoteProvenance
        ? { rowNoteProvenance: structuredClone(previous.rowNoteProvenance) }
        : {}),
      reviewComment: previous.reviewComment ?? null,
      reviewState: previous.reviewState ?? 'unreviewed',
      decisionAt: previous.decisionAt ?? null,
      reviewedBy: previous.reviewedBy ?? null,
      humanReviewedAt: previous.humanReviewedAt ?? null,
    });
  }
  if (history.length) next.reviewHistory = history;
}
