import { readFile, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  checkLicenseArtifactReview,
  recordHumanLicenseDecision,
  serializeLicenseArtifact,
} from '../license-artifact';
import { makeCommandFixture } from './license-command.test-fixtures';
import { licenseReviewRowId } from './license-workbench-review';
import { LicenseWorkflow } from './license-workflow';
import { licenseFileIo } from './license-write';

const fixtures: Awaited<ReturnType<typeof makeCommandFixture>>[] = [];
async function fixture(attested = true) {
  const value = await makeCommandFixture(attested);
  fixtures.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((value) => value.cleanup()));
});

async function readyWorkflow(attested = true) {
  const f = await fixture(attested);
  const workflow = new LicenseWorkflow(f.options, f.dependencies);
  await workflow.inspect(1);
  await workflow.startAnalysis(1);
  const preview = await workflow.preview(1, 1);
  return { f, workflow, preview };
}

describe('shared workflow exact-preview Save', () => {
  it('keeps a tied event in conflict and retries a definitely unwritten candidate without redating it', async () => {
    const f = await fixture();
    const instant = '2026-11-02T00:00:00.000Z';
    const now = vi.fn(() => instant);
    const read = vi.fn(licenseFileIo.read);
    const workflow = new LicenseWorkflow(f.options, {
      ...f.dependencies,
      destinationDatabase: f.dependencies.database,
      fs: { ...licenseFileIo, read },
      now,
    });
    try {
      const key = f.artifact.classifications[0].normalizedText;
      const tied = recordHumanLicenseDecision(
        f.artifact,
        key,
        'unknown',
        'Concurrent decision',
        'Other reviewer',
        instant
      );
      await writeFile(f.output, serializeLicenseArtifact(tied).bytes);
      await workflow.inspect(1);
      const mark = workflow.mutateDraft(
        {
          kind: 'mark',
          id: licenseReviewRowId(key),
          epoch: workflow.reviewDrafts.epoch,
          contentRevision: workflow.status.contentRevision,
          mutationId: crypto.randomUUID(),
        },
        true
      );
      now.mockClear();
      const revision = mark.contentRevision;
      const conflict = await workflow.preview(1, revision, 'Sam');
      expect(conflict.plan.conflicts.join(' ')).toContain(key);
      const request = {
        operationId: 'tied',
        previewToken: conflict.token,
        configurationRevision: 1,
        contentRevision: revision,
        agreeToReplace: false,
      };
      expect(() => workflow.save(request)).toThrow('Save conflicts');
      await workflow.configureLoadedSettings(
        { ...f.options, output: `${f.dir}/other.json` },
        true,
        false
      );
      const preview = await workflow.preview(1, revision, 'Sam');
      const failedRequest = { ...request, operationId: 'failed', previewToken: preview.token };
      read.mockRejectedValueOnce(new Error('temporary read failure'));
      await expect(workflow.save(failedRequest)).rejects.toThrow('recheck inspected inputs');
      expect(workflow.reviewDrafts.size).toBe(1);
      const retry = await workflow.preview(1, revision, 'Sam');
      expect(retry.candidate.artifact).toEqual(conflict.candidate.artifact);
      expect(now).toHaveBeenCalledOnce();
      await expect(workflow.save(failedRequest)).rejects.toThrow('recheck inspected inputs');
      await workflow.save({ ...request, operationId: 'retry', previewToken: retry.token });
      expect(now).toHaveBeenCalledOnce();
    } finally {
      await workflow.close();
    }
  });
  it('saves edited JSON A to B, then counts the physical difference and publishes to A', async () => {
    const f = await fixture(false);
    const dependencies = { ...f.dependencies, destinationDatabase: f.dependencies.database };
    const workflow = new LicenseWorkflow(f.options, dependencies);
    try {
      await workflow.inspect(1);
      const key = f.artifact.classifications[0].normalizedText;
      workflow.editReview(
        {
          kind: 'disposition',
          normalizedText: key,
          status: 'allowed',
          reason: 'Approved',
          reviewedBy: 'Reviewer',
        },
        1,
        1
      );
      const request = { configurationRevision: 1, contentRevision: 2, agreeToReplace: false };
      expect((await workflow.preview(1, 2)).plan.jsonChanges.inserted).toHaveLength(3);
      await workflow.save({
        ...request,
        previewToken: workflow.previewed!.token,
        operationId: 'save-copy',
      });
      expect(await readFile(f.input, 'utf8')).toBe(f.sourceBytes);
      const options = { ...f.options, output: f.input };
      await workflow.configureLoadedSettings(options, true, false);
      const preview = await workflow.preview(1, 2);
      expect(preview.plan.jsonChanges).toMatchObject({
        inserted: [],
        updated: [key],
        permissionChanges: [key],
        metadataChanges: [],
      });
      expect(preview.plan.jsonChanges.unchanged).toHaveLength(2);
      await workflow.save({
        ...request,
        previewToken: workflow.previewed!.token,
        operationId: 'save-original',
      });
      expect(await readFile(f.input, 'utf8')).toBe(await readFile(f.output, 'utf8'));
      const reloaded = new LicenseWorkflow(options, dependencies);
      try {
        await reloaded.inspect(1);
        const repeat = await reloaded.preview(1, 1);
        expect(repeat.plan.jsonChanges.updated).toEqual([]);
        expect(repeat.plan.jsonChanges.unchanged).toHaveLength(3);
      } finally {
        await reloaded.close();
      }
    } finally {
      await workflow.close();
    }
  });

  it.each(['saved', 'inspected'])(
    'retains destination changes across draft revert from %s',
    async (state) => {
      const f = await fixture();
      const workflow = new LicenseWorkflow(f.options, {
        ...f.dependencies,
        destinationDatabase: f.dependencies.database,
      });
      try {
        await workflow.inspect(1);
        if (state === 'saved') {
          await workflow.preview(1, 1);
          await workflow.save({
            previewToken: workflow.previewed!.token,
            operationId: 'save-before-draft',
            configurationRevision: 1,
            contentRevision: 1,
            agreeToReplace: false,
          });
        }
        const command = {
          epoch: workflow.reviewDrafts.epoch,
          id: licenseReviewRowId(f.artifact.classifications[0].normalizedText),
          contentRevision: 1,
          mutationId: crypto.randomUUID(),
        };
        expect(workflow.mutateDraft({ ...command, kind: 'mark' }, true).conflict).toBe(false);
        const output = `${f.dir}/changed-output.json`;
        await workflow.configureLoadedSettings({ ...f.options, output }, true, false);
        expect(
          workflow.mutateDraft(
            { ...command, kind: 'revert', contentRevision: 2, mutationId: crypto.randomUUID() },
            true
          ).conflict
        ).toBe(false);
        expect(workflow.status.state).toBe(state === 'saved' ? 'reviewing' : 'inspected');
        expect(workflow.previewed).toBeUndefined();
        expect((await workflow.preview(1, 3)).plan.targets).toContainEqual({
          role: 'output',
          path: output,
          previous: null,
        });
      } finally {
        await workflow.close();
      }
    }
  );
  it('saves incomplete JSON with bound hash and does not repeat a matching operation ID', async () => {
    const { f, workflow, preview } = await readyWorkflow(false);
    expect(checkLicenseArtifactReview(workflow.analyzed!.artifact).status).toBe('review-required');
    expect(preview.plan.targets).toEqual([{ path: f.output, previous: null, role: 'output' }]);
    const request = {
      previewToken: workflow.previewed!.token,
      operationId: 'save-json-1',
      configurationRevision: 1,
      contentRevision: 1,
      agreeToReplace: false,
    };
    const [first, retry] = await Promise.all([workflow.save(request), workflow.save(request)]);
    expect(retry).toEqual(first);
    expect(
      await workflow.save({
        previewToken: workflow.previewed!.token,
        agreeToReplace: false,
        contentRevision: 1,
        operationId: 'save-json-1',
        configurationRevision: 1,
      })
    ).toEqual(first);
    expect(first.wholeFileHash).toBe(preview.plan.wholeFileHash);
    expect(await f.readOutput()).toEqual(workflow.analyzed!.artifact);
    expect(f.adapter.apply).not.toHaveBeenCalled();
    expect(() => workflow.save({ ...request, agreeToReplace: true })).toThrow(
      'reused with different arguments'
    );
    expect(() => workflow.save({ ...request, operationId: 'save-json-2' })).toThrow(
      'Preview this exact revision'
    );
    await workflow.close();
  });

  it('retains Save IDs and results across reconfiguration and later saves', async () => {
    const f = await fixture();
    const write = vi.fn(licenseFileIo.write);
    const workflow = new LicenseWorkflow(f.options, {
      ...f.dependencies,
      fs: { ...licenseFileIo, write },
    });
    await workflow.inspect(1);
    await workflow.startAnalysis(1);
    await workflow.preview(1, 1);
    const firstRequest = {
      previewToken: workflow.previewed!.token,
      operationId: 'original-save',
      configurationRevision: 1,
      contentRevision: 1,
      agreeToReplace: false,
    };
    const first = await workflow.save(firstRequest);
    await workflow.configure(f.options, 1);
    await workflow.inspect(2);
    await workflow.startAnalysis(2);
    await workflow.preview(2, 1);
    await workflow.save({
      previewToken: workflow.previewed!.token,
      operationId: 'later-save',
      configurationRevision: 2,
      contentRevision: 1,
      agreeToReplace: false,
    });
    const writes = write.mock.calls.length;
    expect(await workflow.save(firstRequest)).toEqual(first);
    expect(write).toHaveBeenCalledTimes(writes);
    expect(() => workflow.save({ ...firstRequest, configurationRevision: 2 })).toThrow(
      'reused with different arguments'
    );
    expect(write).toHaveBeenCalledTimes(writes);
    await workflow.close();
  });

  it('refuses externally changed source or output and requires fresh inspection', async () => {
    for (const changed of ['input', 'output'] as const) {
      const { f, workflow } = await readyWorkflow();
      await writeFile(changed === 'input' ? f.input : f.output, 'external edit');
      await expect(
        workflow.save({
          previewToken: workflow.previewed!.token,
          operationId: `save-${changed}`,
          configurationRevision: 1,
          contentRevision: 1,
          agreeToReplace: false,
        })
      ).rejects.toThrow('Inspect inputs again');
      expect(workflow.status.state).toBe('configuring');
      expect(f.adapter.apply).not.toHaveBeenCalled();
      expect(await readFile(changed === 'input' ? f.input : f.output, 'utf8')).toBe(
        'external edit'
      );
      await workflow.close();
    }
  });

  it('imports valid unattested unknowns without a force agreement or source rewrite', async () => {
    const f = await fixture(false);
    const workflow = new LicenseWorkflow({ ...f.options, destination: 'database' }, f.dependencies);
    f.snapshot.classifications.push({
      normalizedText: 'existing policy',
      status: 'allowed',
      rationale: 'Prior authority',
      classifiedBy: 'human',
      reviewedAt: null,
    });
    await workflow.inspect(1);
    await workflow.startAnalysis(1);
    const preview = await workflow.preview(1, 1);
    expect(preview.plan.targets).toEqual([]);
    expect(preview.plan.requiresForceAgreement).toBe(false);
    expect(preview.plan.databaseChanges.preserved).toContain('existing policy');
    const result = await workflow.save({
      previewToken: workflow.previewed!.token,
      operationId: 'mixed-import',
      configurationRevision: 1,
      contentRevision: 1,
      agreeToReplace: false,
    });
    expect(result.targets).toEqual([]);
    expect(f.adapter.apply).toHaveBeenCalledOnce();
    expect(f.adapter.apply.mock.calls[0]?.[4]).toEqual(f.snapshot.classifications);
    expect(await readFile(f.input, 'utf8')).toBe(f.sourceBytes);
    await workflow.close();
  });

  it('assesses catalog notices and saves when a DB source policy table is empty', async () => {
    const f = await fixture(false);
    const workflow = new LicenseWorkflow(
      { ...f.options, source: 'database', destination: 'database' },
      f.dependencies
    );
    await workflow.inspect(1);
    await workflow.startAnalysis(1);
    const preview = await workflow.preview(1, 1);
    expect(preview.plan.databaseChanges.inserted.length).toBeGreaterThan(0);
    await workflow.save({
      previewToken: workflow.previewed!.token,
      operationId: 'empty-db-source',
      configurationRevision: 1,
      contentRevision: 1,
      agreeToReplace: false,
    });
    expect(f.adapter.apply).toHaveBeenCalledOnce();
    await workflow.close();
  });

  it('keeps a distinct JSON source read-only when signing the JSON output', async () => {
    const { f, workflow } = await readyWorkflow(false);
    const first = workflow.previewed!;
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
    expect(preview.plan.targets.map((target) => target.path)).toEqual([f.output]);
    await workflow.save({
      previewToken: workflow.previewed!.token,
      operationId: 'json-output-only',
      configurationRevision: 1,
      contentRevision: 2,
      agreeToReplace: false,
    });
    expect(await readFile(f.input, 'utf8')).toBe(f.sourceBytes);
    await workflow.close();
  });

  it('freezes operation identity and replacement agreement while freshness is pending', async () => {
    const f = await fixture();
    f.snapshot.classifications.push({
      normalizedText: 'existing policy',
      status: 'allowed',
      rationale: 'Prior authority',
      classifiedBy: 'human',
      reviewedAt: null,
    });
    let hold = false;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const workflow = new LicenseWorkflow(
      { ...f.options, destination: 'database', force: true },
      {
        ...f.dependencies,
        fs: {
          ...licenseFileIo,
          read: async (path) => {
            if (hold) await gate;
            return licenseFileIo.read(path);
          },
        },
      }
    );
    await workflow.inspect(1);
    await workflow.startAnalysis(1);
    await workflow.preview(1, 1);
    hold = true;
    const request = {
      previewToken: workflow.previewed!.token,
      operationId: 'approved-before-await',
      configurationRevision: 1,
      contentRevision: 1,
      agreeToReplace: true,
    };
    const pending = workflow.save(request);
    request.operationId = 'mutated-after-await';
    request.agreeToReplace = false;
    release();
    expect((await pending).operationId).toBe('approved-before-await');
    expect(f.adapter.apply).toHaveBeenCalledOnce();
    await workflow.close();
  });

  it('keeps an unacknowledged database commit terminally uncertain', async () => {
    const f = await fixture();
    const workflow = new LicenseWorkflow(
      { ...f.options, destination: 'database' },
      {
        ...f.dependencies,
        database: async () => ({
          ...f.adapter,
          apply: async () => {
            throw new Error('Connection lost during commit acknowledgement');
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
        operationId: 'lost-acknowledgement',
        configurationRevision: 1,
        contentRevision: 1,
        agreeToReplace: false,
      })
    ).rejects.toThrow('outcome may be uncertain');
    expect(workflow.status.state).toBe('uncertain');
    await expect(workflow.configure(f.options, 1)).rejects.toThrow('check the actual Save targets');
    await workflow.close();
  });

  it('keeps a failed preflight read recoverable because no write began', async () => {
    const f = await fixture();
    let failRead = false;
    const workflow = new LicenseWorkflow(f.options, {
      ...f.dependencies,
      fs: {
        ...licenseFileIo,
        read: async (path) => {
          if (failRead) throw new Error('Temporary read failure');
          return licenseFileIo.read(path);
        },
      },
    });
    await workflow.inspect(1);
    await workflow.startAnalysis(1);
    await workflow.preview(1, 1);
    failRead = true;
    await expect(
      workflow.save({
        previewToken: workflow.previewed!.token,
        operationId: 'preflight-read-failed',
        configurationRevision: 1,
        contentRevision: 1,
        agreeToReplace: false,
      })
    ).rejects.toThrow('Could not recheck inspected inputs');
    expect(workflow.status.state).toBe('reviewing');
    expect(f.adapter.apply).not.toHaveBeenCalled();
    await workflow.close();
  });
});
