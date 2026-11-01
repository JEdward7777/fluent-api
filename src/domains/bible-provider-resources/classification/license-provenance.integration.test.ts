import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';
import { createTestSchema } from '@/db/testing/create-catalogue-schema';

import { attestLicenseArtifact } from '../license-artifact';
import {
  makeLicenseArtifact,
  makeLicenseNoteRefreshFixture,
  REVIEWER,
} from '../license-artifact.test-fixtures';
import { createLicenseClassifier } from '../license-classifier';
import { analyzeDatabaseLicenses } from './license-analysis';
import { createLicenseDatabaseAdapter } from './license-classifications.service';
import { licenseDatabaseProjection } from './license-database-projection';

const { client, database } = await vi.hoisted(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const client = new PGlite();
  return { client, database: drizzle(client) };
});
vi.mock('@/db', () => ({ db: database }));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));
beforeAll(async () => {
  await createTestSchema(client, {
    languages: schema.languages,
    bibles: schema.bibles,
    bible_provider_resources: schema.bible_provider_resources,
    license_classifications: schema.license_classifications,
    scriptDirectionEnum: schema.scriptDirectionEnum,
    bibleProviderEnum: schema.bibleProviderEnum,
    resourceProviderEnum: schema.resourceProviderEnum,
    ttsLicenseStatusEnum: schema.ttsLicenseStatusEnum,
  });
}, 30000);
beforeEach(async () => {
  await database.delete(schema.license_classifications);
});
afterAll(() => client.close());

describe('current database provenance refresh', () => {
  it.each([false, true])(
    'rejects a changed expected policy under the transaction lock before %s publication',
    async (replace) => {
      const adapter = createLicenseDatabaseAdapter();
      const artifact = makeLicenseArtifact();
      await adapter.apply(artifact, true, undefined, true);
      const expected = (await adapter.load()).classifications;
      const key = artifact.classifications[0].normalizedText;
      await database
        .update(schema.license_classifications)
        .set({ rationale: { text: 'External reviewer changed only rationale metadata' } })
        .where(eq(schema.license_classifications.normalizedText, key));
      const before = await database.select().from(schema.license_classifications);
      const publish = vi.fn();
      await expect(adapter.apply(artifact, replace, publish, true, expected)).rejects.toThrow(
        'policy changed since preview'
      );
      expect(publish).not.toHaveBeenCalled();
      expect(await database.select().from(schema.license_classifications)).toEqual(before);
    }
  );

  it('accepts an unchanged expected policy for changed-only maintenance', async () => {
    const adapter = createLicenseDatabaseAdapter();
    const artifact = makeLicenseArtifact();
    await adapter.apply(artifact, true, undefined, true);
    const expected = (await adapter.load()).classifications;
    const before = await database.select().from(schema.license_classifications);
    const publish = vi.fn();
    await adapter.apply(artifact, false, publish, false, expected);
    expect(publish).toHaveBeenCalledOnce();
    expect(await database.select().from(schema.license_classifications)).toEqual(before);
  });

  it('refuses a replacement when another row appeared after the full-table preview', async () => {
    const adapter = createLicenseDatabaseAdapter();
    const artifact = makeLicenseArtifact();
    await adapter.apply(artifact, true, undefined, true);
    const expected = (await adapter.load()).classifications;
    await database.insert(schema.license_classifications).values({
      normalizedText: 'new external policy key',
      status: 'forbidden',
      rationale: { text: 'Added by another reviewer' },
      classifiedBy: 'human',
    });
    const before = await database.select().from(schema.license_classifications);
    const publish = vi.fn();
    await expect(adapter.apply(artifact, true, publish, true, expected)).rejects.toThrow(
      'policy changed since preview'
    );
    expect(publish).not.toHaveBeenCalled();
    expect(await database.select().from(schema.license_classifications)).toEqual(before);
  });

  it('accepts an unchanged legacy null rationale as the exact expected database value', async () => {
    const adapter = createLicenseDatabaseAdapter();
    await database.insert(schema.license_classifications).values({
      normalizedText: 'legacy nullable rationale',
      status: 'unknown',
      rationale: null,
      classifiedBy: null,
    });
    const expected = (await adapter.load()).classifications;
    expect(expected[0].storedRationale).toBeNull();
    const before = await database.select().from(schema.license_classifications);
    const publish = vi.fn();
    await adapter.apply(makeLicenseArtifact(), false, publish, false, expected);
    expect(publish).toHaveBeenCalledOnce();
    expect(
      (await database.select().from(schema.license_classifications)).find(
        (row) => row.normalizedText === 'legacy nullable rationale'
      )
    ).toEqual(before[0]);
  });
  it('never lets stale JSON cleanup delete a current human note or churn authoritative row timestamps', async () => {
    const { stale, current, note } = makeLicenseNoteRefreshFixture();
    const adapter = createLicenseDatabaseAdapter();
    await adapter.apply(attestLicenseArtifact(current, REVIEWER), true);
    const before = await database.select().from(schema.license_classifications);
    const snapshot = await adapter.load();
    const transport = vi.fn();
    const classify = createLicenseClassifier({ apiKey: 'mock', transport });
    const input = {
      classifications: snapshot.classifications,
      catalog: [],
      classify,
      model: 'google:current',
      sampleCount: 3,
    };
    const withoutBase = await analyzeDatabaseLicenses(input);
    const withBase = await analyzeDatabaseLicenses({ ...input, base: stale });
    expect(licenseDatabaseProjection(withBase)).toEqual(licenseDatabaseProjection(withoutBase));
    expect(
      withBase.classifications.find(
        (row) => row.normalizedText === current.classifications[1].normalizedText
      )?.rowNote
    ).toBe(note);
    expect(withBase.attestation).toBeUndefined();
    await adapter.apply(withBase, false);
    expect(await database.select().from(schema.license_classifications)).toEqual(before);
    await adapter.apply(withoutBase, false);
    expect(await database.select().from(schema.license_classifications)).toEqual(before);
    expect(transport).not.toHaveBeenCalled();
  });
});
