import type postgres from 'postgres';

import { expect, it } from 'vitest';

import { seedBsbBibleTexts } from '@/db/seeds/bible-texts-bsb';
import { seedBibles } from '@/db/seeds/bibles';
import { runInTransaction } from '@/db/transaction';
import * as resources from '@/domains/bible-provider-resources/bible-provider-resources.service';
import { createLicenseDatabaseAdapter } from '@/domains/bible-provider-resources/classification/license-classifications.service';
import {
  createBible,
  deleteBible,
  getAllBibles,
  updateBible,
} from '@/domains/bibles/bibles.service';
import { persistDblBibleCatalog } from '@/domains/bibles/sync/dbl-bible-sync';

import { contractCatalogFixture } from './contract-catalog-fixture';

/** Real repositories on expanded and physically contracted PostgreSQL, last in the guarded suite. */
export function registerCanonicalCatalogCases(sql: postgres.Sql) {
  for (const contracted of [false, true])
    it(`runs canonical app writes on ${contracted ? 'contracted' : 'expanded'} PostgreSQL`, async () => {
      if (!contracted) {
        await sql.unsafe(`
        CREATE TABLE bible_books (bible_id integer REFERENCES bibles(id), book_id integer REFERENCES books(id), text_ingested_at timestamp, has_audio boolean NOT NULL DEFAULT false, created_at timestamp DEFAULT now(), updated_at timestamp DEFAULT now(), PRIMARY KEY(bible_id,book_id));
        CREATE TABLE bible_texts (id serial PRIMARY KEY, bible_id integer REFERENCES bibles(id), book_id integer REFERENCES books(id), chapter_number integer, verse_number integer, text text, created_at timestamp DEFAULT now(), updated_at timestamp DEFAULT now(), UNIQUE(bible_id,book_id,chapter_number,verse_number));
        INSERT INTO languages(lang_name,lang_code_iso_639_3) VALUES ('English seed','eng'),('Gujarati seed','guj') ON CONFLICT DO NOTHING;
        INSERT INTO books(code,eng_display_name) VALUES ('GEN','Genesis'),('EXO','Exodus'),('JHN','John') ON CONFLICT DO NOTHING;
      `);
      } else await contractCatalogFixture({ exec: (query) => sql.begin((tx) => tx.unsafe(query)) });
      await seedBibles();
      await seedBsbBibleTexts();
      expect(await getAllBibles()).toMatchObject({
        ok: true,
        data: expect.arrayContaining([
          expect.objectContaining({
            textBibleKey: 'dbl-bba9f40183526463-01',
            selectedRecordingKey: 'aq-1',
          }),
          expect.objectContaining({
            name: 'IRV Gujarati',
            textBibleKey: null,
            provider: 'dbl',
            hasAudio: false,
          }),
        ]),
      });
      const [recording] =
        await sql`SELECT id FROM bible_provider_resources WHERE provider='aquifer' AND external_id='1'`;
      for (const provider of ['dbl', 'aquifer', 'youversion'] as const) {
        const key = `actual-${contracted}-${provider}`;
        const [resource] =
          await sql`INSERT INTO bible_provider_resources(provider,external_id,has_audio,tts_license_status) VALUES(${provider},${key},true,'forbidden') RETURNING id`;
        const row = await createBible({
          name: key,
          abbreviation: key,
          languageId: 1,
          textResourceId: resource!.id,
          audioResourceId: recording!.id,
        });
        expect(row).toMatchObject({
          ok: true,
          data: {
            provider,
            textBibleKey: `${provider === 'aquifer' ? 'aq' : provider === 'youversion' ? 'yv' : 'dbl'}-${key}`,
            hasAudio: true,
          },
        });
        if (!row.ok) throw new Error('canonical create failed');
        expect(await updateBible(row.data.id, { textResourceId: null })).toMatchObject({
          ok: true,
          data: {
            textBibleKey: null,
            selectedRecordingKey: 'aq-1',
            provider: 'dbl',
            hasAudio: false,
            ttsLicenseStatus: 'unknown',
          },
        });
        if (!contracted) {
          const [old] =
            await sql`SELECT provider::text,external_id,has_audio,audio_resource_id FROM bibles WHERE id=${row.data.id}`;
          expect(old).toEqual({
            provider: 'dbl',
            external_id: null,
            has_audio: false,
            audio_resource_id: recording!.id,
          });
        }
        expect(await deleteBible(row.data.id)).toMatchObject({ ok: true });
      }
      const key = `batch-${contracted}`;
      const catalog = {
        totalBibles: 1,
        skippedMissingLanguage: 0,
        rows: [
          {
            provider: 'dbl' as const,
            externalId: key,
            name: key,
            abbreviation: key,
            languageId: 1,
            hasAudio: true,
            textLicenseNotice: 'PG exact notice',
          },
        ],
      };
      expect(await persistDblBibleCatalog(catalog, 'allowed')).toMatchObject({
        ok: true,
        data: { inserted: 1 },
      });
      const before = await getAllBibles();
      expect(await persistDblBibleCatalog(catalog, 'allowed')).toMatchObject({
        ok: true,
        data: { inserted: 0, updated: 0, licenseFacts: { inserted: 0, updated: 0 } },
      });
      expect(await getAllBibles()).toEqual(before);
      const snapshot = await createLicenseDatabaseAdapter().load();
      expect(snapshot.context.resources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ externalId: key, rawNotice: 'PG exact notice' }),
        ])
      );
    });
  it('keeps contracted notice revisions commit-ordered, no-op stable and transactionally rolled back without compatibility helpers', async () => {
    expect(
      await sql`SELECT proname FROM pg_proc WHERE proname IN ('bridge_bible_text_resource','bridge_legacy_bible_audio','bridge_recording_license_notice','lock_catalog_bridge_writer')`
    ).toEqual([]);
    const [resource] =
      await sql`SELECT id FROM bible_provider_resources WHERE provider='aquifer' AND external_id='1'`;
    const read = () => sql`SELECT updated_at FROM bibles WHERE abbreviation='BSB'`;
    const before = await read();
    const revision = await sql`SELECT updated_at FROM catalogue_watermark`;
    await sql`UPDATE bible_provider_resources SET recording_license_notice=recording_license_notice,text_license_notice=text_license_notice WHERE id=${resource!.id}`;
    expect(await read()).toEqual(before);
    expect(await sql`SELECT updated_at FROM catalogue_watermark`).toEqual(revision);
    await expect(
      sql.begin(async (tx) => {
        await tx`UPDATE bible_provider_resources SET text_license_notice='rollback' WHERE id=${resource!.id}`;
        throw new Error('rollback');
      })
    ).rejects.toThrow('rollback');
    expect(await read()).toEqual(before);
    expect(await sql`SELECT updated_at FROM catalogue_watermark`).toEqual(revision);
    const early = await sql.reserve();
    const later = await sql.reserve();
    let committed = false;
    let pending: Promise<postgres.RowList<postgres.Row[]>> | undefined;
    try {
      await early`BEGIN`;
      await early`UPDATE bible_provider_resources SET recording_license_notice='contract recording',text_license_notice='contract text' WHERE id=${resource!.id}`;
      const [changed] = await early`SELECT updated_at FROM bibles WHERE abbreviation='BSB'`;
      const [connection] = await later`SELECT pg_backend_pid() AS pid`;
      pending =
        later`INSERT INTO books(code,eng_display_name) VALUES('contract-cursor','Contract cursor') RETURNING updated_at`.execute();
      await expect
        .poll(async () => {
          const [state] =
            await sql`SELECT cardinality(pg_blocking_pids(${connection!.pid})) AS count`;
          return Number(state!.count);
        })
        .toBeGreaterThan(0);
      await early`COMMIT`;
      committed = true;
      const [cursor] = await pending;
      expect((cursor!.updated_at as Date).getTime()).toBeGreaterThan(
        (changed!.updated_at as Date).getTime()
      );
      expect((await read())[0]!.updated_at).toEqual(changed!.updated_at);
    } finally {
      if (!committed) await early`ROLLBACK`;
      await pending?.catch(() => {});
      early.release();
      later.release();
    }
  });
  it.each(['resource', 'Bible'] as const)(
    'serializes a real chunked DBL facts transaction against a concurrent later %s writer',
    async (kind) => {
      const prefix = `contract-chunk-${kind}-`;
      await sql`INSERT INTO bible_provider_resources(provider,external_id,display_name,text_license_notice)
      SELECT 'dbl',${prefix} || n::text,'Before','Before' FROM generate_series(0,100) n`;
      for (const index of [0, 100]) {
        await sql`INSERT INTO bibles(language_id,name,abbreviation,text_resource_id)
        SELECT 1,${`${prefix}${index}`},${`${prefix}${index}`},id FROM bible_provider_resources WHERE provider='dbl' AND external_id=${`${prefix}${index}`}`;
      }
      const facts = Array.from({ length: 101 }, (_, index) => ({
        externalId: `${prefix}${index}`,
        displayName: 'After',
        textLicenseNotice: 'After',
        hasAudio: false,
      }));
      const later = await sql.reserve();
      let pending: Promise<postgres.RowList<postgres.Row[]>> | undefined;
      try {
        const result = await runInTransaction(async (tx) => {
          // Schedule at the actual 100-row chunk boundary. No artificial locks:
          // both chunks execute the production repository through its service.
          const first = await resources.upsertDblTextFacts(facts.slice(0, 100), 'unknown', tx);
          if (!first.ok) return first;
          const [connection] = await later`SELECT pg_backend_pid() AS pid`;
          pending = (
            kind === 'resource'
              ? later`UPDATE bible_provider_resources SET tts_license_status='forbidden' WHERE provider='dbl' AND external_id=${`${prefix}100`} RETURNING id`
              : later`UPDATE bibles SET name=${`${prefix}concurrent`},updated_at=next_catalogue_watermark() WHERE abbreviation=${`${prefix}100`} RETURNING id`
          ).execute();
          await expect
            .poll(async () => {
              const [state] =
                await sql`SELECT cardinality(pg_blocking_pids(${connection!.pid})) AS count`;
              return Number(state!.count);
            })
            .toBeGreaterThan(0);
          return resources.upsertDblTextFacts(facts.slice(100), 'unknown', tx);
        });
        expect(result).toMatchObject({ ok: true, data: { inserted: 0, updated: 1 } });
        await pending;
        const rows =
          await sql`SELECT text_license_notice,display_name,tts_license_status FROM bible_provider_resources WHERE external_id LIKE ${`${prefix}%`}`;
        expect(rows).toHaveLength(101);
        expect(
          rows.every((row) => row.text_license_notice === 'After' && row.display_name === 'After')
        ).toBe(true);
        const [last] =
          await sql`SELECT tts_license_status FROM bible_provider_resources WHERE external_id=${`${prefix}100`}`;
        expect(last!.tts_license_status).toBe(kind === 'resource' ? 'forbidden' : 'unknown');
        const revision = await sql`SELECT updated_at FROM catalogue_watermark`;
        expect(
          await runInTransaction((tx) => resources.upsertDblTextFacts(facts, 'unknown', tx))
        ).toMatchObject({ ok: true, data: { inserted: 0, updated: 0 } });
        expect(await sql`SELECT updated_at FROM catalogue_watermark`).toEqual(revision);
      } finally {
        await pending?.catch(() => {});
        later.release();
      }
    }
  );
}
