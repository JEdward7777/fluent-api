import {
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeCommandFixture } from './license-command.test-fixtures';
import { LicenseWorkbenchReports } from './license-workbench-reports';
import { LicenseWorkflow } from './license-workflow';
import { licenseFileIo } from './license-write';

const fixtures: Awaited<ReturnType<typeof makeCommandFixture>>[] = [];
async function fixture() {
  const value = await makeCommandFixture();
  fixtures.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((value) => value.cleanup()));
});

describe('license workflow operation lifecycle', () => {
  it('retains inspection and analysis results by operation ID without repeating reads', async () => {
    const f = await fixture();
    const workflow = new LicenseWorkflow(f.options, f.dependencies);
    const inspectRequest = { operationId: 'inspect-1', configurationRevision: 1 };
    const inspected = await workflow.inspect(inspectRequest);
    expect(workflow.operation('inspect-1')).toMatchObject({
      state: 'succeeded',
      result: inspected,
    });
    const analyzed = await workflow.startAnalysis({
      operationId: 'analyze-1',
      configurationRevision: 1,
    });
    expect(await workflow.inspect(inspectRequest)).toEqual(inspected);
    expect(
      await workflow.startAnalysis({ operationId: 'analyze-1', configurationRevision: 1 })
    ).toEqual(analyzed);
    expect(workflow.operation('analyze-1')).toMatchObject({ state: 'succeeded', result: analyzed });
    expect(() => workflow.inspect({ ...inspectRequest, configurationRevision: 2 })).toThrow(
      'reused'
    );
    expect(() => workflow.startAnalysis(inspectRequest)).toThrow('reused');
    expect(f.dependencies.database).not.toHaveBeenCalled();
    expect(f.dependencies.transport).not.toHaveBeenCalled();
    await workflow.close();
  });

  it('stops before the next distinct model key and publishes no partial analysis', async () => {
    const f = await fixture();
    let workflow: LicenseWorkflow;
    const transport = vi.fn(async () => {
      workflow.requestStopAnalysis();
      return '{"rationale":"Permitted in this fixture.","decision":"allowed"}';
    });
    workflow = new LicenseWorkflow(
      { ...f.options, source: 'database' },
      { ...f.dependencies, transport }
    );
    await workflow.inspect({ operationId: 'inspect-db', configurationRevision: 1 });
    await expect(
      workflow.startAnalysis({ operationId: 'analysis-db', configurationRevision: 1 })
    ).rejects.toThrow('stopped');
    expect(workflow.status.state).toBe('inspected');
    expect(workflow.analyzed).toBeUndefined();
    expect(transport).toHaveBeenCalledTimes(f.options.sampleCount);
    expect(workflow.operation('analysis-db')).toMatchObject({ state: 'failed' });
    await workflow.close();
  });

  it('settles source closure when the independent destination rejects close', async () => {
    const source = await fixture();
    const destination = await fixture();
    destination.adapter.close.mockRejectedValueOnce(new Error('fixture cleanup rejection'));
    const workflow = new LicenseWorkflow(
      { ...source.options, source: 'database', destination: 'database' },
      { ...source.dependencies, destinationDatabase: destination.dependencies.database }
    );
    await workflow.inspect(1);
    await workflow.preview(1, workflow.status.contentRevision);
    const closing = workflow.close();
    expect(workflow.close()).toBe(closing);
    await expect(closing).rejects.toThrow('fixture cleanup rejection');
    expect(destination.adapter.close).toHaveBeenCalledOnce();
    expect(source.adapter.close).toHaveBeenCalledOnce();
    expect(workflow.status.state).toBe('closed');
  });

  it('keeps edited review after destination drift during report export and detects source drift separately', async () => {
    const f = await fixture();
    const workflow = new LicenseWorkflow(f.options, {
      ...f.dependencies,
      destinationDatabase: f.dependencies.database,
    });
    try {
      await workflow.inspect(1);
      const edit = workflow.editReview(
        {
          kind: 'disposition',
          normalizedText: f.artifact.classifications[0].normalizedText,
          status: 'allowed',
          reason: 'Fixture decision',
          reviewedBy: 'Fixture reviewer',
        },
        1,
        workflow.status.contentRevision
      );
      const request = {
        configurationRevision: 1,
        contentRevision: edit.analysis.contentRevision,
        format: 'markdown' as const,
        path: join(f.dir, 'report.md'),
        expectedPreviousBytes: null,
        agreeToOverwrite: false,
      };
      await workflow.preview(1, request.contentRevision);
      await writeFile(f.output, f.sourceBytes);
      await expect(
        workflow.exportReport({ ...request, operationId: 'destination-drift' })
      ).rejects.toThrow('save destination');
      expect(workflow.status.state).toBe('reviewing');
      expect(workflow.previewed).toBeUndefined();
      expect(workflow.analyzed).toEqual(edit.analysis);
      await workflow.preview(1, request.contentRevision);
      await writeFile(f.input, `${f.sourceBytes}\n`);
      await expect(
        workflow.exportReport({ ...request, operationId: 'source-drift' })
      ).rejects.toThrow('Inspected inputs changed');
      expect(workflow.status.state).toBe('reviewing');
      expect(workflow.analyzed).toEqual(edit.analysis);
      expect(workflow.sourceChanged).toBe(true);
      await expect(readFile(request.path)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await workflow.close();
    }
  });

  it.each(['before staging', 'after staging'])(
    'binds a missing report path through parent redirection %s',
    async (timing) => {
      const f = await fixture();
      const original = join(f.dir, 'chosen');
      const other = join(f.dir, 'other');
      const alias = join(f.dir, 'reports');
      await Promise.all([mkdir(original), mkdir(other)]);
      await symlink(original, alias, 'dir');
      const nested = join(alias, 'new', 'nested');
      const path = join(nested, 'report.md');
      const redirect = async () => {
        await unlink(alias);
        await symlink(other, alias, 'dir');
      };
      let injecting = false;
      const workflow = new LicenseWorkflow(f.options, {
        ...f.dependencies,
        fs: {
          ...licenseFileIo,
          read: async (file) => {
            const bytes = await licenseFileIo.read(file);
            if (injecting && timing === 'before staging' && basename(file) === 'report.md') {
              injecting = false;
              await redirect();
            }
            return bytes;
          },
          write: async (file, bytes, opened) => {
            await licenseFileIo.write(file, bytes, opened);
            if (injecting && timing === 'after staging') {
              injecting = false;
              await redirect();
            }
          },
        },
      });
      try {
        await workflow.inspect(1);
        await workflow.startAnalysis(1);
        const preview = await workflow.preview(1, workflow.status.contentRevision);
        const reports = new LicenseWorkbenchReports();
        const selection = {
          path,
          format: 'markdown' as const,
          previewToken: preview.token,
          configurationRevision: 1,
          contentRevision: preview.contentRevision,
        };
        const plan = await reports.inspect(workflow, 1, selection);
        expect(plan.parent).toBe(join(original, 'new', 'nested'));
        injecting = true;
        const submit = (id: string) =>
          reports.export(workflow, 1, {
            planId: id,
            operationId: crypto.randomUUID(),
            agreeToOverwrite: false,
          });
        await expect(submit(plan.id)).rejects.toThrow('directory changed');
        expect(await readdir(other)).toEqual([]);
        const entries = await readdir(original, { recursive: true });
        expect(
          entries.filter((name) => name.endsWith('.tmp') || name.endsWith('report.md'))
        ).toEqual([]);
        expect(() => submit(plan.id)).toThrow('Inspect');
        const fresh = await reports.inspect(workflow, 1, selection);
        expect(fresh.parent).toBe(join(other, 'new', 'nested'));
        const result = await submit(fresh.id);
        expect(result.path).toBe(path);
        expect(await readFile(join(other, 'new', 'nested', 'report.md'), 'utf8')).toBe(
          result.bytes
        );
      } finally {
        await workflow.close();
      }
    }
  );

  it.each(['new-name race', 'same bytes after inspection', 'same bytes after final read'])(
    'preserves a concurrent report and requires fresh consent for %s',
    async (race) => {
      const f = await fixture();
      const path = join(f.dir, 'report.md');
      const concurrent = 'other writer';
      let reads = 0;
      let competingInode: number | undefined;
      const replace = async () => {
        const sibling = join(f.dir, 'replacement');
        await writeFile(sibling, concurrent);
        await rename(sibling, path);
        competingInode = (await lstat(path)).ino;
      };
      if (race !== 'new-name race') await writeFile(path, concurrent);
      const workflow = new LicenseWorkflow(f.options, {
        ...f.dependencies,
        fs: {
          ...licenseFileIo,
          read: async (file) => {
            const bytes = await licenseFileIo.read(file);
            if (
              basename(file) === basename(path) &&
              ++reads === 2 &&
              race === 'same bytes after final read'
            )
              await replace();
            return bytes;
          },
          link: async (from, to) => {
            if (basename(to) === basename(path) && race === 'new-name race') await replace();
            await link(from, to);
          },
        },
      });
      try {
        await workflow.inspect(1);
        await workflow.startAnalysis(1);
        const preview = await workflow.preview(1, workflow.status.contentRevision);
        const reports = new LicenseWorkbenchReports();
        const selection = {
          path,
          format: 'markdown' as const,
          previewToken: preview.token,
          configurationRevision: 1,
          contentRevision: preview.contentRevision,
        };
        const plan = await reports.inspect(workflow, 1, selection);
        if (race === 'same bytes after inspection') await replace();
        const submit = (id: string, agree: boolean) =>
          reports.export(workflow, 1, {
            planId: id,
            operationId: crypto.randomUUID(),
            agreeToOverwrite: agree,
          });
        await expect(submit(plan.id, plan.existed)).rejects.toThrow('changed');
        expect(await readFile(path, 'utf8')).toBe(concurrent);
        expect((await lstat(path)).ino).toBe(competingInode);
        expect((await readdir(f.dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
        expect(() => submit(plan.id, true)).toThrow('Inspect');
        const fresh = await reports.inspect(workflow, 1, selection);
        expect(fresh.existed).toBe(true);
        await expect(submit(fresh.id, false)).rejects.toThrow('agreement');
        const confirmed = await reports.inspect(workflow, 1, selection);
        const result = await submit(confirmed.id, true);
        expect(await readFile(path, 'utf8')).toBe(result.bytes);
      } finally {
        await workflow.close();
      }
    }
  );

  it('exports only an explicitly named report with destination freshness and deduplication', async () => {
    const f = await fixture();
    const workflow = new LicenseWorkflow(f.options, f.dependencies);
    await workflow.inspect(1);
    await workflow.startAnalysis(1);
    await workflow.preview(1, 1);
    const path = join(f.dir, 'impact.md');
    const request = {
      operationId: 'report-1',
      configurationRevision: 1,
      contentRevision: 1,
      format: 'markdown' as const,
      path,
      expectedPreviousBytes: null,
      agreeToOverwrite: false,
    };
    const exported = await workflow.exportReport(request);
    const bytes = await readFile(path, 'utf8');
    expect(bytes).toContain('License');
    expect(await workflow.exportReport(request)).toEqual(exported);
    expect(workflow.operation('report-1')).toMatchObject({ state: 'succeeded', result: exported });
    expect(f.adapter.apply).not.toHaveBeenCalled();
    await expect(readFile(f.output, 'utf8')).rejects.toThrow();
    await writeFile(path, 'external change');
    await expect(workflow.exportReport({ ...request, operationId: 'report-2' })).rejects.toThrow(
      'changed'
    );
    expect(await readFile(path, 'utf8')).toBe('external change');
    await expect(
      workflow.exportReport({
        ...request,
        operationId: 'report-3',
        expectedPreviousBytes: 'external change',
      })
    ).rejects.toThrow('agreement');
    await workflow.close();
  });
});
