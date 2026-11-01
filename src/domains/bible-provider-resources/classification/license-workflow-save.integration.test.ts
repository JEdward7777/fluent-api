import { eq } from 'drizzle-orm';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';
import { createTestSchema } from '@/db/testing/create-catalogue-schema';

import { createLicenseDatabaseAdapter } from './license-classifications.service';
import { makeCommandFixture } from './license-command.test-fixtures';
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
  it('bootstraps from attested JSON and publishes the signed source at the previewed hash', async () => {
    const f = await makeCommandFixture(false);
    try {
      const workflow = new LicenseWorkflow(
        { ...f.options, destination: 'database' },
        { ...f.dependencies, database: async () => createLicenseDatabaseAdapter() }
      );
      await workflow.inspect(1);
      await workflow.startAnalysis(1);
      const first = await workflow.preview(1, 1);
      workflow.attest(
        {
          reviewedBy: 'operator',
          reviewReason: 'Reviewed evidence',
          reviewedAt: '2026-11-01T00:00:00.000Z',
        },
        1,
        1,
        first.reports.reviewContentHash
      );
      const preview = await workflow.preview(1, 2);
      expect(preview.plan.targets.map((target) => target.path)).toEqual([f.input]);
      const result = await workflow.save({
        operationId: 'bootstrap-signed-source',
        configurationRevision: 1,
        contentRevision: 2,
        agreeToReplace: false,
      });
      expect(result.wholeFileHash).toBe(preview.plan.wholeFileHash);
      expect((await createLicenseDatabaseAdapter().load()).classifications).toHaveLength(
        f.artifact.classifications.length
      );
      expect(await readFile(f.input, 'utf8')).not.toBe(f.sourceBytes);
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
