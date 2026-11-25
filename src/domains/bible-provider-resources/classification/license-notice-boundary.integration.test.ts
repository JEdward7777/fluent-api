import { writeFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';
import { createTestSchema } from '@/db/testing/create-catalogue-schema';

import emptyManual from '../__fixtures__/license-artifact-v3-empty-manual.json';
import historical from '../__fixtures__/license-notice-historical-hashes.json';
import {
  createLicenseArtifact,
  recordHumanLicenseDecision,
  serializeLicenseArtifact,
} from '../license-artifact';
import { ownedLicenseClassification } from '../license-artifact.hash';
import { parseLicenseArtifact } from '../license-artifact.schemas';
import { createLicenseClassifier } from '../license-classifier';
import { buildLicenseSampleRequest } from '../license-model-contract';
import {
  noticeBoundaryInput,
  noticeForms,
  noticeMatrixSigner,
  producers,
} from '../license-notice-boundary.test-fixtures';
import { analyzeDatabaseLicenses, analyzeJsonLicenses } from './license-analysis';
import { createLicenseDatabaseAdapter } from './license-classifications.service';
import { makeCommandFixture } from './license-command.test-fixtures';
import { licenseDatabaseProjection } from './license-database-projection';
import { licenseKeyDigest } from './license-eligibility';
import { inspectLicensePreflight } from './license-preflight';
import { storedLicenseDecision } from './license-stored-decision';
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

describe.each(producers)('%s notice compatibility', (producer) => {
  it.each([noticeForms.empty, noticeForms.ordinary])(
    'keeps an unavailable original distinct for the key from %j',
    async (example) => {
      const input = noticeBoundaryInput(producer, example, 4);
      if (input.classifications[0].normalizedText !== '') {
        input.classifications[0].exampleNotice = '';
        expect(() => createLicenseArtifact(input)).toThrow(
          'Classification key does not match exact notice normalization'
        );
      }
      input.classifications[0].exampleNotice = null;
      if (producer === 'table' || producer === 'manual-table') {
        const artifact = createLicenseArtifact(input);
        const adapter = createLicenseDatabaseAdapter();
        await adapter.apply(artifact, false);
        const snapshot = await adapter.load();
        const config = { model: 'google:fixture', sampleCount: 2, noCache: true };
        const key = input.classifications[0].normalizedText;
        const classify = vi.fn();
        for (const source of [
          { jsonClassifications: artifact.classifications },
          { database: snapshot },
        ]) {
          const retained = await inspectLicensePreflight({ ...source, ...config });
          expect(retained.rows[0].action).toBe('retain');
          expect(retained.expectedUncachedRequests).toBe(0);
          await expect(
            inspectLicensePreflight({ ...source, ...config, rerunModel: [licenseKeyDigest(key)] })
          ).rejects.toThrow('An original notice is required');
          const eligibility = [{ ...retained.rows[0], action: 'model' as const }];
          const task =
            'database' in source
              ? analyzeDatabaseLicenses({
                  ...config,
                  catalog: [],
                  classifications: snapshot.classifications,
                  eligibility,
                  classify,
                })
              : analyzeJsonLicenses({ ...config, artifact, eligibility, classify });
          await expect(task).rejects.toThrow('An original notice is required');
        }
        expect(classify).not.toHaveBeenCalled();
      } else {
        expect(() => createLicenseArtifact(input)).toThrow('Only table-derived decisions');
      }
    }
  );

  it.each(Object.keys(noticeForms) as (keyof typeof noticeForms)[])(
    'preserves each accepted historical binding and verifies v4 DB replay for %s',
    async (form) => {
      const notice = noticeForms[form];
      for (const version of [2, 3] as const) {
        const hash = historical[`v${version}`][producer][form];
        // These combinations were rejected by the original create/attest/check entry points.
        if (!hash) continue;
        const original = {
          ...noticeBoundaryInput(producer, notice, version),
          schemaVersion: version,
          hashDomainVersion: version,
          normalizerVersion: 1,
          reviewContentHash: hash,
          attestation: { ...noticeMatrixSigner, reviewContentHash: hash },
        };
        if (producer === 'manual' && form === 'empty' && version === 3)
          expect(original).toEqual(emptyManual);
        const migrated = parseLicenseArtifactBytes(JSON.stringify(original));
        expect(migrated.historicalAttestations).toEqual([
          { ...original.attestation, schemaVersion: version, hashDomainVersion: version },
        ]);
        expect(migrated.classifications[0]).toMatchObject(original.classifications[0]);
        expect(parseLicenseArtifactBytes(serializeLicenseArtifact(migrated).bytes)).toEqual(
          migrated
        );
      }

      const input = noticeBoundaryInput(producer, notice, 4);
      if (producer.includes('rule') && !notice.trim()) {
        expect(() => createLicenseArtifact(input)).toThrow('Rule evidence');
        return;
      }
      const artifact = createLicenseArtifact(input);
      const projected = licenseDatabaseProjection(artifact)[0];
      expect(projected.rationale.evidenceVersion).toBe(4);
      const adapter = createLicenseDatabaseAdapter();
      await adapter.apply(artifact, false);
      const [before] = await database.select().from(schema.license_classifications);
      const [saved] = (await adapter.load()).classifications;
      expect(saved.evidence).toBeDefined();
      const decision = storedLicenseDecision(saved, notice || '© 2025');
      expect(decision.exampleNotice).toBe(notice);
      expect(ownedLicenseClassification(decision)).toEqual(
        ownedLicenseClassification(projected.rationale.evidence)
      );
      const restored = createLicenseArtifact({ ...artifact, classifications: [decision] });
      expect(parseLicenseArtifact(JSON.parse(serializeLicenseArtifact(restored).bytes))).toEqual(
        restored
      );
      const config = { model: 'google:fixture', sampleCount: 2, noCache: true };
      const snapshot = await adapter.load();
      for (const source of [
        { jsonClassifications: restored.classifications },
        { database: snapshot },
      ]) {
        const preview = await inspectLicensePreflight({
          ...source,
          ...config,
          rerunModel: [licenseKeyDigest(decision.normalizedText)],
        });
        expect(preview.rows[0]).toMatchObject({
          exampleNotice: notice,
          normalizedText: decision.normalizedText,
          action: 'model',
        });
        expect(preview.expectedUncachedRequests).toBe(2);
        const transport = vi.fn(async () => '{"rationale":"Synthetic vote","decision":"allowed"}');
        const classify = createLicenseClassifier({ ...config, apiKey: 'fixture', transport });
        const result =
          'database' in source
            ? await analyzeDatabaseLicenses({
                ...config,
                catalog: [],
                classifications: snapshot.classifications,
                eligibility: preview.rows,
                classify,
              })
            : await analyzeJsonLicenses({
                ...config,
                artifact: restored,
                eligibility: preview.rows,
                classify,
              });
        expect(transport).toHaveBeenCalledTimes(2);
        expect(result.classifications[0]).toMatchObject({
          normalizedText: decision.normalizedText,
          exampleNotice: notice,
          source: 'gemini',
          reviewState: 'llm_reviewed',
        });
        expect(result.classifications[0].samples.map((sample) => sample.request)).toEqual(
          [1, 2].map((i) => buildLicenseSampleRequest(notice, 'google', 'fixture', i))
        );
      }
      await adapter.apply(restored, true);
      expect(await database.select().from(schema.license_classifications)).toEqual([before]);
    }
  );
});

describe.each(['json', 'database'] as const)('%s workflow explicit model selection', (source) => {
  it.each([noticeForms.empty, noticeForms.normalizesEmpty])(
    'inspects and reassesses the empty key for original %j',
    async (notice) => {
      const f = await makeCommandFixture(false);
      const adapter = createLicenseDatabaseAdapter();
      const initial = createLicenseArtifact(noticeBoundaryInput('gemini', notice, 4));
      const workflow = new LicenseWorkflow(
        {
          ...f.options,
          source,
          destination: 'json',
          model: 'google:fixture',
          sampleCount: 2,
          noCache: true,
          rerunModel: [licenseKeyDigest('')],
        },
        { ...f.dependencies, database: async () => adapter }
      );
      try {
        if (source === 'database') await adapter.apply(initial, false);
        else await writeFile(f.input, serializeLicenseArtifact(initial).bytes);
        const inspection = await workflow.inspect(1);
        expect(inspection.preflight.rows).toMatchObject([
          { normalizedText: '', exampleNotice: notice, action: 'model' },
        ]);
        expect(f.dependencies.transport).not.toHaveBeenCalled();
        const result = await workflow.startAnalysis(1);
        expect(f.dependencies.transport).toHaveBeenCalledTimes(2);
        expect(result.artifact.classifications[0].samples.map((sample) => sample.request)).toEqual(
          [1, 2].map((i) => buildLicenseSampleRequest(notice, 'google', 'fixture', i))
        );
        expect((await workflow.preview(1, 1)).plan.conflicts).toEqual([]);
      } finally {
        await workflow.close();
        await f.cleanup();
      }
    }
  );
});

it('keeps an orphaned empty key unavailable in production preflight, analysis, JSON export and physical DB replay', async () => {
  const f = await makeCommandFixture(false);
  const adapter = createLicenseDatabaseAdapter();
  await database.insert(schema.license_classifications).values({
    normalizedText: '',
    status: 'unknown',
    reviewState: 'unreviewed',
    rationale: 'Historical table decision',
    classifiedBy: 'archive',
  });
  const before = await database.select().from(schema.license_classifications);
  const workflow = new LicenseWorkflow(
    {
      ...f.options,
      source: 'database',
      destination: 'both',
      reportFormats: 'html',
      reportDir: f.dir,
      noCache: true,
    },
    { ...f.dependencies, database: async () => adapter }
  );
  try {
    const inspect = await workflow.inspect(1);
    expect(inspect.preflight.rows).toMatchObject([
      { normalizedText: '', exampleNotice: null, action: 'retain' },
    ]);
    expect(inspect.preflight.expectedUncachedRequests).toBe(0);
    const analyzed = await workflow.startAnalysis(1);
    expect(analyzed.artifact.classifications[0].exampleNotice).toBeNull();
    const preview = await workflow.preview(1, 1);
    expect(preview.plan.conflicts).toEqual([]);
    expect(preview.reports.reports[0].bytes).toContain('Original notice unavailable');
    await workflow.save({
      previewToken: workflow.previewed!.token,
      operationId: 'orphan-empty-key',
      configurationRevision: 1,
      contentRevision: 1,
      agreeToReplace: false,
    });
    const exported = parseLicenseArtifactBytes(JSON.stringify(await f.readOutput()));
    expect(exported.classifications[0].exampleNotice).toBeNull();
    expect(await database.select().from(schema.license_classifications)).toEqual(before);
    expect(f.dependencies.transport).not.toHaveBeenCalled();
    for (const source of [
      { database: await adapter.load() },
      { jsonClassifications: exported.classifications },
    ]) {
      await expect(
        inspectLicensePreflight({
          ...source,
          noCache: true,
          model: 'google:fixture',
          sampleCount: 2,
          rerunModel: [licenseKeyDigest('')],
        })
      ).rejects.toThrow('An original notice is required');
    }
    const reviewed = recordHumanLicenseDecision(
      exported,
      '',
      'allowed',
      {},
      'Reviewer',
      '2025-04-01T00:00:00.000Z'
    );
    await adapter.apply(reviewed, false);
    const [restored] = (await adapter.load()).classifications;
    expect(restored.evidence).toMatchObject({
      normalizedText: '',
      exampleNotice: null,
      source: 'manual',
      automaticDecision: { source: 'table' },
      reviewedBy: 'Reviewer',
    });
    expect(ownedLicenseClassification(storedLicenseDecision(restored))).toEqual(
      ownedLicenseClassification(reviewed.classifications[0])
    );
    const literal = createLicenseArtifact({
      ...reviewed,
      classifications: [{ ...reviewed.classifications[0], exampleNotice: '' }],
    });
    expect(literal.reviewContentHash).not.toBe(reviewed.reviewContentHash);
    const legacy = { ...emptyManual.classifications[0], exampleNotice: null };
    expect(() => parseLicenseArtifact({ ...emptyManual, classifications: [legacy] })).toThrow();
  } finally {
    await workflow.close();
    await f.cleanup();
  }
});
