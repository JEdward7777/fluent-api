import { eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';
import { createTestSchema } from '@/db/testing/create-catalogue-schema';

import { recordHumanLicenseDecision } from '../license-artifact';
import { LICENSE_CLASSIFICATIONS_PATH } from '../license-artifact.schemas';
import { makeLicenseArtifact } from '../license-artifact.test-fixtures';
import { createLicenseDatabaseAdapter } from './license-classifications.service';
import { planLicenseSaveDestinations } from './license-save-destinations';
import { parseLicenseArtifactBytes } from './license-workflow-freshness';

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

describe('pGlite license persistence', () => {
  it('bootstraps mixed states, then exact repeat import is a no-op', async () => {
    const adapter = createLicenseDatabaseAdapter();
    const source = makeLicenseArtifact();
    const first = planLicenseSaveDestinations({
      source: 'json',
      destination: 'database',
      artifact: source,
      outputBytes: null,
      databaseRows: [],
    });
    expect(first.databaseChanges.inserted).toHaveLength(3);
    await adapter.apply(first.databaseArtifact!, false);
    const snapshot = await adapter.load();
    expect(snapshot.classifications.map((row) => row.reviewState)).toEqual([
      'unreviewed',
      'llm_reviewed',
      'unreviewed',
    ]);
    expect(snapshot.classifications.every((row) => row.decisionAt === null)).toBe(true);
    const before = await database.select().from(schema.license_classifications);
    const repeat = planLicenseSaveDestinations({
      source: 'json',
      destination: 'database',
      artifact: source,
      outputBytes: null,
      databaseRows: snapshot.classifications,
    });
    expect(repeat.conflicts).toEqual([]);
    expect(repeat.databaseChanges.unchanged).toHaveLength(3);
    expect(repeat.databaseArtifact?.classifications).toHaveLength(0);
    await adapter.apply(
      repeat.databaseArtifact!,
      false,
      undefined,
      false,
      snapshot.classifications
    );
    expect(await database.select().from(schema.license_classifications)).toEqual(before);
  });

  it('writes a same-status named human review as owned metadata and rejects stale snapshots', async () => {
    const adapter = createLicenseDatabaseAdapter();
    const base = makeLicenseArtifact();
    await adapter.apply(base, true);
    const key = base.classifications[2].normalizedText;
    const legacyReviewedAt = new Date('2025-01-01T00:00:00.000Z');
    await database
      .update(schema.license_classifications)
      .set({ reviewedAt: legacyReviewedAt })
      .where(eq(schema.license_classifications.normalizedText, key));
    const before = await adapter.load();
    const reviewed = recordHumanLicenseDecision(
      base,
      key,
      'unknown',
      'Confirmed unresolved terms',
      'Reviewer',
      '2026-11-17T12:00:00.000Z'
    );
    const plan = planLicenseSaveDestinations({
      source: 'json',
      destination: 'database',
      artifact: reviewed,
      outputBytes: null,
      databaseRows: before.classifications,
    });
    expect(plan.databaseChanges.updated).toContain(key);
    await adapter.apply(plan.databaseArtifact!, false, undefined, false, before.classifications);
    const after = await adapter.load();
    const row = after.classifications.find((entry) => entry.normalizedText === key)!;
    expect(row).toMatchObject({
      reviewState: 'human_reviewed',
      reviewedBy: 'Reviewer',
      decisionAt: '2026-11-17T12:00:00.000Z',
      humanReviewedAt: '2026-11-17T12:00:00.000Z',
    });
    expect(row.reviewedAt).toBe(legacyReviewedAt.toISOString());
    await expect(
      adapter.apply(plan.databaseArtifact!, false, undefined, false, before.classifications)
    ).rejects.toThrow('policy changed since preview');
  });

  it('imports a copied legacy candidate and replays all 523 rows without changing its source bytes', async () => {
    const original = await readFile(LICENSE_CLASSIFICATIONS_PATH);
    const digest = createHash('sha256').update(original).digest('hex');
    const artifact = parseLicenseArtifactBytes(original.toString('utf8'));
    expect(artifact.classifications).toHaveLength(523);
    const adapter = createLicenseDatabaseAdapter();
    const first = planLicenseSaveDestinations({
      source: 'json',
      destination: 'database',
      artifact,
      outputBytes: null,
      databaseRows: [],
    });
    expect(first.conflicts).toEqual([]);
    await adapter.apply(first.databaseArtifact!, false);
    const snapshot = await adapter.load();
    expect(snapshot.classifications).toHaveLength(523);
    expect(
      snapshot.classifications.filter((row) => row.reviewState === 'llm_reviewed')
    ).toHaveLength(300);
    const replay = planLicenseSaveDestinations({
      source: 'json',
      destination: 'database',
      artifact,
      outputBytes: null,
      databaseRows: snapshot.classifications,
    });
    expect(replay.conflicts).toEqual([]);
    expect(replay.databaseChanges.unchanged).toHaveLength(523);
    expect(replay.databaseArtifact?.classifications).toHaveLength(0);
    expect(
      createHash('sha256')
        .update(await readFile(LICENSE_CLASSIFICATIONS_PATH))
        .digest('hex')
    ).toBe(digest);
  });
});
