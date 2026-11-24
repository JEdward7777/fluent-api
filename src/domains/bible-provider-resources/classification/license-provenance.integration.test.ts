import { eq } from 'drizzle-orm';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';
import { createTestSchema } from '@/db/testing/create-catalogue-schema';

import {
  attestLicenseArtifact,
  recordHumanLicenseDecision,
  serializeLicenseArtifact,
} from '../license-artifact';
import { ownedLicenseClassification } from '../license-artifact.hash';
import { parseStoredLicenseEvidence } from '../license-artifact.schemas';
import {
  makeLicenseArtifact,
  makeLicenseNoteRefreshFixture,
  REVIEWER,
} from '../license-artifact.test-fixtures';
import { createLicenseClassifier } from '../license-classifier';
import { normalizeLicenseNotice } from '../license-normalizer';
import { analyzeDatabaseLicenses } from './license-analysis';
import { createLicenseDatabaseAdapter } from './license-classifications.service';
import { makeCommandFixture } from './license-command.test-fixtures';
import { licenseDatabaseProjection } from './license-database-projection';
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

it('preserves inert sample, model and contract fields by identity through repeated JSON/DB writes', async () => {
  const adapter = createLicenseDatabaseAdapter();
  let artifact = makeLicenseArtifact();
  const original = artifact.classifications[1];
  const key = original.normalizedText;
  original.migrationExtensions = { schemaVersion: 3, fields: { reviewComment: { archive: true } } };
  original.evidenceContract = structuredClone(artifact.classificationRun);
  original.evidenceContract.archiveRef = 'contract archive';
  for (const model of original.evidenceContract.models.reverse()) model.archiveRef = model.model;
  for (const sample of original.samples.reverse())
    sample.archiveRef = [sample.provider, sample.model, sample.index];
  for (const year of [2024, 2025]) {
    artifact = parseLicenseArtifactBytes(serializeLicenseArtifact(artifact).bytes);
    artifact = recordHumanLicenseDecision(
      artifact,
      key,
      'unknown',
      { reviewComment: `Review ${year}` },
      'Named reviewer',
      `${year}-01-01T00:00:00.000Z`
    );
    await adapter.apply(artifact, true);
    const refreshed = await analyzeDatabaseLicenses({
      catalog: [],
      classifications: (await adapter.load()).classifications,
      classify: vi.fn(),
      model: 'google:current',
      sampleCount: 3,
    });
    artifact = parseLicenseArtifactBytes(serializeLicenseArtifact(refreshed).bytes);
    const hydrated = artifact.classifications.find((row) => row.normalizedText === key)!;
    expect(hydrated.migrationExtensions).toEqual(original.migrationExtensions);
    expect(hydrated.evidenceContract?.archiveRef).toBe('contract archive');
    for (const model of hydrated.evidenceContract!.models)
      expect(model.archiveRef).toBe(model.model);
    for (const sample of hydrated.samples)
      expect(sample.archiveRef).toEqual([sample.provider, sample.model, sample.index]);
  }
  const hydrated = artifact.classifications.find((row) => row.normalizedText === key)!;
  const envelope = licenseDatabaseProjection(artifact).find(
    (row) => row.normalizedText === key
  )!.rationale;
  const nested = envelope.nestedExtensions!;
  const sample = hydrated.samples[0];
  const model = hydrated.evidenceContract!.models[0];
  const sampleId = JSON.stringify([sample.provider, sample.model, sample.index]);
  const modelId = JSON.stringify([model.provider, model.model]);
  await database
    .update(schema.license_classifications)
    .set({
      rationale: {
        ...envelope,
        nestedExtensions: {
          samples: {
            ...nested.samples,
            [sampleId]: {
              archiveRef: 'new reference',
              index: 999,
              model: 'other',
              response: 'fake',
              requestHash: 'fake',
              attempts: 999,
            },
            dangling: { response: 'unmatched' },
          },
          models: {
            ...nested.models,
            [modelId]: {
              archiveRef: 'another reference',
              provider: 'other',
              sampleCount: 999,
              settings: {},
            },
          },
          contract: {
            archiveRef: 'other contract archive',
            promptHash: 'tampered',
            models: [],
            responseSchema: {},
          },
        },
      },
    })
    .where(eq(schema.license_classifications.normalizedText, key));
  const restored = (await adapter.load()).classifications.find(
    (row) => row.normalizedText === key
  )!.evidence!;
  expect(ownedLicenseClassification(restored)).toEqual(ownedLicenseClassification(hydrated));
  expect(restored.samples[0].archiveRef).toBe('new reference');
  expect(restored.samples[0].attempts).toBeUndefined();
  expect(restored.evidenceContract!.models[0].archiveRef).toBe('another reference');
  expect(restored.evidenceContract!.archiveRef).toBe('other contract archive');
});

it('exports exact raw notices and retains a column-only key without a witness through production inspect, analysis, report and save', async () => {
  const f = await makeCommandFixture(false);
  const adapter = createLicenseDatabaseAdapter();
  const workflow = new LicenseWorkflow(
    {
      ...f.options,
      source: 'database',
      destination: 'both',
      reportDir: f.dir,
      reportFormats: 'markdown,html',
    },
    { ...f.dependencies, database: async () => adapter }
  );
  try {
    const raw = ['Copyright © 2025 Example Publisher', 'Copy©right restrictions'];
    const keys = raw.map(normalizeLicenseNotice);
    expect(keys).toEqual(['example publisher', 'copyright restrictions']);
    const noExample = 'copyright archive';
    const since = new Date('2020-01-01T00:00:00.000Z');
    await database
      .insert(schema.languages)
      .values({ id: 27, langName: 'English', langCodeIso6393: 'eng' });
    for (const [index, notice] of raw.entries()) {
      const externalId = `raw-notice-${index}`;
      await database.insert(schema.bibles).values({
        languageId: 27,
        provider: 'dbl',
        externalId,
        name: externalId,
        abbreviation: `R${index}`,
      });
      await database
        .insert(schema.bible_provider_resources)
        .values({ provider: 'dbl', externalId, textLicenseNotice: notice });
    }
    await database.insert(schema.license_classifications).values(
      [...keys, noExample].map((normalizedText) => ({
        normalizedText,
        status: 'unknown' as const,
        rationale: 'Historic rationale',
        classifiedBy: 'archived',
        ...(normalizedText === noExample
          ? {}
          : {
              reviewState: 'human_reviewed' as const,
              reviewedBy: 'Original reviewer',
              decisionAt: since,
              humanReviewedAt: since,
            }),
      }))
    );
    const before = await database.select().from(schema.license_classifications);
    const inspected = await workflow.inspect(1);
    expect(
      inspected.preflight.rows.map((row) => [row.normalizedText, row.exampleNotice, row.action])
    ).toEqual([
      [noExample, null, 'retain'],
      [keys[1], raw[1], 'retain'],
      [keys[0], raw[0], 'retain'],
    ]);
    expect(inspected.preflight.expectedUncachedRequests).toBe(0);
    await workflow.startAnalysis(1);
    const preview = await workflow.preview(1, 1);
    expect(preview.plan.conflicts).toEqual([]);
    expect([...preview.plan.databaseChanges.unchanged].sort()).toEqual([...keys, noExample].sort());
    for (const report of preview.reports.reports) {
      expect(report.bytes).toContain('Original notice unavailable');
      expect(report.bytes).toContain(raw[0]);
      expect(report.bytes).toContain(raw[1]);
    }
    await workflow.save({
      operationId: 'notice-witnesses',
      configurationRevision: 1,
      contentRevision: 1,
      agreeToReplace: false,
    });
    const exported = parseLicenseArtifactBytes(JSON.stringify(await f.readOutput()));
    for (const [index, normalizedText] of keys.entries()) {
      expect(
        exported.classifications.find((row) => row.normalizedText === normalizedText)
      ).toMatchObject({
        exampleNotice: raw[index],
        reviewState: 'human_reviewed',
        reviewedBy: 'Original reviewer',
        decisionAt: since.toISOString(),
      });
    }
    const absent = exported.classifications.find((row) => row.normalizedText === noExample)!;
    expect(absent).toMatchObject({
      exampleNotice: null,
      reviewState: 'unreviewed',
      reviewedBy: null,
      decisionAt: null,
    });
    expect(
      licenseDatabaseProjection(exported).find((row) => row.normalizedText === noExample)?.rationale
        .evidenceVersion
    ).toBe(4);
    const encoded = licenseDatabaseProjection(exported).find(
      (row) => row.normalizedText === noExample
    )!.rationale;
    expect(parseStoredLicenseEvidence(encoded.evidence, undefined)).toBeUndefined();
    const {
      reviewState: _state,
      decisionAt: _decision,
      reviewedBy: _reviewer,
      humanReviewedAt: _humanAt,
      ...v2Evidence
    } = encoded.evidence;
    expect(parseStoredLicenseEvidence(v2Evidence, undefined)).toBeUndefined();
    const importPlan = planLicenseSaveDestinations({
      source: 'json',
      destination: 'database',
      artifact: {
        ...exported,
        classifications: exported.classifications.filter((row) => row.normalizedText !== noExample),
      },
      databaseRows: (await adapter.load()).classifications,
      outputBytes: null,
    });
    expect(importPlan.databaseChanges.preserved).toEqual([noExample]);
    expect(importPlan.databaseChanges.unchanged.sort()).toEqual(keys.toSorted());
    expect(
      parseLicenseArtifactBytes(
        serializeLicenseArtifact(importPlan.databaseForecast!).bytes
      ).classifications.find((row) => row.normalizedText === noExample)
    ).toEqual(absent);
    expect(await database.select().from(schema.license_classifications)).toEqual(before);
    expect(f.dependencies.transport).not.toHaveBeenCalled();

    const marked = recordHumanLicenseDecision(
      exported,
      noExample,
      'forbidden',
      {},
      'New reviewer',
      '2026-01-01T00:00:00.000Z'
    );
    const reverted = recordHumanLicenseDecision(
      marked,
      noExample,
      'unknown',
      {},
      'Next reviewer',
      '2026-02-01T00:00:00.000Z'
    );
    await adapter.apply(reverted, false);
    const saved = (await adapter.load()).classifications.find(
      (row) => row.normalizedText === noExample
    )!;
    const reloaded = await analyzeDatabaseLicenses({
      catalog: [],
      classifications: [saved],
      classify: vi.fn(),
      model: 'google:current',
      sampleCount: 3,
    });
    expect(
      parseLicenseArtifactBytes(serializeLicenseArtifact(reloaded).bytes).classifications[0]
    ).toMatchObject({
      source: 'manual',
      exampleNotice: null,
      reviewedBy: 'Next reviewer',
      status: 'unknown',
      automaticDecision: { source: 'table' },
      reviewHistory: [expect.objectContaining({ reviewedBy: 'New reviewer', status: 'forbidden' })],
    });
  } finally {
    await workflow.close();
    await f.cleanup();
  }
});

it.each([2, 3])(
  'loads the historical v%i empty-key table envelope without replacing its evidence or timestamps',
  async (version) => {
    const fixture = new URL(
      `../__fixtures__/license-artifact-v${version}-empty-example.json`,
      import.meta.url
    );
    const legacy = JSON.parse(await readFile(fixture, 'utf8'));
    const row = legacy.classifications[0];
    await database.insert(schema.license_classifications).values({
      normalizedText: row.normalizedText,
      status: row.status,
      classifiedBy: 'table',
      rationale: { text: row.rationale, evidence: row },
      reviewedAt: new Date(legacy.attestation.reviewedAt),
      ...(version === 3
        ? {
            reviewState: row.reviewState,
            reviewedBy: row.reviewedBy,
            decisionAt: new Date(row.decisionAt),
            humanReviewedAt: new Date(row.humanReviewedAt),
          }
        : {}),
    });
    const before = await database.select().from(schema.license_classifications);
    const adapter = createLicenseDatabaseAdapter();
    const snapshot = await adapter.load();
    expect(snapshot.classifications[0].evidence).toMatchObject(row);
    const exported = await analyzeDatabaseLicenses({
      catalog: [],
      classifications: snapshot.classifications,
      classify: vi.fn(),
      model: 'google:current',
      sampleCount: 3,
    });
    expect(exported.classifications[0]).toMatchObject(row);
    await adapter.apply(exported, false);
    expect(await database.select().from(schema.license_classifications)).toEqual(before);
  }
);
