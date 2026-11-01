import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeCommandFixture } from './license-command.test-fixtures';
import { LicenseWorkflow } from './license-workflow';

const fixtures: Awaited<ReturnType<typeof makeCommandFixture>>[] = [];
async function fixture() {
  const value = await makeCommandFixture();
  fixtures.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((value) => value.cleanup()));
});

describe('license workflow inspection and analysis', () => {
  it('starts without reads, then keeps JSON-to-JSON inspection and analysis offline', async () => {
    const f = await fixture();
    const read = vi.fn(async (path: string) => (path === f.input ? f.sourceBytes : null));
    const workflow = new LicenseWorkflow(f.options, {
      ...f.dependencies,
      fs: { read, write: vi.fn(), rename: vi.fn(), remove: vi.fn(), mkdir: vi.fn() },
    });
    expect(workflow.status.state).toBe('configuring');
    expect(read).not.toHaveBeenCalled();
    expect(f.dependencies.database).not.toHaveBeenCalled();
    expect(f.dependencies.transport).not.toHaveBeenCalled();
    const inspected = await workflow.inspect(1);
    expect(inspected.inputBytes).toBe(f.sourceBytes);
    expect(inspected.outputBytes).toBeNull();
    expect(f.dependencies.database).not.toHaveBeenCalled();
    expect(f.dependencies.transport).not.toHaveBeenCalled();
    const analyzed = await workflow.startAnalysis(1);
    expect(analyzed.artifact.reviewContentHash).toBe(f.artifact.reviewContentHash);
    expect(analyzed.contentRevision).toBe(1);
    expect(f.dependencies.database).not.toHaveBeenCalled();
    expect(f.dependencies.transport).not.toHaveBeenCalled();
    await workflow.close();
  });

  it('does not infer while inspecting the database and closes its owned adapter', async () => {
    const f = await fixture();
    const workflow = new LicenseWorkflow({ ...f.options, source: 'database' }, f.dependencies);
    expect(f.dependencies.database).not.toHaveBeenCalled();
    await workflow.inspect(1);
    expect(f.adapter.load).toHaveBeenCalledOnce();
    expect(f.dependencies.transport).not.toHaveBeenCalled();
    await workflow.startAnalysis(1);
    expect(f.dependencies.transport).toHaveBeenCalledTimes(6);
    await workflow.close();
    await workflow.close();
    expect(f.adapter.close).toHaveBeenCalledOnce();
  });

  it('analyzes the inspected database snapshot after the adapter source changes', async () => {
    const f = await fixture();
    const workflow = new LicenseWorkflow({ ...f.options, source: 'database' }, f.dependencies);
    const inspected = await workflow.inspect(1);
    const originalName = inspected.database!.context.resources[0].name;
    f.snapshot.context.resources[0].name = 'Changed after inspection';
    expect(() => {
      inspected.database!.context.resources[0].name = 'Caller mutation';
    }).toThrow();
    const analyzed = await workflow.startAnalysis(1);
    expect(analyzed.artifact.catalog[0].name).toBe(originalName);
    await workflow.close();
  });

  it('rejects stale revisions, duplicate analysis and reconfiguration during analysis', async () => {
    const f = await fixture();
    const workflow = new LicenseWorkflow(f.options, f.dependencies);
    await expect(workflow.inspect(0)).rejects.toThrow('Stale');
    await expect(workflow.startAnalysis(1)).rejects.toThrow('Inspect');
    await workflow.inspect(1);
    await expect(workflow.inspect(1)).rejects.toThrow('Cannot inspect');
    await workflow.startAnalysis(1);
    await expect(workflow.startAnalysis(1)).rejects.toThrow('Inspect');
    expect((await workflow.configure(f.options, 1)).configurationRevision).toBe(2);
    expect(workflow.analyzed).toBeUndefined();
    await expect(workflow.inspect(1)).rejects.toThrow('Stale');
    await workflow.close();
  });

  it('closes the database after inspection failure', async () => {
    const f = await fixture();
    f.snapshot.tableExists = false;
    const workflow = new LicenseWorkflow({ ...f.options, destination: 'database' }, f.dependencies);
    await expect(workflow.inspect(1)).rejects.toThrow('must exist');
    await workflow.close();
    expect(f.adapter.close).toHaveBeenCalledOnce();
    expect(f.dependencies.transport).not.toHaveBeenCalled();
  });

  it('waits for active inspection before closing its adapter and does not revive closed state', async () => {
    const f = await fixture();
    let finishLoad: (() => void) | undefined;
    f.adapter.load.mockImplementationOnce(
      () =>
        new Promise<typeof f.snapshot>((resolve) => {
          finishLoad = () => resolve(structuredClone(f.snapshot));
        })
    );
    const workflow = new LicenseWorkflow({ ...f.options, destination: 'database' }, f.dependencies);
    const inspecting = workflow.inspect(1);
    expect(workflow.status.state).toBe('inspecting');
    await expect(workflow.configure(f.options, 1)).rejects.toThrow('Cannot configure');
    const closing = workflow.close();
    expect(f.adapter.close).not.toHaveBeenCalled();
    finishLoad!();
    await inspecting;
    await closing;
    expect(workflow.status.state).toBe('closed');
    expect(f.adapter.close).toHaveBeenCalledOnce();
    await expect(workflow.startAnalysis(1)).rejects.toThrow('closed');
  });

  it('rejects invalid classifier configuration before reading sources', async () => {
    const f = await fixture();
    const workflow = new LicenseWorkflow({ ...f.options, sampleCount: 1 }, f.dependencies);
    await expect(workflow.inspect(1)).rejects.toThrow('at least two');
    expect(f.dependencies.database).not.toHaveBeenCalled();
    expect(f.dependencies.transport).not.toHaveBeenCalled();
    await workflow.close();
  });
});
