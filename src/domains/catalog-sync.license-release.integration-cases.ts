import type postgres from 'postgres';

import { expect, it } from 'vitest';

import * as resources from '@/domains/bible-provider-resources/bible-provider-resources.service';
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
}
