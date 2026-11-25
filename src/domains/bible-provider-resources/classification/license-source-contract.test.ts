import { readFile, writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

import {
  attestLicenseArtifact,
  createLicenseArtifact,
  serializeLicenseArtifact,
} from '../license-artifact';
import { REVIEWER } from '../license-artifact.test-fixtures';
import { makeCommandFixture } from './license-command.test-fixtures';
import { LicenseReviewDrafts } from './license-review-drafts';
import { mergeLicenseSources } from './license-source-merge';
import { LicenseWorkflow } from './license-workflow';

it.each([
  { explicit: true, working: false },
  { explicit: false, working: false },
  { explicit: true, working: true },
  { explicit: false, working: true },
])(
  'preserves the selected contract and counts physical Save A changes (explicit $explicit, working $working)',
  async ({ explicit, working }) => {
    const f = await makeCommandFixture(false);
    const variant = (include: boolean) =>
      attestLicenseArtifact(
        createLicenseArtifact({
          ...f.artifact,
          classifications: f.artifact.classifications.map((row, index) =>
            index === 1 && include
              ? { ...row, evidenceContract: f.artifact.classificationRun }
              : row
          ),
        }),
        REVIEWER
      );
    const original = variant(!explicit);
    const fresh = variant(explicit);
    const options = { ...f.options, output: f.input };
    const workflow = new LicenseWorkflow(options, {
      ...f.dependencies,
      destinationDatabase: f.dependencies.database,
    });
    try {
      await writeFile(f.input, serializeLicenseArtifact(original).bytes);
      await workflow.inspect(1);
      expect(fresh.reviewContentHash).not.toBe(original.reviewContentHash);
      const bytes = serializeLicenseArtifact(fresh).bytes;
      await writeFile(f.input, bytes);
      await expect(workflow.preview(1, 1)).rejects.toThrow('Inspected inputs changed');
      const proposal = await workflow.reconcileSource();
      if (!proposal.changes) throw new Error('Missing source proposal');
      const key = fresh.classifications[1].normalizedText;
      const rowChange = proposal.changes.find((item) => item.label === `Classification ${key}`)!;
      expect(rowChange).toMatchObject({ proposed: 'source', conflict: false });
      const choices: Record<string, 'working'> = {};
      if (working) for (const change of proposal.changes) choices[change.id] = 'working';
      await workflow.reconcileSource({ token: proposal.token, choices });
      const expected = working ? original : fresh;
      const result = workflow.analyzed!.artifact;
      expect(result.classifications).toEqual(expected.classifications);
      expect(result.attestation).toEqual(expected.attestation);
      expect(result.reviewContentHash).toBe(expected.reviewContentHash);
      const preview = await workflow.preview(1, 2);
      expect(preview.plan.jsonChanges.updated).toEqual(working ? [key] : []);
      expect(preview.plan.jsonChanges.metadataChanges).toEqual(working ? [key] : []);
      expect(preview.plan.jsonChanges.unchanged).toHaveLength(working ? 2 : 3);
      await workflow.save({
        configurationRevision: 1,
        contentRevision: 2,
        operationId: 'same-source',
        previewToken: preview.token,
        agreeToReplace: false,
      });
      if (working) expect(JSON.parse(await readFile(f.input, 'utf8'))).toEqual(expected);
      else expect(await readFile(f.input, 'utf8')).toBe(bytes);
      expect((await workflow.preview(1, 2)).plan.jsonChanges.updated).toEqual([]);
    } finally {
      await workflow.close();
      await f.cleanup();
    }
  }
);

it('materializes the retained inherited run when the selected artifact run changes', async () => {
  const f = await makeCommandFixture(false);
  try {
    const base = f.artifact;
    const working = createLicenseArtifact({
      ...base,
      classifications: base.classifications.map((row, index) =>
        index === 1 ? { ...row, retainedExtension: { origin: 'working' } } : row
      ),
    });
    const source = createLicenseArtifact({
      ...base,
      classificationRun: { ...base.classificationRun, runExtension: { origin: 'source' } },
    });
    const drafts = new LicenseReviewDrafts();
    const diff = mergeLicenseSources(base, working, source, drafts, new Map());
    const changed = diff.changes.find(
      (row) => row.label === `Classification ${working.classifications[1].normalizedText}`
    )!;
    expect(changed.conflict).toBe(true);
    const merged = mergeLicenseSources(
      base,
      working,
      source,
      drafts,
      new Map([[changed.id, 'working']])
    ).finish();
    expect(merged.classificationRun).toEqual(source.classificationRun);
    expect(merged.classifications[1]).toEqual({
      ...working.classifications[1],
      evidenceContract: base.classificationRun,
    });
    expect(merged.classifications[0]).toEqual(source.classifications[0]);
  } finally {
    await f.cleanup();
  }
});
