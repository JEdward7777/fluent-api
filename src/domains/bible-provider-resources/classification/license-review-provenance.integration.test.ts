import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';
import { createTestSchema } from '@/db/testing/create-catalogue-schema';

import {
  recordAnonymousLicenseNote,
  recordHumanLicenseDecision,
  serializeLicenseArtifact,
} from '../license-artifact';
import { ownedLicenseClassification } from '../license-artifact.hash';
import { makeLicenseArtifact } from '../license-artifact.test-fixtures';
import { analyzeDatabaseLicenses } from './license-analysis';
import { createLicenseDatabaseAdapter } from './license-classifications.service';
import { licenseDatabaseProjection } from './license-database-projection';
import { inspectLicensePreflight } from './license-preflight';
import { planLicenseSaveDestinations } from './license-save-destinations';
import { parseLicenseArtifactBytes } from './license-workflow-freshness';

const { client, database, targetClient, targetDatabase, connection } = await vi.hoisted(
  async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const { drizzle } = await import('drizzle-orm/pglite');
    const client = new PGlite();
    const targetClient = new PGlite();
    const database = drizzle(client);
    return {
      client,
      database,
      targetClient,
      targetDatabase: drizzle(targetClient),
      connection: { active: database },
    };
  }
);
vi.mock('@/db', () => ({
  get db() {
    return connection.active;
  },
}));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));
beforeAll(async () => {
  const tables = {
    languages: schema.languages,
    bibles: schema.bibles,
    bible_provider_resources: schema.bible_provider_resources,
    license_classifications: schema.license_classifications,
    scriptDirectionEnum: schema.scriptDirectionEnum,
    bibleProviderEnum: schema.bibleProviderEnum,
    resourceProviderEnum: schema.resourceProviderEnum,
    ttsLicenseStatusEnum: schema.ttsLicenseStatusEnum,
  };
  await createTestSchema(client, tables);
  await createTestSchema(targetClient, tables);
}, 30000);
beforeEach(async () => {
  connection.active = database;
  await database.delete(schema.license_classifications);
  await targetDatabase.delete(schema.license_classifications);
});
afterAll(async () => {
  await client.close();
  await targetClient.close();
});

describe('physical database review provenance', () => {
  const first = '2020-01-01T00:00:00.000Z';
  const second = '2021-01-01T00:00:00.000Z';
  const newest = '2026-01-01T00:00:00.000Z';
  const refresh = (
    classifications: Awaited<
      ReturnType<ReturnType<typeof createLicenseDatabaseAdapter>['load']>
    >['classifications']
  ) =>
    analyzeDatabaseLicenses({
      catalog: [],
      classifications,
      classify: vi.fn(),
      model: 'google:current',
      sampleCount: 3,
    });

  it.each(['absent', 'stale'] as const)(
    'preserves a column-only human winner with %s JSON evidence in both directions',
    async (kind) => {
      const adapter = createLicenseDatabaseAdapter();
      const modelArtifact = makeLicenseArtifact();
      const model = modelArtifact.classifications[1];
      model.decisionAt = newest;
      const key = model.normalizedText;
      const text = 'Original table rationale';
      const source = licenseDatabaseProjection(modelArtifact)[1];
      await database.insert(schema.license_classifications).values({
        normalizedText: key,
        status: 'unknown',
        rationale: kind === 'absent' ? text : { ...source.rationale, text },
        classifiedBy: 'historic authority',
        reviewState: 'human_reviewed',
        reviewedBy: 'Original reviewer',
        decisionAt: new Date(first),
        humanReviewedAt: new Date(first),
      });
      const before = await database.select().from(schema.license_classifications);
      const snapshot = await adapter.load();
      expect(snapshot.classifications[0].evidence).toBeUndefined();
      const inspected = await inspectLicensePreflight({
        database: snapshot,
        noCache: true,
        sampleCount: 3,
        model: 'google:current',
      });
      expect(inspected.rows[0].action).toBe('retain');
      const retained = await refresh(snapshot.classifications);
      const winner = retained.classifications[0];
      expect(winner).toEqual({
        normalizedText: key,
        exampleNotice: null,
        status: 'unknown',
        rationale: text,
        source: 'table',
        samples: [],
        reviewState: 'human_reviewed',
        reviewedBy: 'Original reviewer',
        decisionAt: first,
        humanReviewedAt: first,
      });
      const toJson = planLicenseSaveDestinations({
        overwriteDatabase: true,
        destination: 'both',
        artifact: retained,
        outputBytes: serializeLicenseArtifact(modelArtifact).bytes,
        databaseRows: snapshot.classifications,
      });
      expect(toJson.conflicts).toEqual([]);
      expect(toJson.jsonChanges.updated).toContain(key);
      expect(
        toJson.jsonArtifact?.classifications.find((row) => row.normalizedText === key)
      ).toEqual(winner);
      expect(toJson.databaseChanges.unchanged).toEqual([key]);
      await adapter.apply(toJson.databaseArtifact!, true);
      expect(await database.select().from(schema.license_classifications)).toEqual(before);
      const toDb = planLicenseSaveDestinations({
        destination: 'database',
        artifact: modelArtifact,
        outputBytes: null,
        databaseRows: snapshot.classifications,
      });
      expect(toDb.databaseChanges.preserved).toContain(key);
      expect(
        toDb.databaseForecast?.classifications.find((row) => row.normalizedText === key)
      ).toEqual(winner);
      await adapter.apply(toDb.databaseArtifact!, false);
      const [after] = await database
        .select()
        .from(schema.license_classifications)
        .where(eq(schema.license_classifications.normalizedText, key));
      expect(after).toEqual(before[0]);
    }
  );

  it('round-trips exact authored history, notes, model evidence and absent manual explanation through PostgreSQL and JSON', async () => {
    const adapter = createLicenseDatabaseAdapter();
    const base = makeLicenseArtifact();
    const key = base.classifications[1].normalizedText;
    let draft = recordHumanLicenseDecision(
      base,
      key,
      'unknown',
      { reviewComment: 'First comment' },
      'First reviewer',
      first
    );
    draft = recordAnonymousLicenseNote(draft, key, 'Anonymous note');
    draft = recordAnonymousLicenseNote(draft, key, 'Another note');
    draft = recordHumanLicenseDecision(draft, key, 'forbidden', {}, 'Next reviewer', second);
    const original = draft.classifications[1];
    expect(original.reviewHistory?.[0]).toMatchObject({
      reviewedBy: 'First reviewer',
      reviewComment: 'First comment',
      rowNote: 'Another note',
      rowNoteProvenance: { priorAnonymousNotes: ['Anonymous note'], author: null },
    });
    await adapter.apply(draft, false);
    const [physical] = await database
      .select()
      .from(schema.license_classifications)
      .where(eq(schema.license_classifications.normalizedText, key));
    expect(physical.rationale).toMatchObject({
      text: 'Human-reviewed decision',
      evidenceVersion: 4,
      evidence: {
        rationale: '',
        reviewHistory: original.reviewHistory,
        automaticDecision: original.automaticDecision,
      },
    });
    const snapshot = await adapter.load();
    const retained = await refresh(snapshot.classifications);
    const serialized = parseLicenseArtifactBytes(serializeLicenseArtifact(retained).bytes);
    const hydrated = serialized.classifications.find((row) => row.normalizedText === key)!;
    expect(hydrated.reviewComment).toBeUndefined();
    expect(ownedLicenseClassification(hydrated)).toEqual(
      ownedLicenseClassification({ ...original, evidenceContract: draft.classificationRun })
    );
    const replay = planLicenseSaveDestinations({
      destination: 'database',
      artifact: serialized,
      outputBytes: null,
      databaseRows: snapshot.classifications,
    });
    expect(replay.conflicts).toEqual([]);
    expect(replay.databaseChanges.unchanged).toContain(key);
    const commented = recordHumanLicenseDecision(
      serialized,
      key,
      'allowed',
      { reviewComment: 'Current comment' },
      'Last reviewer',
      newest
    );
    await adapter.apply(commented, false);
    const restored = (await refresh((await adapter.load()).classifications)).classifications.find(
      (row) => row.normalizedText === key
    )!;
    expect(restored).toMatchObject({
      reviewComment: 'Current comment',
      rationale: '',
      reviewedBy: 'Last reviewer',
      reviewHistory: [
        ...original.reviewHistory!,
        expect.objectContaining({
          reviewedBy: 'Next reviewer',
          reviewComment: null,
          rationale: null,
        }),
      ],
    });
  });

  it.each([2, 3] as const)(
    'reads an original unversioned v%i database envelope without rewriting an untouched row',
    async (version) => {
      const adapter = createLicenseDatabaseAdapter();
      const artifact = makeLicenseArtifact();
      const key = artifact.classifications[1].normalizedText;
      const manual = recordHumanLicenseDecision(
        artifact,
        key,
        'unknown',
        'Historic override',
        'Original reviewer',
        first
      );
      const projected = licenseDatabaseProjection(manual)[1];
      const { reviewState, decisionAt, reviewedBy, humanReviewedAt, ...oldEvidence } =
        projected.rationale.evidence;
      const collision = { historical: true };
      const evidence = {
        ...oldEvidence,
        ...(version === 3 ? { reviewState, decisionAt, reviewedBy, humanReviewedAt } : {}),
        reviewComment: collision,
        reviewHistory: 'old extension',
        rowNote: 'Historic note',
      };
      await database.insert(schema.license_classifications).values({
        normalizedText: key,
        status: 'unknown',
        classifiedBy: 'human',
        rationale: {
          text: 'Historic override',
          evidence,
          classificationRun: projected.rationale.classificationRun!,
        },
        reviewedAt: new Date(newest),
        ...(version === 3
          ? {
              reviewState,
              decisionAt: new Date(first),
              reviewedBy,
              humanReviewedAt: new Date(first),
            }
          : {}),
      });
      const [before] = await database.select().from(schema.license_classifications);
      const snapshot = await adapter.load();
      const retained = await refresh(snapshot.classifications);
      expect(retained.classifications[0]).toMatchObject({
        rationale: 'Historic override',
        rowNote: 'Historic note',
        source: 'manual',
        reviewState: version === 2 ? 'llm_reviewed' : 'human_reviewed',
        reviewedBy: version === 2 ? null : 'Original reviewer',
        humanReviewedAt: version === 2 ? null : first,
        decisionAt: version === 2 ? null : first,
        automaticDecision: { source: 'gemini' },
        migrationExtensions: {
          schemaVersion: version,
          fields: { reviewComment: collision, reviewHistory: 'old extension' },
        },
      });
      expect(retained.classifications[0].reviewHistory).toBeUndefined();
      expect(retained.classifications[0].reviewComment).toBeUndefined();
      expect(retained.classifications[0].samples).toHaveLength(6);
      await adapter.apply(
        {
          ...retained,
          classifications: [...retained.classifications, artifact.classifications[2]],
        },
        true
      );
      const [after] = await database
        .select()
        .from(schema.license_classifications)
        .where(eq(schema.license_classifications.normalizedText, key));
      expect(after).toEqual(before);

      const extensions = retained.classifications[0].migrationExtensions;
      let next = retained;
      for (const note of ['First edit', 'Second edit']) {
        next = recordAnonymousLicenseNote(next, key, note);
        await adapter.apply(next, true);
        const saved = (await adapter.load()).classifications;
        const persisted = saved.find((row) => row.normalizedText === key)!;
        expect(persisted.storedRationale).toMatchObject({
          evidenceVersion: 4,
          extensions: { migrationExtensions: extensions },
        });
        expect(persisted.evidence?.migrationExtensions).toEqual(extensions);
        expect(persisted.evidence?.reviewComment).toBeUndefined();
        expect(persisted.evidence?.reviewHistory).toBeUndefined();
        next = await refresh(saved);
      }

      const exported = parseLicenseArtifactBytes(serializeLicenseArtifact(next).bytes);
      connection.active = targetDatabase;
      const empty = await adapter.load();
      expect(empty.classifications).toEqual([]);
      const transfer = planLicenseSaveDestinations({
        destination: 'database',
        artifact: exported,
        outputBytes: null,
        databaseRows: empty.classifications,
      });
      expect(transfer.databaseChanges.inserted).toContain(key);
      await adapter.apply(transfer.databaseArtifact!, false);
      const target = (await adapter.load()).classifications.find(
        (row) => row.normalizedText === key
      )!;
      expect(target.evidence?.migrationExtensions).toEqual(extensions);
      expect(target.evidence?.reviewComment).toBeUndefined();
      expect(target.evidence?.reviewHistory).toBeUndefined();
      expect(target.evidence?.rowNote).toBe('Second edit');

      const envelope = licenseDatabaseProjection(exported).find(
        (row) => row.normalizedText === key
      )!.rationale;
      await targetDatabase
        .update(schema.license_classifications)
        .set({
          rationale: {
            ...envelope,
            extensions: {
              ...envelope.extensions,
              reviewState: 'human_reviewed',
              reviewedBy: 'Injected identity',
              reviewComment: 'Injected comment',
              status: 'allowed',
              source: 'manual',
              ...JSON.parse('{"__proto__":{"safe":true}}'),
            },
          },
        })
        .where(eq(schema.license_classifications.normalizedText, key));
      const ignored = (await adapter.load()).classifications.find(
        (row) => row.normalizedText === key
      )!.evidence!;
      expect(ownedLicenseClassification(ignored)).toEqual(
        ownedLicenseClassification(target.evidence!)
      );
      expect(Object.hasOwn(ignored, '__proto__')).toBe(true);
      expect(Object.hasOwn(Object.prototype, 'safe')).toBe(false);
    }
  );

  it('keeps an absent history physically untouched when JSON supplies an empty history and unrelated extensions', async () => {
    const adapter = createLicenseDatabaseAdapter();
    const artifact = makeLicenseArtifact();
    await adapter.apply(artifact, false);
    const before = await database.select().from(schema.license_classifications);
    const key = artifact.classifications[0].normalizedText;
    artifact.classifications[0].reviewHistory = [];
    artifact.classifications[0].unownedExtension = { ignoreForComparison: true };
    const snapshot = await adapter.load();
    const plan = planLicenseSaveDestinations({
      overwriteDatabase: true,
      destination: 'database',
      artifact,
      outputBytes: null,
      databaseRows: snapshot.classifications,
    });
    expect(plan.databaseChanges.unchanged).toContain(key);
    expect(plan.databaseChanges.updated).toEqual([]);
    await adapter.apply(plan.databaseArtifact!, true);
    expect(await database.select().from(schema.license_classifications)).toEqual(before);
  });

  it.each([
    {
      reviewState: 'llm_reviewed' as const,
      reviewedBy: null,
      decisionAt: null,
      humanReviewedAt: null,
      error: 'complete model evidence',
    },
    {
      reviewState: 'human_reviewed' as const,
      reviewedBy: null,
      decisionAt: first,
      humanReviewedAt: first,
      error: 'named reviewer',
    },
    {
      reviewState: 'human_reviewed' as const,
      reviewedBy: '   ',
      decisionAt: first,
      humanReviewedAt: first,
      error: 'Must not be blank',
    },
    {
      reviewState: 'human_reviewed' as const,
      reviewedBy: 'Reviewer',
      decisionAt: first,
      humanReviewedAt: null,
      error: 'matching event time',
    },
    {
      reviewState: 'human_reviewed' as const,
      reviewedBy: 'Reviewer',
      decisionAt: null,
      humanReviewedAt: first,
      error: 'matching event time',
    },
  ])(
    'rejects incomplete or blank column review metadata before preflight, analysis or save (%#)',
    async (test) => {
      const artifact = makeLicenseArtifact();
      const adapter = createLicenseDatabaseAdapter();
      await database.insert(schema.license_classifications).values({
        normalizedText: 'column-only',
        status: 'allowed',
        rationale: 'Stored text',
        reviewState: test.reviewState,
        reviewedBy: test.reviewedBy,
        decisionAt: test.decisionAt ? new Date(test.decisionAt) : null,
        humanReviewedAt: test.humanReviewedAt ? new Date(test.humanReviewedAt) : null,
      });
      const snapshot = await adapter.load();
      await expect(
        inspectLicensePreflight({
          database: snapshot,
          noCache: true,
          model: 'google:current',
          sampleCount: 3,
        })
      ).rejects.toThrow(test.error);
      await expect(refresh(snapshot.classifications)).rejects.toThrow(test.error);
      expect(() =>
        planLicenseSaveDestinations({
          destination: 'database',
          artifact,
          outputBytes: null,
          databaseRows: snapshot.classifications,
        })
      ).toThrow(test.error);
    }
  );
});
