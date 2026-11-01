import { describe, expect, it } from 'vitest';

import { createLicenseArtifact } from '../license-artifact';
import { makeLicenseArtifact } from '../license-artifact.test-fixtures';
import {
  getLicenseWorkbenchReviewDetail,
  listLicenseWorkbenchReview,
} from './license-workbench-review';

describe('license workbench review projection', () => {
  it('keeps protocol row identity out of legal unconsumed classification extensions', () => {
    const original = makeLicenseArtifact();
    const extended = structuredClone(original);
    Object.assign(extended.classifications[0], {
      id: 'extension-row-id',
      configurationRevision: 999,
      contentRevision: 999,
    });
    const artifact = createLicenseArtifact(extended);
    const page = listLicenseWorkbenchReview(artifact, {
      search: '',
      status: 'all',
      source: 'all',
      page: 1,
    });
    const projected = page.rows.find(
      (row) => row.normalizedText === original.classifications[0].normalizedText
    )!;
    const detail = getLicenseWorkbenchReviewDetail(artifact, projected.id);
    expect(projected.id).toMatch(/^[a-f0-9]{64}$/);
    expect(detail?.id).toBe(projected.id);
    expect(detail).not.toHaveProperty('configurationRevision');
    expect(detail).not.toHaveProperty('contentRevision');
    expect(artifact.classifications[0]).toMatchObject({
      id: 'extension-row-id',
      configurationRevision: 999,
      contentRevision: 999,
    });
  });
  it('keeps stable IDs across search and pages, including an empty normalized key', () => {
    const artifact = makeLicenseArtifact();
    const example = artifact.classifications[0];
    artifact.classifications.push({
      ...example,
      normalizedText: '',
      exampleNotice: '2010',
      status: 'unknown',
      samples: [],
      source: 'table',
      rule: undefined,
    });
    artifact.catalog.push({
      provider: 'dbl',
      externalId: 'year-only',
      bibleId: 99,
      name: 'Year Bible',
      abbreviation: 'YB',
      rawNotice: '2010',
    });
    const all = listLicenseWorkbenchReview(artifact, {
      search: '',
      status: 'all',
      source: 'all',
      page: 1,
    });
    const filtered = listLicenseWorkbenchReview(artifact, {
      search: 'Year Bible',
      status: 'unknown',
      source: 'table',
      page: 9,
    });
    expect(filtered).toMatchObject({ total: 1, allCount: 4, page: 1, pageSize: 25 });
    expect(filtered.rows[0].id).toBe(all.rows.find((row) => row.normalizedText === '')?.id);
    expect(filtered.rows[0]).toMatchObject({ preview: '2010', bibleNames: ['Year Bible'] });
    const detail = getLicenseWorkbenchReviewDetail(artifact, filtered.rows[0].id);
    expect(detail).toMatchObject({ normalizedText: '', variants: ['2010'] });
    expect(detail?.modelEvidenceLabel).toContain('No model request');
  });

  it('returns full saved model evidence and never treats a rule as a model call', () => {
    const artifact = makeLicenseArtifact();
    const page = listLicenseWorkbenchReview(artifact, {
      search: 'Bible 2',
      status: 'all',
      source: 'all',
      page: 1,
    });
    expect(page.total).toBe(1);
    const detail = getLicenseWorkbenchReviewDetail(artifact, page.rows[0].id);
    expect(detail?.samples).toHaveLength(6);
    expect(detail?.samples[0]).toMatchObject({
      request: artifact.classifications[1].samples[0].request,
      response: artifact.classifications[1].samples[0].response,
      result: artifact.classifications[1].samples[0].result,
    });
    const rulePage = listLicenseWorkbenchReview(artifact, {
      search: '',
      status: 'all',
      source: 'rule',
      page: 1,
    });
    expect(rulePage.rows[0].sampleCount).toBe(0);
    expect(
      getLicenseWorkbenchReviewDetail(artifact, rulePage.rows[0].id)?.rule?.priority
    ).toBeTypeOf('number');
  });

  it('uses current database membership and IDs while retaining saved original variants', () => {
    const artifact = makeLicenseArtifact();
    artifact.catalog[2].rawNotice = 'Terms   available on request.';
    const context = {
      label: 'Disposable target',
      projection: 'classification-only' as const,
      resources: [
        {
          provider: 'dbl' as const,
          externalId: 'text-3',
          bibleId: 903,
          name: 'Current Bible Name',
          abbreviation: 'CBN',
          rawNotice: 'Terms available on request.',
          ttsLicenseStatus: 'unknown' as const,
        },
        {
          provider: 'dbl' as const,
          externalId: 'database-only',
          bibleId: 904,
          name: 'Database Only Bible',
          abbreviation: 'DOB',
          rawNotice: 'Terms available on request.',
          ttsLicenseStatus: 'unknown' as const,
        },
      ],
    };
    const query = { search: '904', status: 'all' as const, source: 'all' as const, page: 1 };
    const page = listLicenseWorkbenchReview(artifact, query, context);
    expect(page.context).toMatchObject({ kind: 'database', label: 'Disposable target' });
    expect(page.total).toBe(1);
    expect(page.rows[0]).toMatchObject({
      bibleCount: 2,
      bibleNames: ['Database Only Bible', 'Current Bible Name'],
    });
    const detail = getLicenseWorkbenchReviewDetail(artifact, page.rows[0].id, context);
    expect(detail?.variants).toEqual([
      'Terms available on request.',
      'Terms   available on request.',
    ]);
    expect(detail?.bibles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Current Bible Name', bibleId: 903 }),
        expect.objectContaining({ name: 'Database Only Bible', bibleId: 904 }),
      ])
    );
    expect(
      listLicenseWorkbenchReview(artifact, { ...query, search: 'Bible 3' }, context).total
    ).toBe(0);
  });
});
