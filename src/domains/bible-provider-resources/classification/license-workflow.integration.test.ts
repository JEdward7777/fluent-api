import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';
import { createTestSchema } from '@/db/testing/create-catalogue-schema';
import { persistDblBibleCatalog } from '@/domains/bibles/sync/dbl-bible-sync';
import { llmRequestHash } from '@/lib/llm/request-cache';

import {
  attestLicenseArtifact,
  overrideLicenseClassification,
  reviseLicenseArtifact,
} from '../license-artifact';
import { makeLicenseArtifact, REVIEWER } from '../license-artifact.test-fixtures';
import { createLicenseClassifier } from '../license-classifier';
import { buildLicenseSampleRequest } from '../license-model-contract';
import { analyzeDatabaseLicenses } from './license-analysis';
import { createLicenseDatabaseAdapter, getSyncGuidance } from './license-classifications.service';
import { runLicenseCommand } from './license-command';
import { makeCommandFixture } from './license-command.test-fixtures';
import { licenseFileIo, writeLicenseDestinations } from './license-write';

const { client, database } = await vi.hoisted(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const client = new PGlite();
  return { client, database: drizzle(client) };
});
vi.mock('@/db', () => ({ db: database }));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
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
beforeEach(async () => {
  await database.delete(schema.bibles);
  await database.delete(schema.bible_provider_resources);
  await database.delete(schema.license_classifications);
  await database.delete(schema.languages);
  await database
    .insert(schema.languages)
    .values({ id: 1, langName: 'English', langCodeIso6393: 'eng' });
});
afterAll(() => client.close());
const rows = () =>
  database
    .select()
    .from(schema.license_classifications)
    .orderBy(schema.license_classifications.normalizedText);
const resources = () =>
  database
    .select()
    .from(schema.bible_provider_resources)
    .orderBy(schema.bible_provider_resources.externalId);
const bibleTimes = async () =>
  await database
    .select({ updatedAt: schema.bibles.updatedAt })
    .from(schema.bibles)
    .orderBy(schema.bibles.id);
const catalog = {
  totalBibles: 3,
  skippedMissingLanguage: 0,
  rows: [1, 2, 3].map((id) => ({
    provider: 'dbl' as const,
    externalId: `journey-${id}`,
    name: `Journey Bible ${id}`,
    abbreviation: `J${id}`,
    languageId: 1,
    hasAudio: false,
    textLicenseNotice: id === 3 ? null : 'Publisher terms requiring a classification.',
  })),
};

describe('classification authority and following ordinary sync journey', () => {
  it('misses flag only once without writing classifications; classifier accepts exact authority; following sync propagates every matching resource', async () => {
    await database.insert(schema.license_classifications).values({
      normalizedText: 'bootstrap',
      status: 'allowed',
      rationale: 'Existing reviewed initialization',
      classifiedBy: 'human',
    });
    const initial = await rows();
    expect(
      await persistDblBibleCatalog(catalog, { preserveExistingNonUnknowns: false })
    ).toMatchObject({
      ok: true,
      data: {
        licensePolicy: {
          unknown: 2,
          forbidden: 1,
          newlyFlagged: 2,
          missingKeys: ['publisher terms requiring a classification.'],
        },
      },
    });
    expect(await rows()).toEqual(initial);
    const times = await bibleTimes();
    expect(
      await persistDblBibleCatalog(catalog, { preserveExistingNonUnknowns: false })
    ).toMatchObject({
      ok: true,
      data: { licenseFacts: { inserted: 0, updated: 0 }, licensePolicy: { newlyFlagged: 0 } },
    });
    expect(await bibleTimes()).toEqual(times);
    const f = await makeCommandFixture();
    try {
      const adapter = createLicenseDatabaseAdapter();
      expect(
        await runLicenseCommand(
          { ...f.options, source: 'database', destination: 'database' },
          { ...f.dependencies, database: async () => adapter }
        )
      ).toBe(0);
      expect(f.dependencies.transport).toHaveBeenCalledTimes(3);
      expect((await resources()).map((row) => row.ttsLicenseStatus)).toEqual([
        'unknown',
        'unknown',
        'forbidden',
      ]);
      expect(
        await persistDblBibleCatalog(catalog, { preserveExistingNonUnknowns: false })
      ).toMatchObject({
        ok: true,
        data: { licensePolicy: { allowed: 2, forbidden: 1, unknown: 0, newlyFlagged: 0 } },
      });
      const after = await bibleTimes();
      expect(after[0].updatedAt!.getTime()).toBeGreaterThan(times[0].updatedAt!.getTime());
      await database
        .update(schema.license_classifications)
        .set({ status: 'unknown', rationale: 'Human retained unknown', classifiedBy: 'human' })
        .where(
          eq(
            schema.license_classifications.normalizedText,
            'publisher terms requiring a classification.'
          )
        );
      f.dependencies.transport.mockClear();
      expect(
        await runLicenseCommand(
          { ...f.options, source: 'database', destination: 'database' },
          { ...f.dependencies, database: async () => adapter }
        )
      ).toBe(2);
      expect(f.dependencies.transport).not.toHaveBeenCalled();
      expect(
        await persistDblBibleCatalog(catalog, { preserveExistingNonUnknowns: false })
      ).toMatchObject({
        ok: true,
        data: { licensePolicy: { unknown: 2, newlyFlagged: 0, missingKeys: [] } },
      });
      const snapshot = await adapter.load();
      let artifact = await analyzeDatabaseLicenses({
        catalog: snapshot.context.resources.map(({ ttsLicenseStatus: _status, ...row }) => row),
        classifications: snapshot.classifications,
        classify: createLicenseClassifier({ apiKey: 'mock', transport: f.dependencies.transport }),
        model: f.options.model,
        sampleCount: 3,
      });
      artifact = overrideLicenseClassification(
        artifact,
        'publisher terms requiring a classification.',
        'forbidden',
        'Reviewed terms prohibit this use.'
      ).artifact;
      artifact = attestLicenseArtifact(artifact, REVIEWER);
      await adapter.apply(artifact, false);
      expect((await resources())[0].ttsLicenseStatus).toBe('unknown');
      await persistDblBibleCatalog(catalog, { preserveExistingNonUnknowns: false });
      expect((await resources()).map((row) => row.ttsLicenseStatus)).toEqual([
        'forbidden',
        'forbidden',
        'forbidden',
      ]);
      const final = await bibleTimes();
      await persistDblBibleCatalog(catalog, { preserveExistingNonUnknowns: false });
      expect(await bibleTimes()).toEqual(final);
    } finally {
      await f.cleanup();
    }
  });
  it('preserves nonunknowns for one invocation only and reports disagreements without counting preserved misses as newly flagged', async () => {
    await persistDblBibleCatalog(catalog, 'allowed');
    const preserved = await persistDblBibleCatalog(catalog, { preserveExistingNonUnknowns: true });
    expect(preserved).toMatchObject({
      ok: true,
      data: { licensePolicy: { allowed: 3, newlyFlagged: 0, disagreements: expect.any(Array) } },
    });
    if (preserved.ok) expect(preserved.data.licensePolicy?.disagreements).toHaveLength(3);
    expect(await rows()).toEqual([]);
    const normal = await persistDblBibleCatalog(catalog, { preserveExistingNonUnknowns: false });
    expect(normal).toMatchObject({
      ok: true,
      data: { licensePolicy: { unknown: 2, forbidden: 1, newlyFlagged: 2 } },
    });
    expect((await resources()).map((row) => row.ttsLicenseStatus)).toEqual([
      'unknown',
      'unknown',
      'forbidden',
    ]);
  });
  it('whole-set replacement deletes absent rows, skips unchanged writes, preserves timestamps and rolls back every row on publish failure', async () => {
    const adapter = createLicenseDatabaseAdapter();
    const artifact = attestLicenseArtifact(makeLicenseArtifact(), REVIEWER);
    await adapter.apply(artifact, true, undefined, true);
    const first = await rows();
    await adapter.apply(artifact, true, undefined, true);
    expect(await rows()).toEqual(first);
    const newer = structuredClone(artifact);
    newer.classificationRun.models[0].model = 'different invocation';
    // Each old Gemini row explicitly keeps its own real evidence contract.
    newer.classifications
      .filter((row) => row.samples.length || row.rule)
      .forEach((row) => {
        row.evidenceContract = artifact.classificationRun;
      });
    await adapter.apply(newer, true, undefined, true);
    expect(await rows()).toEqual(first);
    const shortened = structuredClone(artifact);
    shortened.classifications = shortened.classifications.slice(0, 1);
    await expect(
      adapter.apply(
        shortened,
        true,
        async () => {
          throw new Error('atomic file replacement failed');
        },
        true
      )
    ).rejects.toThrow('atomic file replacement failed');
    expect(await rows()).toEqual(first);
    await adapter.apply(shortened, true, undefined, true);
    expect((await rows()).map((row) => row.normalizedText)).toEqual([
      shortened.classifications[0].normalizedText,
    ]);
  });
  it('loads only corresponding text catalog resources, retaining null text notices but excluding recording-only rows', async () => {
    await persistDblBibleCatalog(catalog, 'allowed');
    await database.insert(schema.bible_provider_resources).values({
      provider: 'dbl',
      externalId: 'recording-only',
      licenseNotice: 'Recording attribution',
      ttsLicenseStatus: 'allowed',
    });
    const snapshot = await createLicenseDatabaseAdapter().load();
    expect(snapshot.context.resources).toHaveLength(3);
    expect(
      snapshot.context.resources.find((row) => row.externalId === 'journey-3')?.rawNotice
    ).toBeNull();
    expect(snapshot.context.resources.some((row) => row.externalId === 'recording-only')).toBe(
      false
    );
  });
  it('round-trips inert owned __proto__ schema/settings keys through PostgreSQL JSON semantics without Zod loss or prototype pollution', async () => {
    const artifact = reviseLicenseArtifact(makeLicenseArtifact(), (draft) => {
      const extension = JSON.parse('{"__proto__":{"inert":true}}');
      draft.classificationRun.responseSchema = {
        ...draft.classificationRun.responseSchema,
        ...extension,
      };
      for (const model of draft.classificationRun.models)
        model.settings = { ...model.settings, ...extension };
      for (const row of draft.classifications)
        for (const sample of row.samples) {
          const model = draft.classificationRun.models.find(
            (model) => model.model === sample.model
          )!;
          sample.request = buildLicenseSampleRequest(
            row.exampleNotice,
            sample.provider,
            sample.model,
            sample.index,
            {
              prompt: draft.classificationRun.prompt,
              responseSchema: draft.classificationRun.responseSchema,
              settings: model.settings,
            }
          );
          sample.requestHash = llmRequestHash(sample.request);
        }
    });
    const adapter = createLicenseDatabaseAdapter();
    await adapter.apply(artifact, true, undefined, true);
    const snapshot = await adapter.load();
    const evidence = snapshot.classifications.find(
      (row) => row.evidence?.samples.length
    )!.evidence!;
    expect(Object.hasOwn(evidence.samples[0].request.settings, '__proto__')).toBe(true);
    expect(Object.hasOwn(evidence.samples[0].request.responseSchema, '__proto__')).toBe(true);
    expect(Object.hasOwn(evidence.evidenceContract!.responseSchema, '__proto__')).toBe(true);
    expect(evidence.samples[0].requestHash).toBe(
      artifact.classifications[1].samples[0].requestHash
    );
    expect(Object.hasOwn(Object.prototype, 'inert')).toBe(false);
  });

  it('does not retain owned JSON evidence after a producer-only DB change, and maintenance preserves legacy authority without invented evidence', async () => {
    const adapter = createLicenseDatabaseAdapter();
    const artifact = makeLicenseArtifact();
    await adapter.apply(artifact, true, undefined, true);
    const key = artifact.classifications[1].normalizedText;
    await database
      .update(schema.license_classifications)
      .set({ classifiedBy: 'human' })
      .where(eq(schema.license_classifications.normalizedText, key));
    const snapshot = await adapter.load();
    expect(
      snapshot.classifications.find((row) => row.normalizedText === key)?.evidence
    ).toBeUndefined();
    const classify = vi.fn(createLicenseClassifier({ apiKey: 'mock', transport: vi.fn() }));
    const refreshed = await analyzeDatabaseLicenses({
      base: artifact,
      catalog: [],
      classifications: snapshot.classifications,
      classify,
      model: 'google:current',
      sampleCount: 3,
    });
    const changed = refreshed.classifications.find((row) => row.normalizedText === key)!;
    expect(changed).toMatchObject({ source: 'table', samples: [] });
    expect(changed.rule).toBeUndefined();
    expect(changed.rowNote).toBeUndefined();
    expect(changed.automaticDecision).toBeUndefined();
    expect(changed.evidenceContract).toBeUndefined();
    expect(classify).not.toHaveBeenCalled();
    const before = (await rows()).find((row) => row.normalizedText === key);
    await adapter.apply(refreshed, false);
    expect((await rows()).find((row) => row.normalizedText === key)).toEqual(before);
  });

  it('rechecks initialization authorization inside apply, leaving a newly nonempty table and staged JSON untouched without force', async () => {
    const f = await makeCommandFixture();
    try {
      const adapter = createLicenseDatabaseAdapter();
      const initiallyEmpty = await adapter.load();
      await database.insert(schema.license_classifications).values({
        normalizedText: 'added since initial read',
        status: 'forbidden',
        rationale: 'Another initialized decision',
        classifiedBy: 'human',
      });
      const before = await rows();
      const staleLoader = { ...adapter, load: async () => initiallyEmpty };
      expect(
        await runLicenseCommand(
          { ...f.options, destination: 'both' },
          { ...f.dependencies, database: async () => staleLoader }
        )
      ).toBe(1);
      expect(await rows()).toEqual(before);
      expect(await licenseFileIo.read(f.output)).toBeNull();
      expect(await licenseFileIo.read(f.input)).toBe(f.sourceBytes);
      expect(f.messages.join()).toContain('--force is required');
      expect(
        await runLicenseCommand(
          { ...f.options, destination: 'both', force: true },
          { ...f.dependencies, database: async () => staleLoader }
        )
      ).toBe(2);
      expect((await rows()).some((row) => row.normalizedText === 'added since initial read')).toBe(
        false
      );
    } finally {
      await f.cleanup();
    }
  });

  it('compensates published JSON while the actual database transaction rolls back every staged replacement', async () => {
    const f = await makeCommandFixture();
    try {
      await database.insert(schema.license_classifications).values({
        normalizedText: 'prior decision',
        status: 'forbidden',
        rationale: 'Prior reviewed authority',
        classifiedBy: 'human',
      });
      const before = await rows();
      const adapter = createLicenseDatabaseAdapter();
      await expect(
        writeLicenseDestinations({
          artifact: f.artifact,
          files: [{ path: f.input, previous: f.sourceBytes }],
          replace: true,
          force: true,
          database: {
            ...adapter,
            apply: (artifact, replace, publish, force) =>
              adapter.apply(
                artifact,
                replace,
                async () => {
                  await publish?.();
                  throw new Error('Failure after file publication before commit');
                },
                force
              ),
          },
        })
      ).rejects.toThrow('prior JSON restored');
      expect(await rows()).toEqual(before);
      expect(await licenseFileIo.read(f.input)).toBe(f.sourceBytes);
    } finally {
      await f.cleanup();
    }
  });
  it('keeps unused authoritative unknown rows visible in sync guidance independently of cached unknowns and missing-key backlog', async () => {
    await database.insert(schema.license_classifications).values({
      normalizedText: 'unused authority',
      status: 'unknown',
      rationale: 'Retained without a current resource',
      classifiedBy: 'human',
    });
    const before = await rows();
    const guidance = await getSyncGuidance();
    expect(guidance).toContain(
      '0 cached unknown resources; 1 authoritative unknown classification rows; 0 distinct missing'
    );
    expect(guidance).not.toContain('No unknown license classifications are present');
    expect(guidance).toContain('No additional catalog sync is required');
    expect(guidance).toContain('npm run db:classify:licenses');
    expect(await rows()).toEqual(before);
  });
  it.each(['legacy', 'removed'] as const)(
    'never resurrects old JSON evidence when matching DB authority has %s provenance, and maintenance leaves timestamps untouched',
    async (kind) => {
      const adapter = createLicenseDatabaseAdapter();
      const base = makeLicenseArtifact();
      const old = base.classifications[0];
      old.rowNote = 'A previous reviewer note that the database does not retain.';
      old.extension = { preserve: true };
      if (kind === 'removed') await adapter.apply(base, true, undefined, true);
      else
        await database.insert(schema.license_classifications).values({
          normalizedText: old.normalizedText,
          status: old.status,
          rationale: old.rationale,
          classifiedBy: `rule:${old.rule!.id}`,
        });
      if (kind === 'removed')
        await database
          .update(schema.license_classifications)
          .set({ rationale: { text: old.rationale } })
          .where(eq(schema.license_classifications.normalizedText, old.normalizedText));
      const snapshot = await adapter.load();
      const before = await rows();
      const classify = vi.fn(createLicenseClassifier({ apiKey: 'mock', transport: vi.fn() }));
      const refreshed = await analyzeDatabaseLicenses({
        base,
        catalog: [],
        classifications: snapshot.classifications,
        classify,
        model: 'google:current',
        sampleCount: 3,
      });
      const row = refreshed.classifications.find(
        (row) => row.normalizedText === old.normalizedText
      )!;
      expect(row).toMatchObject({
        status: old.status,
        rationale: old.rationale,
        source: 'table',
        samples: [],
        extension: { preserve: true },
      });
      expect(row.rule).toBeUndefined();
      expect(row.rowNote).toBeUndefined();
      expect(row.automaticDecision).toBeUndefined();
      expect(row.evidenceContract).toBeUndefined();
      expect(classify).not.toHaveBeenCalled();
      await adapter.apply(refreshed, false);
      expect(await rows()).toEqual(before);
    }
  );
});
