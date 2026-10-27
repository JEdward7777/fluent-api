import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestSchema } from '@/db/testing/create-catalogue-schema';
import * as schema from '@/db/testing/expanded-catalog-schema';
import * as resources from '@/domains/bible-provider-resources/bible-provider-resources.service';
import { getBibleById } from '@/domains/bibles/bibles.service';
import { makeDblTestClient } from '@/lib/services/dbl/dbl.test-fixtures';
import { ErrorCode } from '@/lib/types';
import { makeDblBible } from '@/test/utils/test-helpers';

import {
  acquireDblBibleCatalog,
  persistDblBibleCatalog,
  syncBiblesFromDbl,
} from './dbl-bible-sync';

const { client, database, queries } = await vi.hoisted(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const client = new PGlite();
  const queries: string[] = [];
  return {
    client,
    queries,
    database: drizzle(client, {
      logger: {
        logQuery: (query: string) => {
          queries.push(query);
        },
      },
    }),
  };
});
vi.mock('@/db', () => ({ db: database }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

beforeAll(async () => {
  await createTestSchema(client, {
    languages: schema.languages,
    bible_provider_resources: schema.bible_provider_resources,
    bibles: schema.bibles,
    license_classifications: schema.license_classifications,
    scriptDirectionEnum: schema.scriptDirectionEnum,
    bibleProviderEnum: schema.bibleProviderEnum,
    resourceProviderEnum: schema.resourceProviderEnum,
    ttsLicenseStatusEnum: schema.ttsLicenseStatusEnum,
  });
}, 30000);
beforeEach(async () => {
  await database.delete(schema.bibles);
  await database.delete(schema.bible_provider_resources);
  await database.delete(schema.license_classifications);
  await database.delete(schema.languages);
  await database
    .insert(schema.languages)
    .values({ id: 1, langName: 'English', langCodeIso6393: 'eng' });
  queries.length = 0;
});
afterAll(async () => {
  await client.close();
});

describe('dBL text license facts and canonical recording compatibility', () => {
  it('inserts explicit Phase-1 allowed facts, skips unmapped languages, and does not seed classifications', async () => {
    const upstream = [
      makeDblBible({
        id: 'one',
        name: 'One',
        abbreviationLocal: 'ONE',
        copyright: '  Public domain.  ',
      }),
      makeDblBible({ id: 'two', name: 'Two', abbreviationLocal: 'TWO', copyright: ' \n ' }),
      makeDblBible({ id: 'skip', language: { ...makeDblBible().language, id: 'spa' } }),
    ];
    const result = await syncBiblesFromDbl(makeDblTestClient(upstream), 'allowed');
    expect(result).toMatchObject({
      ok: true,
      data: {
        totalBibles: 3,
        skippedMissingLanguage: 1,
        inserted: 2,
        updated: 0,
        licenseFacts: { inserted: 2, updated: 0, distinctNotices: 1, nullNotices: 1 },
      },
    });
    const records = await database
      .select()
      .from(schema.bible_provider_resources)
      .orderBy(schema.bible_provider_resources.externalId);
    expect(records).toMatchObject([
      {
        externalId: 'one',
        ttsLicenseStatus: 'allowed',
        textLicenseNotice: 'Public domain.',
        licenseNotice: null,
        legacyLicenseNotice: null,
      },
      { externalId: 'two', ttsLicenseStatus: 'allowed', textLicenseNotice: null },
    ]);
    expect(await database.select().from(schema.license_classifications)).toEqual([]);
    const [bible] = await database
      .select()
      .from(schema.bibles)
      .where(eq(schema.bibles.externalId, 'one'));
    expect(await getBibleById(bible.id)).toMatchObject({
      ok: true,
      data: {
        provider: 'dbl',
        ttsLicenseStatus: 'allowed',
        textBibleKey: 'dbl-one',
        selectedRecordingKey: null,
      },
    });
    const stamps = (await database.select().from(schema.bibles)).map((row) => row.updatedAt);
    expect(await syncBiblesFromDbl(makeDblTestClient(upstream), 'allowed')).toMatchObject({
      ok: true,
      data: { inserted: 0, updated: 0, licenseFacts: { inserted: 0, updated: 0 } },
    });
    expect((await database.select().from(schema.bibles)).map((row) => row.updatedAt)).toEqual(
      stamps
    );
  });
  it('ordinary acquisition never inserts allowed implicitly', async () => {
    expect((await syncBiblesFromDbl(makeDblTestClient([makeDblBible()]))).ok).toBe(true);
    expect(
      (await database.select().from(schema.bible_provider_resources))[0].ttsLicenseStatus
    ).toBe('forbidden');
  });
  it('refreshes changed text facts while preserving curated status, recording notices, stored labels and selected audio', async () => {
    const [text, recording] = await database
      .insert(schema.bible_provider_resources)
      .values([
        {
          provider: 'dbl',
          externalId: 'text-1',
          ttsLicenseStatus: 'forbidden',
          licenseNotice: 'Independent recording attribution',
          textLicenseNotice: 'Old text notice',
          displayName: 'Stored',
        },
        {
          provider: 'aquifer',
          externalId: '1',
          ttsLicenseStatus: 'allowed',
          licenseNotice: 'Aquifer recording attribution',
        },
      ])
      .returning();
    const [bible] = await database
      .insert(schema.bibles)
      .values({
        languageId: 1,
        name: 'Stored',
        abbreviation: 'STORED',
        provider: 'dbl',
        externalId: 'text-1',
        audioResourceId: recording.id,
      })
      .returning();
    const result = await syncBiblesFromDbl(
      makeDblTestClient([makeDblBible({ copyright: 'New text notice' })]),
      'allowed'
    );
    expect(result).toMatchObject({
      ok: true,
      data: { inserted: 0, updated: 0, licenseFacts: { inserted: 0, updated: 1 } },
    });
    const [after] = await database
      .select()
      .from(schema.bible_provider_resources)
      .where(eq(schema.bible_provider_resources.id, text.id));
    expect(after).toMatchObject({
      ttsLicenseStatus: 'forbidden',
      textLicenseNotice: 'New text notice',
      licenseNotice: 'Independent recording attribution',
      legacyLicenseNotice: 'Independent recording attribution',
      displayName: 'Stored',
    });
    const [updated] = await database
      .select()
      .from(schema.bibles)
      .where(eq(schema.bibles.id, bible.id));
    expect(updated.audioResourceId).toBe(recording.id);
    expect(updated.updatedAt!.getTime()).toBeGreaterThan(bible.updatedAt!.getTime());
    queries.length = 0;
    expect(await resources.getById(text.id)).toEqual({
      ok: true,
      data: {
        id: text.id,
        provider: 'dbl',
        externalId: 'text-1',
        ttsLicenseStatus: 'forbidden',
        licenseNotice: 'Independent recording attribution',
        displayName: 'Stored',
      },
    });
    expect(queries.join('\n')).toContain('"recording_license_notice"');
    expect(queries.join('\n')).not.toMatch(/"license_notice"/);
  });
  it('rolls resource facts back when the corresponding Bible write fails', async () => {
    const catalog = await acquireDblBibleCatalog(
      makeDblTestClient([makeDblBible({ name: 'X'.repeat(300) })])
    );
    if (!catalog.ok) throw new Error('Fixture acquisition failed');
    const [before] = await database.select().from(schema.catalogue_watermark);
    expect(await persistDblBibleCatalog(catalog.data, 'allowed')).toMatchObject({
      ok: false,
      error: { code: ErrorCode.INTERNAL_ERROR },
    });
    expect(await database.select().from(schema.bible_provider_resources)).toEqual([]);
    expect(await database.select().from(schema.bibles)).toEqual([]);
    expect((await database.select().from(schema.catalogue_watermark))[0].updatedAt).toEqual(
      before.updatedAt
    );
  });
  it('rolls back without writing a Bible when provider fact persistence fails', async () => {
    await client.exec(
      `ALTER TABLE bible_provider_resources ADD CONSTRAINT reject_fixture CHECK (display_name <> 'Reject')`
    );
    try {
      expect(
        await syncBiblesFromDbl(makeDblTestClient([makeDblBible({ name: 'Reject' })]), 'allowed')
      ).toMatchObject({ ok: false, error: { code: ErrorCode.INTERNAL_ERROR } });
      expect(await database.select().from(schema.bibles)).toEqual([]);
      expect(await database.select().from(schema.bible_provider_resources)).toEqual([]);
    } finally {
      await client.exec('ALTER TABLE bible_provider_resources DROP CONSTRAINT reject_fixture');
    }
  });
  it('mirrors legacy/canonical writes including nulls, rejects conflicts, and preserves no-op allocator values', async () => {
    const [resource] = await database
      .insert(schema.bible_provider_resources)
      .values({ provider: 'dbl', externalId: 'bridge', licenseNotice: 'Original' })
      .returning();
    await database.insert(schema.bibles).values({
      languageId: 1,
      name: 'Bridge Bible',
      abbreviation: 'BRIDGE',
      provider: 'dbl',
      externalId: 'bridge',
      audioResourceId: resource.id,
    });
    await database
      .update(schema.catalogue_watermark)
      .set({ updatedAt: new Date('2090-01-01T00:00:00Z') });
    const read = async () =>
      (
        await client.query<{
          license_notice: string | null;
          recording_license_notice: string | null;
          text_license_notice: string | null;
        }>(
          'SELECT license_notice, recording_license_notice, text_license_notice FROM bible_provider_resources WHERE external_id = $1',
          ['bridge']
        )
      ).rows[0];
    const watermark = async () =>
      (await database.select().from(schema.catalogue_watermark))[0].updatedAt;
    const before = await watermark();
    await client.query('UPDATE bible_provider_resources SET license_notice = $1 WHERE id = $2', [
      'Old binary write',
      resource.id,
    ]);
    expect(await read()).toMatchObject({
      license_notice: 'Old binary write',
      recording_license_notice: 'Old binary write',
    });
    expect((await watermark()).getTime() - before.getTime()).toBe(1);
    const updated = await watermark();
    await client.query('UPDATE bible_provider_resources SET license_notice = $1 WHERE id = $2', [
      'Old binary write',
      resource.id,
    ]);
    expect(await watermark()).toEqual(updated);
    await database
      .update(schema.bible_provider_resources)
      .set({ licenseNotice: null })
      .where(eq(schema.bible_provider_resources.id, resource.id));
    expect(await read()).toMatchObject({ license_notice: null, recording_license_notice: null });
    await client.query(
      'UPDATE bible_provider_resources SET license_notice = $1, recording_license_notice = $1 WHERE id = $2',
      ['Equal', resource.id]
    );
    await expect(
      client.query(
        'UPDATE bible_provider_resources SET license_notice = $1, recording_license_notice = $2 WHERE id = $3',
        ['Legacy conflict', 'Canonical conflict', resource.id]
      )
    ).rejects.toThrow('Conflicting recording license notices');
    expect(await read()).toMatchObject({
      license_notice: 'Equal',
      recording_license_notice: 'Equal',
    });
    await database
      .update(schema.bible_provider_resources)
      .set({ textLicenseNotice: 'Independent text terms' })
      .where(eq(schema.bible_provider_resources.id, resource.id));
    expect(await read()).toMatchObject({
      license_notice: 'Equal',
      recording_license_notice: 'Equal',
      text_license_notice: 'Independent text terms',
    });
    await client.query('UPDATE bible_provider_resources SET license_notice = NULL WHERE id = $1', [
      resource.id,
    ]);
    expect(await read()).toMatchObject({ recording_license_notice: null });
  });
  it('sweeps English text notices only, preserves independent recording attribution, and is idempotent', async () => {
    await database.insert(schema.bible_provider_resources).values([
      {
        provider: 'dbl',
        externalId: 'arr1',
        textLicenseNotice: 'All Rights Reserved.',
        ttsLicenseStatus: 'allowed',
      },
      {
        provider: 'dbl',
        externalId: 'arr2',
        textLicenseNotice: 'all rights reserved',
        ttsLicenseStatus: 'unknown',
      },
      {
        provider: 'dbl',
        externalId: 'already',
        textLicenseNotice: 'ALL RIGHTS RESERVED',
        ttsLicenseStatus: 'forbidden',
      },
      {
        provider: 'dbl',
        externalId: 'french',
        textLicenseNotice: 'Tous droits réservés',
        ttsLicenseStatus: 'allowed',
      },
      {
        provider: 'dbl',
        externalId: 'public1',
        textLicenseNotice: 'Public domain',
        licenseNotice: 'All rights reserved recording',
        ttsLicenseStatus: 'allowed',
      },
      {
        provider: 'dbl',
        externalId: 'public2',
        textLicenseNotice: 'Public domain',
        ttsLicenseStatus: 'allowed',
      },
      { provider: 'dbl', externalId: 'null', textLicenseNotice: null, ttsLicenseStatus: 'allowed' },
      {
        provider: 'aquifer',
        externalId: 'foreign',
        textLicenseNotice: 'All rights reserved',
        ttsLicenseStatus: 'allowed',
      },
    ]);
    expect(await resources.applyAllRightsReservedSweep()).toMatchObject({
      ok: true,
      data: {
        matched: 3,
        updated: 2,
        unmatchedDistinctNotices: 2,
        unmatchedNotices: ['Public domain', 'Tous droits réservés'],
      },
    });
    const rows = await database
      .select()
      .from(schema.bible_provider_resources)
      .orderBy(schema.bible_provider_resources.externalId);
    for (const row of rows)
      expect(row.ttsLicenseStatus).toBe(
        ['arr1', 'arr2', 'already'].includes(row.externalId) ? 'forbidden' : 'allowed'
      );
    expect(await resources.applyAllRightsReservedSweep()).toMatchObject({
      ok: true,
      data: { matched: 3, updated: 0, unmatchedDistinctNotices: 2 },
    });
    expect(
      await database
        .select()
        .from(schema.bible_provider_resources)
        .orderBy(schema.bible_provider_resources.externalId)
    ).toEqual(rows);
    expect(await database.select().from(schema.license_classifications)).toEqual([]);
  });
});
