import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';
import { createTestSchema } from '@/db/testing/create-catalogue-schema';

import { attestLicenseArtifact } from '../license-artifact';
import { makeLicenseNoteRefreshFixture, REVIEWER } from '../license-artifact.test-fixtures';
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
    resourceProviderEnum: schema.resourceProviderEnum,
    ttsLicenseStatusEnum: schema.ttsLicenseStatusEnum,
  });
}, 30000);
afterAll(() => client.close());

describe('current database provenance refresh', () => {
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
