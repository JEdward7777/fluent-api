import type postgres from 'postgres';

import { expect, it } from 'vitest';

import * as resources from '@/domains/bible-provider-resources/bible-provider-resources.service';
import { createLicenseDatabaseAdapter } from '@/domains/bible-provider-resources/classification/license-classifications.service';
import { attestLicenseArtifact } from '@/domains/bible-provider-resources/license-artifact';
import {
  makeLicenseArtifact,
  REVIEWER,
} from '@/domains/bible-provider-resources/license-artifact.test-fixtures';
import { persistDblBibleCatalog } from '@/domains/bibles/sync/dbl-bible-sync';
import { ErrorCode } from '@/lib/types';

export interface LegacyLicenseSnapshot {
  resourceId: number;
  bibleId: number;
  updatedAt: Date;
  notice: string;
}

/** Registered only by the guarded disposable PostgreSQL watermark suite; never touches app DBs. */
export function registerLicenseReleaseCases(
  sql: postgres.Sql,
  getLegacy: () => LegacyLicenseSnapshot
) {
  it('expands the old recording schema without changing existing policy or Bible watermarks', async () => {
    const legacy = getLegacy();
    const [row] = await sql<
      {
        license_notice: string | null;
        recording_license_notice: string | null;
        text_license_notice: string | null;
        tts_license_status: string;
        updated_at: Date;
      }[]
    >`SELECT r.license_notice, r.recording_license_notice, r.text_license_notice, r.tts_license_status, b.updated_at FROM bible_provider_resources r JOIN bibles b ON b.id = ${legacy.bibleId} WHERE r.id = ${legacy.resourceId}`;
    expect(row).toMatchObject({
      license_notice: legacy.notice,
      recording_license_notice: legacy.notice,
      text_license_notice: null,
      tts_license_status: 'forbidden',
      updated_at: legacy.updatedAt,
    });
    expect(await sql`SELECT * FROM license_classifications`).toEqual([]);
  });

  it('mirrors old/new recording writes and NULL clears, rejects genuine conflicts, and avoids no-op churn in PostgreSQL', async () => {
    const legacy = getLegacy();
    const resource = legacy.resourceId;
    const read = async () =>
      (
        await sql<
          {
            license_notice: string | null;
            recording_license_notice: string | null;
            text_license_notice: string | null;
            updated_at: Date;
          }[]
        >`SELECT r.license_notice, r.recording_license_notice, r.text_license_notice, b.updated_at FROM bible_provider_resources r JOIN bibles b ON b.id = ${legacy.bibleId} WHERE r.id = ${resource}`
      )[0]!;
    const allocator = async () =>
      (await sql<{ updated_at: Date }[]>`SELECT updated_at FROM catalogue_watermark`)[0]!
        .updated_at;
    await sql`UPDATE catalogue_watermark SET updated_at = '2090-01-01T00:00:00Z'`;
    const before = await allocator();
    await sql`UPDATE bible_provider_resources SET license_notice = 'Old binary value' WHERE id = ${resource}`;
    expect(await read()).toMatchObject({
      license_notice: 'Old binary value',
      recording_license_notice: 'Old binary value',
    });
    expect((await allocator()).getTime() - before.getTime()).toBe(1);
    const changed = await allocator();
    await sql`UPDATE bible_provider_resources SET license_notice = 'Old binary value' WHERE id = ${resource}`;
    expect(await allocator()).toEqual(changed);
    await sql`UPDATE bible_provider_resources SET recording_license_notice = NULL WHERE id = ${resource}`;
    expect(await read()).toMatchObject({ license_notice: null, recording_license_notice: null });
    await sql`UPDATE bible_provider_resources SET recording_license_notice = 'New binary value' WHERE id = ${resource}`;
    expect(await read()).toMatchObject({
      license_notice: 'New binary value',
      recording_license_notice: 'New binary value',
    });
    await sql`UPDATE bible_provider_resources SET license_notice = NULL WHERE id = ${resource}`;
    expect(await read()).toMatchObject({ license_notice: null, recording_license_notice: null });
    await sql`UPDATE bible_provider_resources SET license_notice = 'Equal', recording_license_notice = 'Equal' WHERE id = ${resource}`;
    await expect(
      sql`UPDATE bible_provider_resources SET license_notice = 'Old conflict', recording_license_notice = 'New conflict' WHERE id = ${resource}`
    ).rejects.toMatchObject({ code: '23514' });
    expect(await read()).toMatchObject({
      license_notice: 'Equal',
      recording_license_notice: 'Equal',
    });
    await sql`UPDATE bible_provider_resources SET text_license_notice = 'Independent text notice' WHERE id = ${resource}`;
    const textChanged = await read();
    expect(textChanged).toMatchObject({
      license_notice: 'Equal',
      recording_license_notice: 'Equal',
      text_license_notice: 'Independent text notice',
    });
    const textStamp = await allocator();
    await sql`UPDATE bible_provider_resources SET text_license_notice = 'Independent text notice' WHERE id = ${resource}`;
    expect(await allocator()).toEqual(textStamp);
    await sql`UPDATE bible_provider_resources SET text_license_notice = NULL WHERE id = ${resource}`;
    expect((await read()).updated_at.getTime()).toBeGreaterThan(textChanged.updated_at.getTime());
    await expect(
      sql`INSERT INTO bible_provider_resources(provider, external_id, license_notice, recording_license_notice) VALUES ('dbl','conflicting-insert','One','Two')`
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('persists provider/Bible facts atomically with real upsert counts, preserved policy and rollback', async () => {
    const [language] = await sql<
      { id: number }[]
    >`INSERT INTO languages(lang_name) VALUES ('Atomic real PG language') RETURNING id`;
    const row = {
      languageId: language!.id,
      provider: 'dbl' as const,
      externalId: 'pg-atomic',
      name: 'PG atomic Bible',
      abbreviation: 'PGATOM',
      hasAudio: false,
      textLicenseNotice: 'Public domain',
    };
    const catalog = { rows: [row], totalBibles: 1, skippedMissingLanguage: 0 };
    try {
      expect(await persistDblBibleCatalog(catalog, 'allowed')).toMatchObject({
        ok: true,
        data: { inserted: 1, updated: 0, licenseFacts: { inserted: 1, updated: 0 } },
      });
      const [initial] = await sql<
        { updated_at: Date }[]
      >`SELECT updated_at FROM bibles WHERE external_id = 'pg-atomic'`;
      expect(await persistDblBibleCatalog(catalog, 'allowed')).toMatchObject({
        ok: true,
        data: { inserted: 0, updated: 0, licenseFacts: { inserted: 0, updated: 0 } },
      });
      const [repeated] = await sql<
        { updated_at: Date }[]
      >`SELECT updated_at FROM bibles WHERE external_id = 'pg-atomic'`;
      expect(repeated!.updated_at).toEqual(initial!.updated_at);
      await sql`UPDATE bible_provider_resources SET tts_license_status = 'forbidden', recording_license_notice = 'Recording attribution' WHERE external_id = 'pg-atomic'`;
      expect(
        await persistDblBibleCatalog(
          { ...catalog, rows: [{ ...row, textLicenseNotice: 'Changed text notice' }] },
          'allowed'
        )
      ).toMatchObject({ ok: true, data: { licenseFacts: { inserted: 0, updated: 1 } } });
      const [preserved] =
        await sql`SELECT * FROM bible_provider_resources WHERE external_id = 'pg-atomic'`;
      expect(preserved).toMatchObject({
        tts_license_status: 'forbidden',
        recording_license_notice: 'Recording attribution',
        license_notice: 'Recording attribution',
        text_license_notice: 'Changed text notice',
      });
      const [before] = await sql<
        { updated_at: Date }[]
      >`SELECT updated_at FROM catalogue_watermark`;
      expect(
        await persistDblBibleCatalog(
          { ...catalog, rows: [{ ...row, externalId: 'pg-failure', name: 'X'.repeat(300) }] },
          'allowed'
        )
      ).toMatchObject({ ok: false, error: { code: ErrorCode.INTERNAL_ERROR } });
      expect(
        await sql`SELECT id FROM bible_provider_resources WHERE external_id = 'pg-failure'`
      ).toEqual([]);
      expect(await sql`SELECT id FROM bibles WHERE external_id = 'pg-failure'`).toEqual([]);
      expect(
        (await sql<{ updated_at: Date }[]>`SELECT updated_at FROM catalogue_watermark`)[0]!
          .updated_at
      ).toEqual(before!.updated_at);
    } finally {
      await sql`DELETE FROM bibles WHERE external_id IN ('pg-atomic','pg-failure')`;
      await sql`DELETE FROM bible_provider_resources WHERE external_id IN ('pg-atomic','pg-failure')`;
      await sql`DELETE FROM languages WHERE id = ${language!.id}`;
    }
  });

  it('applies the English text-only sweep with stable counts and no changes on rerun in PostgreSQL', async () => {
    await sql`INSERT INTO bible_provider_resources(provider,external_id,tts_license_status,text_license_notice) VALUES ('dbl','pg-arr','allowed','All Rights Reserved'),('dbl','pg-french','allowed','Tous droits réservés'),('dbl','pg-null','allowed',NULL),('aquifer','pg-nondbl','allowed','All rights reserved')`;
    try {
      const first = await resources.applyAllRightsReservedSweep();
      expect(first).toMatchObject({
        ok: true,
        data: {
          matched: 1,
          updated: 1,
          unmatchedDistinctNotices: 1,
          unmatchedNotices: ['Tous droits réservés'],
        },
      });
      expect(await resources.applyAllRightsReservedSweep()).toMatchObject({
        ok: true,
        data: { matched: 1, updated: 0, unmatchedDistinctNotices: 1 },
      });
      expect(
        (
          await sql`SELECT tts_license_status FROM bible_provider_resources WHERE external_id = 'pg-nondbl'`
        )[0]!.tts_license_status
      ).toBe('allowed');
      expect(
        (
          await sql`SELECT tts_license_status FROM bible_provider_resources WHERE external_id = 'pg-null'`
        )[0]!.tts_license_status
      ).toBe('allowed');
    } finally {
      await sql`DELETE FROM bible_provider_resources WHERE external_id IN ('pg-arr','pg-french','pg-null','pg-nondbl')`;
    }
  });
  it('replaces authoritative classifications transactionally, preserving unchanged timestamps and rolling back on publication failure in PostgreSQL', async () => {
    const adapter = createLicenseDatabaseAdapter();
    const artifact = attestLicenseArtifact(makeLicenseArtifact(), REVIEWER);
    try {
      await adapter.apply(artifact, true, undefined, true);
      const before = await sql`SELECT * FROM license_classifications ORDER BY normalized_text`;
      await adapter.apply(artifact, true, undefined, true);
      expect(await sql`SELECT * FROM license_classifications ORDER BY normalized_text`).toEqual(
        before
      );
      const changed = structuredClone(artifact);
      changed.classifications = changed.classifications.slice(0, 1);
      await expect(
        adapter.apply(
          changed,
          true,
          async () => {
            throw new Error('JSON rename failed');
          },
          true
        )
      ).rejects.toThrow('JSON rename failed');
      expect(await sql`SELECT * FROM license_classifications ORDER BY normalized_text`).toEqual(
        before
      );
      await adapter.apply(changed, true, undefined, true);
      expect(
        (await sql`SELECT normalized_text FROM license_classifications`).map(
          (row) => row.normalized_text
        )
      ).toEqual([changed.classifications[0].normalizedText]);
    } finally {
      await sql`DELETE FROM license_classifications`;
    }
  });
  it('derives every matching current notice after classification, flags missing keys once and preserves only on the requested PostgreSQL sync', async () => {
    const catalog = {
      totalBibles: 2,
      skippedMissingLanguage: 0,
      rows: [1, 2].map((id) => ({
        provider: 'dbl' as const,
        externalId: `pg-derived-${id}`,
        name: `PG Derived ${id}`,
        abbreviation: `PD${id}`,
        languageId: 1,
        hasAudio: false,
        textLicenseNotice: 'A PostgreSQL notice requiring review.',
      })),
    };
    try {
      expect(
        await persistDblBibleCatalog(catalog, { preserveExistingNonUnknowns: false })
      ).toMatchObject({ ok: true, data: { licensePolicy: { unknown: 2, newlyFlagged: 2 } } });
      expect(await sql`SELECT * FROM license_classifications`).toEqual([]);
      const before =
        await sql`SELECT id, updated_at FROM bibles WHERE external_id IN ('pg-derived-1','pg-derived-2') ORDER BY id`;
      expect(
        await persistDblBibleCatalog(catalog, { preserveExistingNonUnknowns: false })
      ).toMatchObject({
        ok: true,
        data: { licensePolicy: { newlyFlagged: 0 }, licenseFacts: { inserted: 0, updated: 0 } },
      });
      expect(
        await sql`SELECT id, updated_at FROM bibles WHERE external_id IN ('pg-derived-1','pg-derived-2') ORDER BY id`
      ).toEqual(before);
      await sql`INSERT INTO license_classifications(normalized_text,status,rationale,classified_by) VALUES ('a postgresql notice requiring review.','allowed','"Reviewed permission"'::jsonb,'human')`;
      await persistDblBibleCatalog(catalog, { preserveExistingNonUnknowns: false });
      expect(
        (
          await sql`SELECT tts_license_status FROM bible_provider_resources WHERE external_id IN ('pg-derived-1','pg-derived-2')`
        ).map((row) => row.tts_license_status)
      ).toEqual(['allowed', 'allowed']);
      await sql`UPDATE license_classifications SET status = 'forbidden'`;
      expect(
        await persistDblBibleCatalog(catalog, { preserveExistingNonUnknowns: true })
      ).toMatchObject({
        ok: true,
        data: { licensePolicy: { allowed: 2, newlyFlagged: 0, disagreements: expect.any(Array) } },
      });
      await persistDblBibleCatalog(catalog, { preserveExistingNonUnknowns: false });
      expect(
        (
          await sql`SELECT tts_license_status FROM bible_provider_resources WHERE external_id IN ('pg-derived-1','pg-derived-2')`
        ).map((row) => row.tts_license_status)
      ).toEqual(['forbidden', 'forbidden']);
    } finally {
      await sql`DELETE FROM bibles WHERE external_id IN ('pg-derived-1','pg-derived-2')`;
      await sql`DELETE FROM bible_provider_resources WHERE external_id IN ('pg-derived-1','pg-derived-2')`;
      await sql`DELETE FROM license_classifications`;
    }
  });

  it('serializes empty-table initialization with concurrent inserts and rejects unforced replacement before publishing files', async () => {
    const adapter = createLicenseDatabaseAdapter();
    const artifact = attestLicenseArtifact(makeLicenseArtifact(), REVIEWER);
    const writer = await sql.reserve();
    let committed = false;
    try {
      await writer`BEGIN`;
      await writer`INSERT INTO license_classifications(normalized_text,status,rationale,classified_by) VALUES ('concurrently initialized','forbidden','"Review"'::jsonb,'human')`;
      let published = false;
      const applying = adapter.apply(artifact, true, async () => {
        published = true;
      });
      const rejected = expect(applying).rejects.toThrow('--force is required');
      // The table lock waits for this ordinary writer; after commit the apply read must see it.
      await writer`COMMIT`;
      committed = true;
      await rejected;
      expect(published).toBe(false);
      expect(
        (await sql`SELECT normalized_text FROM license_classifications`).map(
          (row) => row.normalized_text
        )
      ).toEqual(['concurrently initialized']);
      await adapter.apply(artifact, true, undefined, true);
      expect(
        (await sql`SELECT normalized_text FROM license_classifications`).some(
          (row) => row.normalized_text === 'concurrently initialized'
        )
      ).toBe(false);
    } finally {
      if (!committed) await writer`ROLLBACK`;
      writer.release();
      await sql`DELETE FROM license_classifications`;
    }
  });
}
