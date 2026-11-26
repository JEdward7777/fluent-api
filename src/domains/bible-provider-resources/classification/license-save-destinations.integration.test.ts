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
import { makeCommandFixture } from './license-command.test-fixtures';
import { licenseSaveChanges } from './license-save-changes';
import { planLicenseSaveDestinations } from './license-save-destinations';
import { LicenseWorkflow } from './license-workflow';
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
  await database.delete(schema.bibles);
  await database.delete(schema.bible_provider_resources);
  await database.delete(schema.languages);
  await database.delete(schema.license_classifications);
});
afterAll(() => client.close());

describe('pGlite license persistence', () => {
  it('previews the exact database policy columns, including retained import data and legacy timestamps', async () => {
    const f = await makeCommandFixture(false);
    const adapter = createLicenseDatabaseAdapter();
    const workflow = new LicenseWorkflow(
      { ...f.options, destination: 'both' },
      {
        ...f.dependencies,
        destinationDatabase: async () => adapter,
      }
    );
    try {
      const row = f.artifact.classifications[1];
      const reviewedAt = new Date('2005-01-01T00:00:00Z');
      await database.insert(schema.license_classifications).values([
        {
          normalizedText: row.normalizedText,
          status: 'unknown',
          rationale: 'Prior policy',
          reviewedAt,
        },
        {
          normalizedText: 'destination only',
          status: 'unknown',
          rationale: null,
          classifiedBy: 'Legacy',
          reviewedAt,
        },
      ]);
      await workflow.inspect(1);
      const preview = await workflow.preview(1, workflow.status.contentRevision);
      const policy = licenseSaveChanges(preview, 'Test database').destinations.find(
        (d) => d.kind === 'Database'
      )!;
      const existing = policy.records.find((record) => record.key === 'destination only');
      expect(existing).toMatchObject({
        operation: 'Preserve',
        before: { rationale: null, reviewedAt: reviewedAt.toISOString() },
      });
      expect(existing?.before).toEqual(existing?.after);
      await workflow.save({
        operationId: 'column-parity',
        configurationRevision: 1,
        contentRevision: preview.contentRevision,
        previewToken: preview.token,
        agreeToReplace: false,
      });
      const physical = JSON.parse(
        JSON.stringify(await database.select().from(schema.license_classifications))
      );
      expect(physical).toHaveLength(policy.records.length);
      for (const record of policy.records)
        expect(physical).toContainEqual(expect.objectContaining(record.after!));
    } finally {
      await workflow.close();
      await f.cleanup();
    }
  });
  it('bootstraps mixed states, then exact repeat import is a no-op', async () => {
    const adapter = createLicenseDatabaseAdapter();
    const source = makeLicenseArtifact();
    const first = planLicenseSaveDestinations({
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

  it('retains full evidence with an offset event and treats equivalent UTC as unchanged', async () => {
    const adapter = createLicenseDatabaseAdapter();
    const base = makeLicenseArtifact();
    const key = base.classifications[0].normalizedText;
    const event = (date: string) =>
      recordHumanLicenseDecision(base, key, 'allowed', 'Reviewed', 'Named', date);
    const offset = event('2026-11-17T10:00:00.000+02:00');
    await adapter.apply(offset, true);
    const prior = (await adapter.load()).classifications;
    expect(prior.find((row) => row.normalizedText === key)?.evidence).toMatchObject({
      decisionAt: '2026-11-17T10:00:00.000+02:00',
      reviewedBy: 'Named',
    });
    for (const overwriteDatabase of [true, false]) {
      const plan = planLicenseSaveDestinations({
        destination: 'database',
        artifact: event('2026-11-17T08:00:00.000Z'),
        databaseRows: prior,
        outputBytes: null,
        overwriteDatabase,
      });
      expect(plan.conflicts).toEqual([]);
      expect(plan.databaseChanges.unchanged).toContain(key);
      expect(plan.databaseArtifact?.classifications).toEqual([]);
    }
  });

  it('publishes a null-notice source winner, preserves it against a weaker source and replays the physical DB row', async () => {
    const adapter = createLicenseDatabaseAdapter();
    const base = makeLicenseArtifact();
    await adapter.apply(base, true);
    const original = base.classifications[2];
    const externalId = 'null-notice-winner';
    await database
      .insert(schema.languages)
      .values({ id: 1, langName: 'English', langCodeIso6393: 'eng' });
    await database.insert(schema.bibles).values({
      languageId: 1,
      provider: 'dbl',
      externalId,
      name: 'Test Bible',
      abbreviation: 'TB',
    });
    await database
      .insert(schema.bible_provider_resources)
      .values({ provider: 'dbl', externalId, textLicenseNotice: original.exampleNotice });
    const candidate = recordHumanLicenseDecision(
      base,
      original.normalizedText,
      'allowed',
      { reviewComment: 'Authoritative terms' },
      'Named',
      '2026-11-17T08:00:00.000Z'
    );
    const winner = candidate.classifications[2];
    winner.exampleNotice = null;
    const plan = async (artifact: typeof base, overwriteDatabase: boolean) =>
      planLicenseSaveDestinations({
        destination: 'database',
        artifact,
        outputBytes: null,
        overwriteDatabase,
        databaseRows: (await adapter.load()).classifications,
      });
    const first = await plan(candidate, false);
    expect(first.databaseArtifact?.classifications).toEqual([winner]);
    await adapter.apply(first.databaseArtifact!, false);
    const actual = (await adapter.load()).classifications.find(
      (row) => row.normalizedText === winner.normalizedText
    )!;
    expect(actual.exampleNotice).toBe(original.exampleNotice);
    expect(actual.evidence).toMatchObject(winner);
    const before = await database.select().from(schema.license_classifications);
    for (const overwriteDatabase of [false, true]) {
      const repeat = await plan(candidate, overwriteDatabase);
      expect(repeat.conflicts).toEqual([]);
      expect(repeat.databaseChanges.unchanged).toContain(winner.normalizedText);
      expect(repeat.databaseArtifact?.classifications).toEqual([]);
      await adapter.apply(repeat.databaseArtifact!, overwriteDatabase);
    }
    const weaker = await plan(base, false);
    expect(weaker.databaseChanges.preserved).toContain(winner.normalizedText);
    expect(
      weaker.databaseForecast?.classifications.find(
        (row) => row.normalizedText === winner.normalizedText
      )
    ).toMatchObject(winner);
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
