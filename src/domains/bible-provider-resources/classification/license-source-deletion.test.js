import { readFile, writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

import { createLicenseArtifact, serializeLicenseArtifact } from '../license-artifact';
import { normalizeLicenseNotice } from '../license-normalizer';
import { licenseWorkbenchPreviewLines } from './assets/preview-text.js';
import { makeCommandFixture } from './license-command.test-fixtures';
import { start } from './license-reassessment-http.test-fixtures';

it('previews and receipts exact JSON deletions chosen in source reconciliation, then repeats without changes', async () => {
  const f = await makeCommandFixture(false);
  const app = await start(f, `--output=${f.input}`);
  try {
    const loaded = await app.operate('inspect');
    const exampleNotice = 'External additional notice';
    const key = normalizeLicenseNotice(exampleNotice);
    const row = { ...f.artifact.classifications[2], normalizedText: key, exampleNotice };
    const catalog = {
      ...f.artifact.catalog[2],
      rawNotice: exampleNotice,
      externalId: 'new-external-edition',
      bibleId: 855,
    };
    const fresh = createLicenseArtifact({
      ...f.artifact,
      classifications: [...f.artifact.classifications, row],
      catalog: [...f.artifact.catalog, catalog],
    });
    await writeFile(f.input, serializeLicenseArtifact(fresh).bytes);
    expect(
      (
        await app.api('preview', {
          configurationRevision: 1,
          contentRevision: loaded.contentRevision,
        })
      ).status
    ).toBe(409);
    const proposal = (await app.api('source/reconcile', {})).body;
    expect(proposal.changes).toHaveLength(2);
    const choices = Object.fromEntries(proposal.changes.map((change) => [change.id, 'working']));
    expect((await app.api('source/reconcile', { token: proposal.token, choices })).status).toBe(
      200
    );
    for (const repeat of [false, true]) {
      const setup = (await app.api('setup')).body;
      const version = {
        configurationRevision: setup.configurationRevision,
        contentRevision: setup.contentRevision,
      };
      const ready = (await app.api('preview', version)).body;
      const deleted = repeat ? [] : [key];
      const deletedCatalog = repeat
        ? []
        : [{ provider: catalog.provider, externalId: catalog.externalId }];
      expect(ready.preview.json).toMatchObject({
        deleted,
        deletedCatalog,
        updated: [],
        inserted: [],
      });
      if (!repeat) {
        const lines = licenseWorkbenchPreviewLines(ready).join('\n');
        expect(lines).toContain(`JSON classification deletions (1): ${key}`);
        expect(lines).toContain(
          `JSON catalog deletions (1): ${catalog.provider}/${catalog.externalId}`
        );
      }
      const operationId = crypto.randomUUID();
      expect(
        (
          await app.api('save', {
            ...version,
            operationId,
            previewToken: ready.preview.token,
            agreeToReplace: false,
          })
        ).status
      ).toBe(202);
      await expect
        .poll(async () => (await app.api(`operations/${operationId}`)).body.state)
        .toBe('succeeded');
      const receipt = (await app.api(`operations/${operationId}`)).body.result;
      expect(receipt.json).toMatchObject({
        deleted,
        deletedCatalog,
        updated: 0,
        inserted: 0,
        unchanged: 3,
      });
      expect(JSON.parse(await readFile(f.input, 'utf8'))).toEqual(f.artifact);
    }
  } finally {
    await app.close();
    await f.cleanup();
  }
});

it('reports an extension-only working choice as a physical JSON metadata update, then no-op', async () => {
  const f = await makeCommandFixture(false);
  const app = await start(f, `--output=${f.input}`);
  try {
    const key = f.artifact.classifications[2].normalizedText;
    const withTag = (tag) =>
      createLicenseArtifact({
        ...f.artifact,
        classifications: f.artifact.classifications.map((row) =>
          row.normalizedText === key ? { ...row, auditTag: { owner: tag } } : row
        ),
      });
    const before = withTag('session');
    const external = withTag('external');
    expect(before.reviewContentHash).toBe(external.reviewContentHash);
    await writeFile(f.input, serializeLicenseArtifact(before).bytes);
    const loaded = await app.operate('inspect');
    await writeFile(f.input, serializeLicenseArtifact(external).bytes);
    expect(
      (
        await app.api('preview', {
          configurationRevision: 1,
          contentRevision: loaded.contentRevision,
        })
      ).status
    ).toBe(409);
    const proposal = (await app.api('source/reconcile', {})).body;
    expect(proposal.changes).toHaveLength(1);
    expect(
      (
        await app.api('source/reconcile', {
          token: proposal.token,
          choices: { [proposal.changes[0].id]: 'working' },
        })
      ).status
    ).toBe(200);
    for (const repeat of [false, true]) {
      const setup = (await app.api('setup')).body;
      const revision = { configurationRevision: 1, contentRevision: setup.contentRevision };
      const plan = (await app.api('preview', revision)).body.preview;
      const updates = repeat ? [] : [key];
      expect(plan.json).toMatchObject({
        metadataChanges: updates,
        updated: updates,
        permissionChanges: [],
      });
      const operationId = crypto.randomUUID();
      expect(
        (
          await app.api('save', {
            ...revision,
            operationId,
            previewToken: plan.token,
            agreeToReplace: false,
          })
        ).status
      ).toBe(202);
      await expect
        .poll(async () => (await app.api(`operations/${operationId}`)).body.state)
        .toBe('succeeded');
      expect((await app.api(`operations/${operationId}`)).body.result.json).toMatchObject({
        updated: updates.length,
        metadataChanges: updates.length,
      });
      expect(
        JSON.parse(await readFile(f.input, 'utf8')).classifications.find(
          (row) => row.normalizedText === key
        ).auditTag
      ).toEqual({ owner: 'session' });
    }
  } finally {
    await app.close();
    await f.cleanup();
  }
});
