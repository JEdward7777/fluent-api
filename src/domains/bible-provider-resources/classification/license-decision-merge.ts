import { hashCanonicalJson } from '@/lib/llm/canonical-json';

import type { LicenseClassification } from '../license-artifact.schemas';

import { ownedLicenseClassification } from '../license-artifact.hash';

type DecisionMergeReason = 'insert' | 'update' | 'preserve' | 'no-op' | 'conflict';
interface DecisionMergeResult {
  reason: DecisionMergeReason;
  winner: LicenseClassification | null;
}
interface PlannedLicenseDecision extends DecisionMergeResult {
  normalizedText: string;
  source: LicenseClassification | null;
  destination: LicenseClassification | null;
}

const rank = { unreviewed: 0, llm_reviewed: 1, human_reviewed: 2 } as const;

function eventInstant(value: string | null | undefined) {
  return value == null ? null : Date.parse(value);
}

export function ownedDecision(row: LicenseClassification, includeDecisionAt = true): string {
  return hashCanonicalJson({
    ...ownedLicenseClassification(row, includeDecisionAt),
    decisionAt: includeDecisionAt ? eventInstant(row.decisionAt) : null,
    humanReviewedAt: eventInstant(row.humanReviewedAt),
  });
}

/** Selects an entire owned decision; null dates are unknown, never migration time. */
export function compareLicenseDecisions(
  source: LicenseClassification,
  destination: LicenseClassification | null
): DecisionMergeResult {
  if (!destination) return { reason: 'insert', winner: source };
  if (source.normalizedText !== destination.normalizedText)
    throw new Error('Cannot compare different normalized classification keys');
  const sourceRank = rank[source.reviewState ?? 'unreviewed'];
  const destinationRank = rank[destination.reviewState ?? 'unreviewed'];
  if (sourceRank !== destinationRank)
    return sourceRank > destinationRank
      ? { reason: 'update', winner: source }
      : { reason: 'preserve', winner: destination };
  const sourceAt = eventInstant(source.decisionAt);
  const destinationAt = eventInstant(destination.decisionAt);
  if (sourceAt !== destinationAt) {
    if (sourceAt === null || destinationAt === null) {
      if (ownedDecision(source, false) !== ownedDecision(destination, false))
        return { reason: 'conflict', winner: null };
      return sourceAt === null
        ? { reason: 'preserve', winner: destination }
        : { reason: 'update', winner: source };
    }
    return sourceAt > destinationAt
      ? { reason: 'update', winner: source }
      : { reason: 'preserve', winner: destination };
  }
  return ownedDecision(source) === ownedDecision(destination)
    ? { reason: 'no-op', winner: destination }
    : { reason: 'conflict', winner: null };
}

/** Destination-only keys stay in the destination; each winner retains its full provenance. */
export function planLicenseDecisionMerge(
  source: LicenseClassification[],
  destination: LicenseClassification[]
): PlannedLicenseDecision[] {
  const sourceByKey = new Map(source.map((row) => [row.normalizedText, row]));
  const destinationByKey = new Map(destination.map((row) => [row.normalizedText, row]));
  if (sourceByKey.size !== source.length || destinationByKey.size !== destination.length)
    throw new Error('Duplicate normalized classification key in merge input');
  const keys = [...new Set([...sourceByKey.keys(), ...destinationByKey.keys()])].sort();
  return keys.map((normalizedText) => {
    const draft = sourceByKey.get(normalizedText) ?? null;
    const stored = destinationByKey.get(normalizedText) ?? null;
    const result = draft
      ? compareLicenseDecisions(draft, stored)
      : { reason: 'preserve' as const, winner: stored };
    return { normalizedText, source: draft, destination: stored, ...result };
  });
}
