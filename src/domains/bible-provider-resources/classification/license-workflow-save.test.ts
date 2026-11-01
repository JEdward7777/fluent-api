import { readFile, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { checkLicenseArtifactReview } from '../license-artifact';
import { makeCommandFixture } from './license-command.test-fixtures';
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
  it('saves incomplete JSON with bound hash and does not repeat a matching operation ID', async () => {
    const { f, workflow, preview } = await readyWorkflow(false);
    expect(checkLicenseArtifactReview(workflow.analyzed!.artifact).status).toBe('review-required');
    expect(preview.plan.targets).toEqual([{ path: f.output, previous: null, role: 'output' }]);
    const request = {
      operationId: 'save-json-1',
      configurationRevision: 1,
      contentRevision: 1,
      agreeToReplace: false,
    };
    const [first, retry] = await Promise.all([workflow.save(request), workflow.save(request)]);
    expect(retry).toEqual(first);
    expect(
      await workflow.save({
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

  it('shows signed source rewrite and requires separate replacement agreement', async () => {
    const f = await fixture(false);
    const workflow = new LicenseWorkflow(
      { ...f.options, destination: 'database', force: true },
      f.dependencies
    );
    f.snapshot.classifications.push({
      normalizedText: 'existing policy',
      status: 'allowed',
      rationale: 'Prior authority',
      classifiedBy: 'human',
      reviewedAt: null,
    });
    await workflow.inspect(1);
    await workflow.startAnalysis(1);
    const initial = await workflow.preview(1, 1);
    expect(initial.plan.targets).toEqual([]);
    expect(() =>
      workflow.save({
        operationId: 'unattested',
        configurationRevision: 1,
        contentRevision: 1,
        agreeToReplace: false,
      })
    ).toThrow('Explicit agreement');
    workflow.attest(
      {
        reviewedBy: 'operator',
        reviewReason: 'Reviewed evidence',
        reviewedAt: '2026-11-01T00:00:00.000Z',
      },
      1,
      1,
      initial.reports.reviewContentHash
    );
    const preview = await workflow.preview(1, 2);
    expect(preview.plan.targets).toEqual([
      { path: f.input, previous: f.sourceBytes, role: 'signed-source' },
    ]);
    const result = await workflow.save({
      operationId: 'approved-replacement',
      configurationRevision: 1,
      contentRevision: 2,
      agreeToReplace: true,
    });
    expect(result.targets).toEqual(preview.plan.targets);
    expect(f.adapter.apply).toHaveBeenCalledOnce();
    expect(f.adapter.apply.mock.calls[0]?.[4]).toEqual(f.snapshot.classifications);
    expect(checkLicenseArtifactReview(JSON.parse(await readFile(f.input, 'utf8'))).status).toBe(
      'ready'
    );
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
        operationId: 'lost-acknowledgement',
        configurationRevision: 1,
        contentRevision: 1,
        agreeToReplace: false,
      })
    ).rejects.toThrow('outcome may be uncertain');
    expect(workflow.status.state).toBe('uncertain');
    await expect(workflow.configure(f.options, 1)).rejects.toThrow('new process');
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
        operationId: 'preflight-read-failed',
        configurationRevision: 1,
        contentRevision: 1,
        agreeToReplace: false,
      })
    ).rejects.toThrow('Could not recheck inspected inputs');
    expect(workflow.status.state).toBe('configuring');
    expect(f.adapter.apply).not.toHaveBeenCalled();
    await workflow.close();
  });
});
