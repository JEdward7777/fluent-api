import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it, vi } from 'vitest';

import type { DemoCtx } from '@/db/seeds/demo/context';

import { canonicalBibles, canonicalResources } from '@/db/canonical-schema';
import { seedBsbBibleTexts } from '@/db/seeds/bible-texts-bsb';
import { seedBibles } from '@/db/seeds/bibles';
import { seedSpecBibles } from '@/db/seeds/demo/bibles';
import { loadDblSeedExternalIds } from '@/db/seeds/demo/ingest';
import { contractCatalogFixture } from '@/db/testing/contract-catalog-fixture';
import { createTestSchema } from '@/db/testing/create-catalogue-schema';
import * as schema from '@/db/testing/expanded-catalog-schema';
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
      await database.insert(canonicalResources).values({
        provider: 'dbl',
        externalId: 'a3644a98420c2703-01',
        hasAudio: false,
        ttsLicenseStatus: 'forbidden',
      });
      await seedBibles();
      await seedBsbBibleTexts();
      const [irvBefore] = await database
        .select()
        .from(canonicalBibles)
        .where(eq(canonicalBibles.abbreviation, 'IRV'));
      const [irvNewResource] = await database
        .select()
        .from(canonicalResources)
        .where(eq(canonicalResources.id, irvBefore.textResourceId!));
      expect(irvNewResource).toMatchObject({ hasAudio: true, ttsLicenseStatus: 'forbidden' });
      await database
        .update(canonicalBibles)
        .set({ audioResourceId: null })
        .where(eq(canonicalBibles.id, irvBefore.id));
      await database
        .update(canonicalResources)
        .set({ hasAudio: false, ttsLicenseStatus: 'forbidden' })
        .where(eq(canonicalResources.id, irvBefore.textResourceId!));
      await seedBibles();
      const [irvFilled] = await database
        .select()
        .from(canonicalResources)
        .where(eq(canonicalResources.id, irvBefore.textResourceId!));
      const [irvLinked] = await database
        .select()
        .from(canonicalBibles)
        .where(eq(canonicalBibles.id, irvBefore.id));
      expect(irvFilled).toMatchObject({ hasAudio: true, ttsLicenseStatus: 'forbidden' });
      expect(irvLinked.audioResourceId).toBe(irvBefore.audioResourceId);
      await database
        .update(canonicalResources)
        .set({ hasAudio: false })
        .where(eq(canonicalResources.id, irvBefore.textResourceId!));
      await seedBibles();
      const [irvCurated] = await database
        .select()
        .from(canonicalResources)
        .where(eq(canonicalResources.id, irvBefore.textResourceId!));
      expect(irvCurated.hasAudio).toBe(false);
      await database
        .update(canonicalResources)
        .set({ hasAudio: true })
        .where(eq(canonicalResources.id, irvBefore.textResourceId!));
      const demoCtx: DemoCtx = {
        spec: {
          organizations: [],
          users: [],
          projects: [],
          bibles: [
            {
              abbreviation: 'DEMO',
              name: 'Demo canonical Bible',
              language: 'eng',
              externalId: 'demo-text',
              audioExternalId: 'demo-audio',
              hasAudio: true,
              books: ['JHN'],
            },
          ],
        },
        grantPlan: [],
        orgs: new Map(),
        users: new Map(),
        projects: new Map(),
        milestones: new Map(),
        languages: new Map([['eng', 1]]),
        bibles: new Map(),
        books: new Map(),
        pericopeSets: new Map(),
        roles: new Map(),
      };
      await database.insert(canonicalResources).values({
        provider: 'dbl',
        externalId: 'demo-text',
        hasAudio: false,
        ttsLicenseStatus: 'forbidden',
      });
      await seedSpecBibles(demoCtx);
      const demoId = demoCtx.bibles.get('DEMO')!;
      const [demo] = await database
        .select()
        .from(canonicalBibles)
        .where(eq(canonicalBibles.id, demoId));
      expect(await loadDblSeedExternalIds([demoId])).toEqual(new Map([[demoId, 'demo-text']]));
      expect(demo.textResourceId).not.toBeNull();
      expect(demo.audioResourceId).not.toBeNull();
      const [demoNewResource] = await database
        .select()
        .from(canonicalResources)
        .where(eq(canonicalResources.id, demo.textResourceId!));
      expect(demoNewResource).toMatchObject({ hasAudio: true, ttsLicenseStatus: 'forbidden' });
      await database
        .update(canonicalResources)
        .set({ hasAudio: false, ttsLicenseStatus: 'forbidden' })
        .where(eq(canonicalResources.id, demo.textResourceId!));
      await seedSpecBibles(demoCtx);
      const [curated] = await database
        .select()
        .from(canonicalResources)
        .where(eq(canonicalResources.id, demo.textResourceId!));
      expect(curated).toMatchObject({ hasAudio: false, ttsLicenseStatus: 'forbidden' });
      await database
        .update(canonicalBibles)
        .set({ audioResourceId: null })
        .where(eq(canonicalBibles.id, demoId));
      await seedSpecBibles(demoCtx);
      const [demoFilled] = await database
        .select()
        .from(canonicalResources)
        .where(eq(canonicalResources.id, demo.textResourceId!));
      const [demoLinked] = await database
        .select()
        .from(canonicalBibles)
        .where(eq(canonicalBibles.id, demoId));
      expect(demoFilled).toMatchObject({ hasAudio: true, ttsLicenseStatus: 'forbidden' });
      expect(demoLinked.audioResourceId).toBe(demo.audioResourceId);
      await seedSpecBibles(demoCtx);
      const [demoRerun] = await database
        .select()
        .from(canonicalResources)
        .where(eq(canonicalResources.id, demo.textResourceId!));
      expect(demoRerun).toEqual(demoFilled);
      await database
        .update(canonicalBibles)
        .set({ audioResourceId: null })
        .where(eq(canonicalBibles.id, demoId));
      const noExternalIdCtx: DemoCtx = {
        ...demoCtx,
        spec: {
          ...demoCtx.spec,
          bibles: [
            {
              abbreviation: 'DEMO',
              name: 'Demo canonical Bible',
              language: 'eng',
              hasAudio: false,
              audioExternalId: 'demo-audio',
            },
          ],
        },
      };
      await seedSpecBibles(noExternalIdCtx);
      const [withoutExternalId] = await database
        .select()
        .from(canonicalResources)
        .where(eq(canonicalResources.id, demo.textResourceId!));
      const [relinked] = await database
        .select()
        .from(canonicalBibles)
        .where(eq(canonicalBibles.id, demoId));
      expect(withoutExternalId).toMatchObject({ hasAudio: false, ttsLicenseStatus: 'forbidden' });
      expect(relinked.audioResourceId).toBe(demo.audioResourceId);
      await seedSpecBibles(demoCtx);
      const [stillCurated] = await database
        .select()
        .from(canonicalResources)
        .where(eq(canonicalResources.id, demo.textResourceId!));
      expect(stillCurated).toEqual(withoutExternalId);
      const seedRows = await bibles.getAll();
      expect(seedRows.ok).toBe(true);
      if (!seedRows.ok) throw new Error('seed read failed');
      const irv = seedRows.data.find((row) => row.abbreviation === 'IRV');
      expect(irv).toMatchObject({
        textResourceId: expect.any(Number),
        externalId: 'a3644a98420c2703-01',
        provider: 'dbl',
        hasAudio: true,
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
      const [foreign] = await database
        .insert(canonicalResources)
        .values({ provider: 'aquifer', externalId: 'foreign-bsb' })
        .returning();
      const [bareBsb] = await database
        .select()
        .from(canonicalBibles)
        .where(eq(canonicalBibles.abbreviation, 'BSB'));
      await database
        .update(canonicalBibles)
        .set({ textResourceId: foreign.id })
        .where(eq(canonicalBibles.id, bareBsb.id));
      await seedBibles();
      await seedBsbBibleTexts();
      const [preserved] = await database
        .select()
        .from(canonicalBibles)
        .where(eq(canonicalBibles.id, bareBsb.id));
      expect(preserved.textResourceId).toBe(foreign.id);
      expect(await loadDblSeedExternalIds([bareBsb.id])).toEqual(new Map([[bareBsb.id, null]]));
      const [adopted] = await database
        .select()
        .from(canonicalBibles)
        .where(eq(canonicalBibles.abbreviation, 'BSB-bba9f4'));
      expect(adopted.textResourceId).toBe(bareBsb.textResourceId);
      const seededVerse = await database
        .select({ id: schema.bible_texts.id })
        .from(schema.bible_texts)
        .where(eq(schema.bible_texts.bibleId, adopted.id))
        .limit(1);
      expect(seededVerse).toHaveLength(1);
    }, 30_000);
  });
