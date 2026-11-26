import { readFile, writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

import { reviseLicenseArtifact, serializeLicenseArtifact } from '../license-artifact';
import { makeCommandFixture } from './license-command.test-fixtures';
import { licenseSaveChanges } from './license-save-changes';
import { buildLicenseSavePlan } from './license-save-plan';
import { LicenseWorkflow } from './license-workflow';

it('shows stored JSON values and positions, including extensions, file metadata and retained imports', async () => {
  const f = await makeCommandFixture();
  const target = reviseLicenseArtifact(f.artifact, (draft) => {
    draft.catalog.reverse();
    draft.catalog.push({ ...draft.catalog[0], externalId: 'destination-only', bibleId: 99 });
    draft.catalog[1].name = 'Earlier catalog name';
    draft.destinationExtension = { flags: [1, 2] };
  });
  // A saved artifact can have a stale embedded hash. Preserve the actual prior value in the drawer.
  target.reviewContentHash = 'a'.repeat(64);
  const before = JSON.stringify(target);
  const workflow = new LicenseWorkflow(f.options, {
    ...f.dependencies,
    destinationDatabase: f.dependencies.database,
  });
  try {
    await writeFile(f.output, before);
    await workflow.inspect(1);
    const preview = await workflow.preview(1, workflow.status.contentRevision);
    const [json] = licenseSaveChanges(preview, 'unused').destinations;
    expect(json.records).toContainEqual(
      expect.objectContaining({
        group: 'File metadata',
        before: expect.objectContaining({ reviewContentHash: target.reviewContentHash }),
        after: expect.objectContaining({ destinationExtension: target.destinationExtension }),
      })
    );
    expect(json.records).toContainEqual(
      expect.objectContaining({
        group: 'Catalog',
        operation: 'Update',
        before: expect.objectContaining({ name: 'Earlier catalog name' }),
        after: expect.objectContaining({ name: f.artifact.catalog[1].name }),
      })
    );
    await workflow.save({
      configurationRevision: 1,
      contentRevision: preview.contentRevision,
      previewToken: preview.token,
      operationId: 'frozen-changes',
      agreeToReplace: false,
    });
    const written = JSON.parse(await readFile(f.output, 'utf8'));
    const catalogs = json.records.filter((row) => row.group === 'Catalog');
    expect(catalogs.map((row) => row.after)).toEqual(written.catalog);
    expect(written.catalog).toContainEqual(target.catalog.at(-1));
    expect(json.wholeFileHash).toBe(serializeLicenseArtifact(written).wholeFileHash);
    expect(
      json.records.filter((row) => row.group === 'Classification').map((row) => row.after)
    ).toEqual(written.classifications);
  } finally {
    await workflow.close();
    await f.cleanup();
  }
});

it('identifies records and catalog entries omitted by a source overwrite', async () => {
  const f = await makeCommandFixture();
  try {
    const artifact = reviseLicenseArtifact(f.artifact, (draft) => {
      draft.classifications.pop();
      draft.catalog.pop();
    });
    const plan = buildLicenseSavePlan({
      options: { ...f.options, output: f.input },
      artifact,
      inputBytes: f.sourceBytes,
      outputBytes: f.sourceBytes,
    });
    const [json] = licenseSaveChanges({ plan, token: 'exact', reviewer: '' }, '').destinations;
    const removed = json.records.filter((record) => record.operation === 'Delete');
    expect(removed).toHaveLength(2);
    expect(removed.map((record) => record.before)).toEqual([
      f.artifact.classifications.at(-1),
      f.artifact.catalog.at(-1),
    ]);
    expect(removed.every((record) => record.after === null)).toBe(true);
  } finally {
    await f.cleanup();
  }
});
