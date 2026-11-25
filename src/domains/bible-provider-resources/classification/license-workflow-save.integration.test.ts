import { eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';
import { createTestSchema } from '@/db/testing/create-catalogue-schema';

import {
  attestLicenseArtifact,
  recordHumanLicenseDecision,
  serializeLicenseArtifact,
} from '../license-artifact';
import { createLicenseDatabaseAdapter } from './license-classifications.service';
import { makeCommandFixture } from './license-command.test-fixtures';
import { licenseReviewRowId } from './license-workbench-review';
import { LicenseWorkflow } from './license-workflow';

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
    bibleProviderEnum: schema.bibleProviderEnum,
    resourceProviderEnum: schema.resourceProviderEnum,
    ttsLicenseStatusEnum: schema.ttsLicenseStatusEnum,
  });
}, 30000);
beforeEach(async () => {
  await database.delete(schema.license_classifications);
});
afterAll(() => client.close());

describe('save through actual classification adapter', () => {
  it('exports separate working and JSON target assertions and the database forecast for Both', async () => {
    const f = await makeCommandFixture();
    const adapter = createLicenseDatabaseAdapter();
    const workflow = new LicenseWorkflow(
      { ...f.options, destination: 'both' },
      {
        ...f.dependencies,
        database: async () => adapter,
        destinationDatabase: async () => adapter,
      }
    );
    try {
      const stronger = recordHumanLicenseDecision(
        f.artifact,
        f.artifact.classifications[0].normalizedText,
        'unknown',
        'Newer target evidence',
        'Target row reviewer',
        '2099-01-01T00:00:00.000Z'
      );
      const target = attestLicenseArtifact(stronger, {
        reviewedBy: 'Target file signer',
        reviewedAt: '2099-01-01T00:01:00.000Z',
        reviewReason: 'Checked target revision',
      });
      await writeFile(f.output, serializeLicenseArtifact(target).bytes);
      await workflow.inspect(1);
      const revision = {
        configurationRevision: 1,
        contentRevision: workflow.status.contentRevision,
      };
      const preview = await workflow.preview(1, revision.contentRevision);
      const path = join(f.dir, 'classified.md');
      await workflow.exportReport({
        ...revision,
        operationId: 'report',
        format: 'markdown',
        path,
        expectedPreviousBytes: null,
        agreeToOverwrite: false,
      });
      await workflow.save({
        ...revision,
        operationId: 'save',
        previewToken: preview.token,
        agreeToReplace: false,
      });
      const file = await readFile(f.output);
      const report = await readFile(path, 'utf8');
      expect(JSON.parse(file.toString()).attestation.reviewedBy).toBe('Target file signer');
      expect(createHash('sha256').update(file).digest('hex')).not.toBe(
        preview.reports.wholeFileHash
      );
      expect(report).toContain(`Working JSON whole-file SHA-256: ${preview.reports.wholeFileHash}`);
      expect(report).toContain(
        `Working whole-file assertion by ${f.artifact.attestation!.reviewedBy}`
      );
      expect(report).toContain(
        `JSON target whole-file SHA-256: ${createHash('sha256').update(file).digest('hex')}`
      );
      expect(report).toContain('JSON target whole-file assertion by Target file signer');
      expect(report).toContain(
        `Database policy forecast review SHA-256: ${preview.plan.databaseForecast!.reviewContentHash}`
      );
      expect(preview.plan.databaseForecast!.reviewContentHash).not.toBe(
        preview.plan.jsonArtifact!.reviewContentHash
      );
    } finally {
      await workflow.close();
      await f.cleanup();
    }
  });
  it('freezes pending reviews across retries and reports the candidate independently of Both winners', async () => {
    const f = await makeCommandFixture();
    const adapter = createLicenseDatabaseAdapter();
    const instant = '2026-11-01T00:00:00.000Z';
    const now = vi.fn(() => instant);
    const workflow = new LicenseWorkflow(
      { ...f.options, destination: 'both', reportFormats: 'html,markdown' },
      {
        ...f.dependencies,
        database: async () => adapter,
        destinationDatabase: async () => adapter,
        now,
      }
    );
    try {
      const [first, second, untouched] = f.artifact.classifications;
      const destination = recordHumanLicenseDecision(
        f.artifact,
        first.normalizedText,
        'unknown',
        'Later evidence',
        'Database reviewer',
        '2099-01-01T00:00:00.000Z'
      );
      await adapter.apply(destination, true);
      await workflow.inspect(1);
      const baseline = workflow.analyzed!.artifact;
      for (const row of [first, second]) {
        expect(
          workflow.mutateDraft(
            {
              kind: 'patch',
              touched: true,
              reviewComment: 'Checked & confirmed',
              status: 'allowed',
              id: licenseReviewRowId(row.normalizedText),
              epoch: workflow.reviewDrafts.epoch,
              mutationId: crypto.randomUUID(),
              contentRevision: workflow.status.contentRevision,
            },
            true
          ).conflict
        ).toBe(false);
      }
      const revision = workflow.status.contentRevision;
      now.mockClear();
      await expect(workflow.preview(1, revision)).rejects.toThrow('reviewer name');
      const firstPreview = workflow.preview(1, revision, 'Reviewer A');
      const duplicatePreview = workflow.preview(1, revision, 'Reviewer A');
      await expect(workflow.preview(1, revision, 'Reviewer B')).rejects.toThrow(
        'preview is running'
      );
      expect((await firstPreview).token).toBe((await duplicatePreview).token);
      const refreshed = await workflow.preview(1, revision, 'Reviewer A');
      expect(refreshed.token).not.toBe((await firstPreview).token);
      expect(refreshed.plan.reviewContentHash).toBe((await firstPreview).plan.reviewContentHash);
      expect(now).toHaveBeenCalledOnce();
      const preview = await workflow.preview(1, revision, 'Reviewer B');
      expect(now).toHaveBeenCalledTimes(2);
      expect(preview.plan.reviewContentHash).not.toBe(refreshed.plan.reviewContentHash);
      expect(workflow.analyzed!.artifact).toBe(baseline);
      expect(preview.plan.databaseChanges.preserved).toContain(first.normalizedText);
      expect(preview.reports.artifact).toEqual(preview.candidate.artifact);
      expect(preview.reports.reviewContentHash).toBe(preview.plan.reviewContentHash);
      for (const report of preview.reports.reports) {
        expect(report.bytes).toContain('Reviewer B');
        expect(report.bytes).toContain('2026');
      }
      const request = {
        configurationRevision: 1,
        contentRevision: revision,
        operationId: 'both-frozen',
        agreeToReplace: false,
        previewToken: preview.token,
      };
      expect(() => workflow.save({ ...request, previewToken: refreshed.token })).toThrow(
        'Stale preview token'
      );
      const publication = workflow.save(request);
      expect(workflow.save(request)).toBe(publication);
      expect(() => workflow.save({ ...request, previewToken: refreshed.token })).toThrow('reused');
      await publication;
      expect(await workflow.save(request)).toEqual(await publication);
      expect(now).toHaveBeenCalledTimes(2);
      const written = await f.readOutput();
      expect(written).toEqual(preview.plan.jsonArtifact);
      const finalized = written.classifications.filter(
        (row) => row.normalizedText !== untouched.normalizedText
      );
      expect(finalized).toHaveLength(2);
      for (const row of finalized)
        expect(row).toMatchObject({
          reviewedBy: 'Reviewer B',
          decisionAt: instant,
          humanReviewedAt: instant,
          reviewComment: 'Checked & confirmed',
        });
      expect(
        written.classifications.find((row) => row.normalizedText === untouched.normalizedText)
      ).toEqual(
        baseline.classifications.find((row) => row.normalizedText === untouched.normalizedText)
      );
      const stored = (await adapter.load()).classifications;
      expect(stored.find((row) => row.normalizedText === first.normalizedText)?.reviewedBy).toBe(
        'Database reviewer'
      );
      expect(stored.find((row) => row.normalizedText === second.normalizedText)?.reviewedBy).toBe(
        'Reviewer B'
      );
    } finally {
      await workflow.close();
      await f.cleanup();
    }
  });

  it('bootstraps an empty database from valid unattested mixed-state JSON', async () => {
    const f = await makeCommandFixture(false);
    try {
      const workflow = new LicenseWorkflow(
        { ...f.options, destination: 'database' },
        { ...f.dependencies, database: async () => createLicenseDatabaseAdapter() }
      );
      await workflow.inspect(1);
      await workflow.startAnalysis(1);
      const preview = await workflow.preview(1, 1);
      expect(preview.plan.targets).toEqual([]);
      await workflow.save({
        previewToken: workflow.previewed!.token,
        operationId: 'bootstrap-mixed',
        configurationRevision: 1,
        contentRevision: 1,
        agreeToReplace: false,
      });
      const rows = (await createLicenseDatabaseAdapter().load()).classifications;
      expect(rows).toHaveLength(f.artifact.classifications.length);
      expect(rows.some((row) => row.status === 'unknown')).toBe(true);
      expect(rows.every((row) => row.reviewedBy === null)).toBe(true);
      expect(await readFile(f.input, 'utf8')).toBe(f.sourceBytes);
      await workflow.close();
    } finally {
      await f.cleanup();
    }
  });

  it('replays a second identical JSON-to-DB workflow Save with zero DB delta rows', async () => {
    const f = await makeCommandFixture(false);
    try {
      const adapter = createLicenseDatabaseAdapter();
      const options = { ...f.options, destination: 'database' as const };
      const dependencies = { ...f.dependencies, database: async () => adapter };
      const first = new LicenseWorkflow(options, dependencies);
      await first.inspect(1);
      await first.startAnalysis(1);
      await first.preview(1, 1);
      await first.save({
        previewToken: first.previewed!.token,
        operationId: 'first-import',
        configurationRevision: 1,
        contentRevision: 1,
        agreeToReplace: false,
      });
      await first.close();
      const before = await database.select().from(schema.license_classifications);
      const replay = new LicenseWorkflow(options, dependencies);
      await replay.inspect(1);
      await replay.startAnalysis(1);
      const preview = await replay.preview(1, 1);
      expect(preview.plan.conflicts).toEqual([]);
      expect(preview.plan.databaseChanges.unchanged).toHaveLength(
        f.artifact.classifications.length
      );
      expect(preview.plan.databaseArtifact?.classifications).toHaveLength(0);
      expect(preview.reports.model.impact.classificationChanges).toEqual({
        deletedKeys: [],
        insertedKeys: [],
        changedKeys: [],
      });
      await replay.save({
        previewToken: replay.previewed!.token,
        operationId: 'repeat-import',
        configurationRevision: 1,
        contentRevision: 1,
        agreeToReplace: false,
      });
      expect(await database.select().from(schema.license_classifications)).toEqual(before);
      expect(await readFile(f.input, 'utf8')).toBe(f.sourceBytes);
      await replay.close();
    } finally {
      await f.cleanup();
    }
  });

  it('saves a partial JSON-to-DB delta while preserving a stronger DB row', async () => {
    const f = await makeCommandFixture(false);
    try {
      const adapter = createLicenseDatabaseAdapter();
      const key = f.artifact.classifications[1].normalizedText;
      const human = recordHumanLicenseDecision(
        f.artifact,
        key,
        'allowed',
        'Confirmed by database reviewer',
        'DB reviewer',
        '2026-11-17T12:00:00.000Z'
      );
      await adapter.apply(human, true);
      const missingKey = f.artifact.classifications[2].normalizedText;
      await database
        .delete(schema.license_classifications)
        .where(eq(schema.license_classifications.normalizedText, missingKey));
      const workflow = new LicenseWorkflow(
        { ...f.options, destination: 'database' },
        { ...f.dependencies, database: async () => adapter }
      );
      await workflow.inspect(1);
      await workflow.startAnalysis(1);
      const preview = await workflow.preview(1, 1);
      expect(preview.plan.conflicts).toEqual([]);
      expect(preview.plan.databaseChanges.preserved).toContain(key);
      expect(preview.plan.databaseChanges.inserted).toContain(missingKey);
      expect(preview.plan.databaseArtifact?.classifications).toHaveLength(1);
      expect(preview.reports.model.impact.classificationChanges).toEqual({
        deletedKeys: [],
        insertedKeys: [missingKey],
        changedKeys: [],
      });
      await workflow.save({
        previewToken: workflow.previewed!.token,
        operationId: 'partial-import',
        configurationRevision: 1,
        contentRevision: 1,
        agreeToReplace: false,
      });
      const rows = (await adapter.load()).classifications;
      expect(rows.find((row) => row.normalizedText === key)?.reviewedBy).toBe('DB reviewer');
      expect(rows.some((row) => row.normalizedText === missingKey)).toBe(true);
      expect(await readFile(f.input, 'utf8')).toBe(f.sourceBytes);
      await workflow.close();
    } finally {
      await f.cleanup();
    }
  });

  it('reports exactly the DB rows written while retaining an omitted legacy decision', async () => {
    const f = await makeCommandFixture(false);
    try {
      const legacy = {
        normalizedText: 'omitted destination policy',
        status: 'allowed' as const,
        rationale: 'Historical decision',
        classifiedBy: 'historical-producer',
      };
      await database.insert(schema.license_classifications).values(legacy);
      const before = await database.select().from(schema.license_classifications);
      const workflow = new LicenseWorkflow(
        { ...f.options, destination: 'database', reportFormats: 'markdown' },
        { ...f.dependencies, database: async () => createLicenseDatabaseAdapter() }
      );
      await workflow.inspect(1);
      await workflow.startAnalysis(1);
      const preview = await workflow.preview(1, 1);
      expect(preview.plan.databaseChanges.preserved).toContain(legacy.normalizedText);
      expect(preview.reports.model.impact.classificationChanges).toEqual({
        deletedKeys: [],
        insertedKeys: preview.plan.databaseChanges.inserted,
        changedKeys: preview.plan.databaseChanges.updated,
      });
      expect(preview.reports.model.impact.classificationChanges?.changedKeys).not.toContain(
        legacy.normalizedText
      );
      expect(preview.reports.reports[0].bytes).toContain('Planned scoped classification writes');
      expect(preview.reports.reports[0].bytes).not.toContain(
        'whole-table classification replacement'
      );
      await workflow.save({
        previewToken: workflow.previewed!.token,
        operationId: 'omit-legacy',
        configurationRevision: 1,
        contentRevision: 1,
        agreeToReplace: false,
      });
      const after = await database.select().from(schema.license_classifications);
      expect(after).toHaveLength(before.length + preview.plan.databaseChanges.inserted.length);
      expect(after.find((row) => row.normalizedText === legacy.normalizedText)).toEqual(before[0]);
      await workflow.close();
    } finally {
      await f.cleanup();
    }
  });

  it('reports one metadata update and writes that same DB row', async () => {
    const f = await makeCommandFixture(false);
    try {
      const adapter = createLicenseDatabaseAdapter();
      await adapter.apply(f.artifact, true);
      const key = f.artifact.classifications[2].normalizedText;
      const reviewed = recordHumanLicenseDecision(
        f.artifact,
        key,
        'unknown',
        'Confirmed unresolved',
        'Reviewer',
        '2026-11-17T12:00:00.000Z'
      );
      await writeFile(f.input, serializeLicenseArtifact(reviewed).bytes);
      const before = await database.select().from(schema.license_classifications);
      const workflow = new LicenseWorkflow(
        { ...f.options, destination: 'database', reportFormats: 'markdown' },
        { ...f.dependencies, database: async () => adapter }
      );
      await workflow.inspect(1);
      await workflow.startAnalysis(1);
      const preview = await workflow.preview(1, 1);
      expect(preview.plan.databaseChanges.updated).toEqual([key]);
      expect(preview.reports.model.impact.classificationChanges).toEqual({
        deletedKeys: [],
        insertedKeys: [],
        changedKeys: [key],
      });
      await workflow.save({
        previewToken: workflow.previewed!.token,
        operationId: 'metadata-only',
        configurationRevision: 1,
        contentRevision: 1,
        agreeToReplace: false,
      });
      const after = await database.select().from(schema.license_classifications);
      expect(
        after.filter(
          (row, index) => row.updatedAt?.getTime() !== before[index].updatedAt?.getTime()
        )
      ).toHaveLength(1);
      const changed = after.find((row) => row.normalizedText === key)!;
      expect(changed.reviewState).toBe('human_reviewed');
      expect(changed.reviewedBy).toBe('Reviewer');
      await workflow.close();
    } finally {
      await f.cleanup();
    }
  });

  it('refuses policy metadata drift under the apply lock before file publication', async () => {
    const f = await makeCommandFixture();
    try {
      await database.insert(schema.license_classifications).values({
        normalizedText: 'prior policy',
        status: 'forbidden',
        rationale: 'Reviewed prior authority',
        classifiedBy: 'human',
      });
      const adapter = createLicenseDatabaseAdapter();
      const workflow = new LicenseWorkflow(
        { ...f.options, destination: 'both', force: true },
        {
          ...f.dependencies,
          database: async () => ({
            ...adapter,
            apply: async (artifact, replace, publish, force, expectedPolicy) => {
              await database
                .update(schema.license_classifications)
                .set({ classifiedBy: 'another reviewer' })
                .where(eq(schema.license_classifications.normalizedText, 'prior policy'));
              await adapter.apply(artifact, replace, publish, force, expectedPolicy);
            },
          }),
        }
      );
      await workflow.inspect(1);
      await workflow.startAnalysis(1);
      await workflow.preview(1, 1);
      await expect(
        workflow.save({
          previewToken: workflow.previewed!.token,
          operationId: 'locked-drift',
          configurationRevision: 1,
          contentRevision: 1,
          agreeToReplace: true,
        })
      ).rejects.toThrow('policy changed since preview');
      expect(workflow.status.state).toBe('configuring');
      expect(await readFile(f.input, 'utf8')).toBe(f.sourceBytes);
      expect((await adapter.load()).classifications[0]?.classifiedBy).toBe('another reviewer');
      await workflow.close();
    } finally {
      await f.cleanup();
    }
  });
});
