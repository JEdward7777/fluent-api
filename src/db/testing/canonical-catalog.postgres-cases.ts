import type postgres from 'postgres';

import { expect, it } from 'vitest';

import { seedBsbBibleTexts } from '@/db/seeds/bible-texts-bsb';
import { seedBibles } from '@/db/seeds/bibles';
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
      } else await contractCatalogFixture({ exec: (query) => sql.unsafe(query) });
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
}
