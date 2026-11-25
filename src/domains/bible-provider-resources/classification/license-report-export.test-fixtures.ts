import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';

import { createOwnedLicenseDatabaseAdapter } from './license-classifications.service';
import { makeCommandFixture } from './license-command.test-fixtures';
import { withEmptyLicenseTarget } from './license-save-fence.test-fixtures';
import { LicenseWorkflow } from './license-workflow';

async function exerciseSavedReportResourceDrift(
  endpoints: string[],
  source: 'json' | 'database',
  drift: 'status' | 'notice' | 'inventory'
) {
  const f = await makeCommandFixture(false);
  const sourceDb = createOwnedLicenseDatabaseAdapter(
    `postgres://api_user@${endpoints[0]}/postgres`,
    undefined,
    'source'
  );
  try {
    await sourceDb.apply(f.artifact, true);
    await withEmptyLicenseTarget(endpoints[1], async (target, external) => {
      const id = crypto.randomUUID();
      await external`INSERT INTO bibles VALUES (7, 'dbl', ${id}, 'Report Bible', 'RPT')`;
      await external`INSERT INTO bible_provider_resources VALUES ('dbl', ${id}, 'Original notice','allowed')`;
      const workflow = new LicenseWorkflow(
        { ...f.options, source, destination: source === 'json' ? 'database' : 'both' },
        { apiKey: '', database: async () => sourceDb, destinationDatabase: async () => target }
      );
      try {
        await workflow.inspect(1);
        const revision = {
          configurationRevision: 1,
          contentRevision: workflow.status.contentRevision,
        };
        const preview = await workflow.preview(1, revision.contentRevision);
        if (source === 'database') expect(preview.plan.databaseProof?.mode).toBe('distinct');
        await workflow.save({
          ...revision,
          previewToken: preview.token,
          operationId: 'classification-save',
          agreeToReplace: false,
        });
        const exportTo = (name: string) =>
          workflow.exportReport({
            ...revision,
            operationId: name,
            format: 'markdown',
            path: join(f.dir, name),
            expectedPreviousBytes: null,
            agreeToOverwrite: false,
          });
        await exportTo('before.md');
        const policy = () =>
          external`SELECT * FROM license_classifications ORDER BY normalized_text`;
        const before = await policy();
        if (drift === 'status')
          await external`UPDATE bible_provider_resources SET tts_license_status='unknown' WHERE external_id=${id}`;
        else if (drift === 'notice')
          await external`UPDATE bible_provider_resources SET text_license_notice='Changed target notice' WHERE external_id=${id}`;
        else await external`DELETE FROM bible_provider_resources WHERE external_id=${id}`;
        await expect(exportTo('stale.md')).rejects.toThrow('destination changed');
        expect(await policy()).toEqual(before);
        await expect(readFile(join(f.dir, 'stale.md'))).rejects.toMatchObject({ code: 'ENOENT' });
        const updated = await workflow.preview(1, workflow.status.contentRevision);
        expect(updated.plan.impactContextHash).not.toBe(preview.plan.impactContextHash);
        expect(updated.plan.databaseForecast?.reviewContentHash).toBe(
          preview.plan.databaseForecast?.reviewContentHash
        );
        await exportTo('fresh.md');
      } finally {
        await workflow.close();
      }
    });
  } finally {
    await sourceDb.close?.();
    await f.cleanup();
  }
}

export function testSavedReportResourceDrift(endpoints: string[]) {
  it.each([
    ['json', 'status'],
    ['database', 'notice'],
    ['database', 'inventory'],
  ] as const)(
    'rejects resource-only drift exporting a completed %s Save (%s)',
    async (source, drift) => {
      await exerciseSavedReportResourceDrift(endpoints, source, drift);
    },
    30000
  );
}
