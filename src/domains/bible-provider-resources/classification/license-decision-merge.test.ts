import { describe, expect, it } from 'vitest';

import { makeLicenseArtifact } from '../license-artifact.test-fixtures';
import { compareLicenseDecisions, planLicenseDecisionMerge } from './license-decision-merge';

describe('whole license decision merge', () => {
  const make = () => structuredClone(makeLicenseArtifact().classifications[0]);

  it('inserts and replays whole decisions', () => {
    const row = make();
    expect(compareLicenseDecisions(row, null)).toEqual({ reason: 'insert', winner: row });
    expect(compareLicenseDecisions(row, structuredClone(row))).toMatchObject({ reason: 'no-op' });
    const withDiagnostics = structuredClone(row);
    withDiagnostics.vendorDiagnostic = { ignored: true };
    expect(compareLicenseDecisions(withDiagnostics, row).reason).toBe('no-op');
  });

  it('ranks human review above later automatic evidence', () => {
    const source = make();
    const destination = make();
    source.reviewState = 'llm_reviewed';
    source.decisionAt = '2026-11-18T00:00:00.000Z';
    destination.reviewState = 'human_reviewed';
    destination.decisionAt = '2026-11-17T00:00:00.000Z';
    destination.reviewedBy = 'Reviewer';
    destination.humanReviewedAt = destination.decisionAt;
    expect(compareLicenseDecisions(source, destination)).toEqual({
      reason: 'preserve',
      winner: destination,
    });
  });

  it('orders dated versus undated equal-rank rows without inventing a date', () => {
    const dated = make();
    const undated = make();
    dated.decisionAt = '2026-11-17T00:00:00.000Z';
    expect(compareLicenseDecisions(dated, undated)).toEqual({ reason: 'update', winner: dated });
    expect(compareLicenseDecisions(undated, dated)).toEqual({ reason: 'preserve', winner: dated });
    undated.rationale = 'Different evidence';
    expect(compareLicenseDecisions(undated, dated)).toEqual({ reason: 'conflict', winner: null });
  });

  it('compares UTC instants across offsets at millisecond precision', () => {
    const source = make();
    const destination = make();
    source.decisionAt = '2026-11-17T01:00:00.101+01:00';
    destination.decisionAt = '2026-11-17T00:00:00.102Z';
    expect(compareLicenseDecisions(source, destination).reason).toBe('preserve');
    source.decisionAt = '2026-11-17T01:00:00.102+01:00';
    expect(compareLicenseDecisions(source, destination).reason).toBe('no-op');
    source.rationale = 'Different';
    expect(compareLicenseDecisions(source, destination).reason).toBe('conflict');
  });

  it('plans destination-only preservation without feeding winners into source', () => {
    const source = make();
    const destinationOnly = make();
    destinationOnly.normalizedText = 'destination-only';
    const plan = planLicenseDecisionMerge([source], [destinationOnly]);
    expect(plan.map(({ reason }) => reason)).toEqual(['insert', 'preserve']);
    expect(plan.find(({ normalizedText }) => normalizedText === 'destination-only')?.winner).toBe(
      destinationOnly
    );
    expect(source.normalizedText).not.toBe(destinationOnly.normalizedText);
  });

  it('conflicts on equal-rank, equal-time material evidence even with the same permission', () => {
    const source = make();
    const destination = make();
    source.rationale = 'Different explanation';
    expect(compareLicenseDecisions(source, destination)).toEqual({
      reason: 'conflict',
      winner: null,
    });
    source.decisionAt = '2026-11-17T00:00:00.000Z';
    destination.decisionAt = source.decisionAt;
    expect(compareLicenseDecisions(source, destination).reason).toBe('conflict');
  });

  it('takes all provenance from the later same-rank decision', () => {
    const source = make();
    const destination = make();
    source.decisionAt = '2026-11-18T00:00:00.000Z';
    source.rationale = 'Fresh reason';
    destination.decisionAt = '2026-11-17T00:00:00.000Z';
    destination.rowNote = 'Old note';
    const result = compareLicenseDecisions(source, destination);
    expect(result).toEqual({ reason: 'update', winner: source });
    expect(result.winner?.rowNote).toBeUndefined();
  });
});
