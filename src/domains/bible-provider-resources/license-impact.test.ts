import { describe, expect, it } from 'vitest';

import { computeLicenseImpact, effectiveLicenseStatus } from './license-impact';
import { makeLicenseImpactFixture } from './license-report.test-fixtures';

describe('pure effective license policy and supplied database impact', () => {
  it.each([null, '', ' \n\t '])('makes empty raw notice %j forbidden before lookup', (notice) => {
    expect(effectiveLicenseStatus(notice, new Map([['', 'allowed']]))).toMatchObject({
      derivedStatus: 'forbidden',
      status: 'forbidden',
      missingClassification: false,
    });
  });
  it('keeps exact authoritative unknown distinct from a missing key and handles normalized-empty nonblank notices', () => {
    const table = new Map([
      ['terms', 'unknown'],
      ['', 'allowed'],
    ] as const);
    expect(effectiveLicenseStatus('Copyright 2026 TERMS', table)).toMatchObject({
      status: 'unknown',
      missingClassification: false,
    });
    expect(effectiveLicenseStatus('Terms.', table)).toMatchObject({
      status: 'unknown',
      missingClassification: true,
    });
    expect(effectiveLicenseStatus('© 2026', table)).toMatchObject({
      normalizedText: '',
      status: 'allowed',
      missingClassification: false,
    });
  });
  it.each(['allowed', 'forbidden'] as const)(
    'preserves existing %s only for the selected invocation and lists disagreement',
    (current) => {
      expect(
        effectiveLicenseStatus('terms', new Map([['terms', 'unknown']]), current, true)
      ).toMatchObject({ status: current, derivedStatus: 'unknown', disagreement: true });
      expect(
        effectiveLicenseStatus('terms', new Map([['terms', 'unknown']]), current)
      ).toMatchObject({ status: 'unknown', disagreement: false });
      expect(
        effectiveLicenseStatus('terms', new Map([['terms', 'unknown']]), 'unknown', true).status
      ).toBe('unknown');
    }
  );
  it('compares exact supplied state including new rows, notice changes, collisions, retained misses and eligibility', () => {
    const { artifact, database } = makeLicenseImpactFixture();
    const baseline = structuredClone(database);
    const impact = computeLicenseImpact(artifact, database);
    expect(impact.context).toMatchObject({ kind: 'database', label: database.label });
    expect(impact.rows).toHaveLength(5);
    expect(impact.changes).toHaveLength(4);
    expect(impact.totals).toEqual({ allowed: 1, forbidden: 2, unknown: 2 });
    expect(impact.classificationTotals).toEqual({ allowed: 1, forbidden: 1, unknown: 1 });
    expect(impact).toMatchObject({ unchanged: 1, ttsGains: 1, ttsLosses: 2 });
    expect(impact.newCatalogRows.map((row) => row.externalId)).toEqual(['new-text']);
    expect(impact.noticeChanges).toMatchObject([
      { currentNotice: 'Earlier licensing notice.', rawNotice: artifact.catalog[0].rawNotice },
    ]);
    expect(impact.collisions).toMatchObject([
      {
        normalizedText: artifact.classifications[0].normalizedText,
        notices: expect.arrayContaining([
          artifact.catalog[0].rawNotice,
          artifact.catalog[3].rawNotice,
        ]),
      },
    ]);
    expect(impact.missingClassifications).toMatchObject([
      { externalId: 'retained', currentStatus: 'allowed', status: 'unknown' },
    ]);
    expect(impact.diagnostics).toEqual({
      cacheHits: 0,
      freshSamples: 6,
      newCalls: 6,
      unreportedSamples: 0,
    });
    expect(database).toEqual(baseline);
  });
  it('reports every preservation disagreement and changes no newly added or unknown status', () => {
    const { artifact, database } = makeLicenseImpactFixture();
    const impact = computeLicenseImpact(artifact, database, true);
    expect(impact.disagreements).toHaveLength(3);
    expect(impact.changes).toHaveLength(1);
    expect(impact.totals).toEqual({ allowed: 2, forbidden: 2, unknown: 1 });
    expect(impact).toMatchObject({ ttsGains: 0, ttsLosses: 0 });
    expect(impact.preservationWarning).toContain('this invocation only');
    expect(impact.rows.find((row) => row.externalId === 'new-text')?.status).toBe('forbidden');
    expect(impact.rows.find((row) => row.externalId === 'text-3')?.status).toBe('unknown');
  });
  it('does not invent a baseline or production effects offline', () => {
    const { artifact } = makeLicenseImpactFixture();
    const impact = computeLicenseImpact(artifact);
    expect(impact.context).toMatchObject({ kind: 'artifact-only', label: null });
    expect(impact.context.disclaimer).toContain('no database context was supplied');
    expect(impact).toMatchObject({
      unchanged: null,
      ttsGains: null,
      ttsLosses: null,
      changes: [],
      newCatalogRows: [],
      noticeChanges: [],
    });
    expect(impact.rows.every((row) => row.currentStatus === null && row.isNew === null)).toBe(true);
  });
  it.each([null, 1234])(
    'uses the existing database Bible ID rather than artifact ID %s without changing either input',
    (artifactId) => {
      const { artifact, database } = makeLicenseImpactFixture();
      artifact.catalog[0].bibleId = artifactId;
      database.resources[0].bibleId = 9876;
      database.resources[0].name = 'Actual loaded Bible';
      database.resources[0].abbreviation = 'ACTUAL';
      const impact = computeLicenseImpact(artifact, database);
      expect(
        impact.rows.find((row) => row.externalId === artifact.catalog[0].externalId)
      ).toMatchObject({ bibleId: 9876, name: 'Actual loaded Bible', abbreviation: 'ACTUAL' });
      expect(artifact.catalog[0].bibleId).toBe(artifactId);
      expect(database.resources[0].bibleId).toBe(9876);
    }
  );

  it('rejects ambiguous duplicate database identities instead of picking an arbitrary row', () => {
    const { artifact, database } = makeLicenseImpactFixture();
    database.resources.push({ ...database.resources[0] });
    expect(() => computeLicenseImpact(artifact, database)).toThrow(
      'Duplicate database provider identity'
    );
  });
});
