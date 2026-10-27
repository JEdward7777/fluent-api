import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { canonicalBibles, canonicalResources } from '@/db/canonical-schema';
import * as schema from '@/db/schema';
import { seedBsbBibleTexts } from '@/db/seeds/bible-texts-bsb';
import { seedBibles } from '@/db/seeds/bibles';
import { contractCatalogFixture } from '@/db/testing/contract-catalog-fixture';
import { createTestSchema } from '@/db/testing/create-catalogue-schema';
import * as classifications from '@/domains/bible-provider-resources/classification/license-classifications.repository';
import * as bibles from '@/domains/bibles/bibles.repository';
import { getAllBibles, getBibleById } from '@/domains/bibles/bibles.service';
import { persistDblBibleCatalog } from '@/domains/bibles/sync/dbl-bible-sync';

const { client, database, queries } = await vi.hoisted(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const client = new PGlite();
  const queries: string[] = [];
  return {
    client,
    queries,
    database: drizzle(client, { logger: { logQuery: (query) => queries.push(query) } }),
  };
});
vi.mock('@/db', () => ({ db: database }));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
afterAll(() => client.close());

for (const contracted of [false, true])
  describe(contracted ? 'contracted physical catalog' : 'expanded physical catalog', () => {
    it('executes real CRUD, seeds, batch and classification reads using only canonical columns', async () => {
      await client.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
      await createTestSchema(client, {
        languages: schema.languages,
        books: schema.books,
        bible_books: schema.bible_books,
        bible_texts: schema.bible_texts,
        bibles: schema.bibles,
        bible_provider_resources: schema.bible_provider_resources,
        license_classifications: schema.license_classifications,
        scriptDirectionEnum: schema.scriptDirectionEnum,
        bibleProviderEnum: schema.bibleProviderEnum,
        resourceProviderEnum: schema.resourceProviderEnum,
        ttsLicenseStatusEnum: schema.ttsLicenseStatusEnum,
      });
      if (contracted) await contractCatalogFixture(client);
      await database.insert(schema.languages).values([
        { langName: 'English', langCodeIso6393: 'eng' },
        { langName: 'Gujarati', langCodeIso6393: 'guj' },
      ]);
      await database.insert(schema.books).values([
        { code: 'GEN', eng_display_name: 'Genesis' },
        { code: 'EXO', eng_display_name: 'Exodus' },
        { code: 'JHN', eng_display_name: 'John' },
      ]);
      queries.length = 0;
      await seedBibles();
      await seedBsbBibleTexts();
      const seedRows = await bibles.getAll();
      expect(seedRows.ok).toBe(true);
      if (!seedRows.ok) throw new Error('seed read failed');
      const unlinked = seedRows.data.find((row) => row.abbreviation === 'IRV');
      expect(unlinked).toMatchObject({
        textResourceId: null,
        externalId: null,
        provider: 'dbl',
        hasAudio: false,
      });
      const initial = await getAllBibles();
      expect(initial).toMatchObject({
        ok: true,
        data: expect.arrayContaining([
          expect.objectContaining({
            textBibleKey: 'dbl-bba9f40183526463-01',
            selectedRecordingKey: 'aq-1',
          }),
        ]),
      });
      for (const provider of ['dbl', 'aquifer', 'youversion'] as const) {
        const [resource] = await database
          .insert(canonicalResources)
          .values({
            provider,
            externalId: 'canonical',
            ttsLicenseStatus: 'forbidden',
            hasAudio: true,
          })
          .returning();
        const created = await bibles.create({
          languageId: 1,
          name: `${provider} canonical`,
          abbreviation: provider,
          textResourceId: resource.id,
          audioResourceId: seedRows.data.find((row) => row.abbreviation === 'BSB')!.audioResourceId,
        });
        expect(created).toMatchObject({
          ok: true,
          data: { provider, externalId: 'canonical', hasAudio: true, textResourceId: resource.id },
        });
        if (!created.ok) throw new Error('create failed');
        expect(
          await bibles.update(created.data.id, {
            textResourceId: resource.id,
            name: `${provider} canonical`,
          })
        ).toEqual(created);
        expect(await getBibleById(created.data.id)).toMatchObject({
          ok: true,
          data: { provider, hasAudio: true, ttsLicenseStatus: 'forbidden' },
        });
        if (!contracted) {
          const old = await client.query(
            'SELECT provider::text,external_id,has_audio FROM bibles WHERE id=$1',
            [created.data.id]
          );
          expect(old.rows[0]).toEqual({ provider, external_id: 'canonical', has_audio: true });
        }
        expect(await bibles.update(created.data.id, { textResourceId: null })).toMatchObject({
          ok: true,
          data: { textResourceId: null, provider: 'dbl', externalId: null, hasAudio: false },
        });
        expect(await getBibleById(created.data.id)).toMatchObject({
          ok: true,
          data: {
            provider: 'dbl',
            hasAudio: false,
            textBibleKey: null,
            ttsLicenseStatus: 'unknown',
            selectedRecordingKey: 'aq-1',
          },
        });
        if (!contracted) {
          const old = await client.query(
            'SELECT provider::text,external_id,has_audio,audio_resource_id FROM bibles WHERE id=$1',
            [created.data.id]
          );
          expect(old.rows[0]).toEqual({
            provider: 'dbl',
            external_id: null,
            has_audio: false,
            audio_resource_id: created.data.audioResourceId,
          });
        }
        expect(await bibles.remove(created.data.id)).toEqual({ ok: true, data: undefined });
      }
      const catalog = {
        totalBibles: 1,
        skippedMissingLanguage: 0,
        rows: [
          {
            languageId: 1,
            name: 'Batch',
            abbreviation: 'BATCH',
            provider: 'dbl' as const,
            externalId: 'batch',
            hasAudio: true,
            textLicenseNotice: 'Exact notice',
          },
        ],
      };
      expect(await persistDblBibleCatalog(catalog, 'allowed')).toMatchObject({
        ok: true,
        data: { inserted: 1 },
      });
      const before = await bibles.getAll();
      expect(await persistDblBibleCatalog(catalog, 'allowed')).toMatchObject({
        ok: true,
        data: { inserted: 0, updated: 0, licenseFacts: { inserted: 0, updated: 0 } },
      });
      expect(await bibles.getAll()).toEqual(before);
      const snapshot = await classifications.loadClassificationSnapshot();
      expect(snapshot.context.resources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ externalId: 'batch', rawNotice: 'Exact notice' }),
        ])
      );
      expect(
        snapshot.context.resources.some(
          (resource) => resource.provider === 'aquifer' && resource.externalId === '1'
        )
      ).toBe(false);
      const search = await bibles.searchSourceBibles('Batch');
      expect(search).toMatchObject({
        ok: true,
        data: { bibles: [expect.objectContaining({ provider: 'dbl', hasAudio: true })] },
      });
      expect(queries.join('\n')).not.toMatch(
        /"license_notice"|"bibles"\."(?:provider|external_id|has_audio)"/
      );
      const batch = await database
        .select()
        .from(canonicalBibles)
        .where(eq(canonicalBibles.abbreviation, 'BATCH'));
      expect(batch[0].textResourceId).not.toBeNull();
    }, 30_000);
  });
