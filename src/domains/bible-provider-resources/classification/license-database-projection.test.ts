import { describe, expect, it } from 'vitest';

import { makeLicenseArtifact } from '../license-artifact.test-fixtures';
import {
  licenseDatabaseProjection,
  planLicenseMaintenanceChanges,
  selectLicenseMaintenanceRows,
} from './license-database-projection';

describe('maintenance preview parity', () => {
  it('preserves unchanged legacy table provenance and plans only writer-selected differences', () => {
    const artifact = makeLicenseArtifact();
    const projected = licenseDatabaseProjection(artifact);
    const table = artifact.classifications.find((row) => row.source === 'table')!;
    const manual = artifact.classifications.find((row) => row.source !== 'table')!;
    const old = [
      {
        normalizedText: table.normalizedText,
        status: table.status,
        rationale: table.rationale,
        classifiedBy: 'legacy-owner',
        reviewedAt: null,
      },
      {
        normalizedText: manual.normalizedText,
        status: 'unknown' as const,
        rationale: 'Older rationale',
        classifiedBy: 'legacy-owner',
        reviewedAt: null,
      },
      {
        normalizedText: 'old-only',
        status: 'forbidden' as const,
        rationale: 'Keep row',
        classifiedBy: 'legacy-owner',
        reviewedAt: null,
      },
    ];
    const selected = selectLicenseMaintenanceRows(artifact, old);
    expect(selected.some((row) => row.normalizedText === table.normalizedText)).toBe(false);
    expect(selected.some((row) => row.normalizedText === manual.normalizedText)).toBe(true);
    const plan = planLicenseMaintenanceChanges(artifact, old);
    expect(plan.insertedKeys).toEqual(
      projected
        .filter((row) => !old.some((prior) => prior.normalizedText === row.normalizedText))
        .map((row) => row.normalizedText)
    );
    expect(plan.changedKeys).toContain(manual.normalizedText);
    expect(plan.changedKeys).not.toContain(table.normalizedText);
    expect(plan.deletedKeys).toEqual([]);
  });
});
