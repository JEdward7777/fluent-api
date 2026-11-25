import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { expect, vi } from 'vitest';

import type { LicenseDatabaseAdapter } from './license-database.types';

import { serializeLicenseArtifact } from '../license-artifact';
import { makeCommandFixture } from './license-command.test-fixtures';
import { LicenseWorkflow } from './license-workflow';
import { licenseFileIo, LicenseWriteUncertainError } from './license-write';

export async function exerciseDeferredRetirement(
  fault: 'unlink' | 'rename',
  database?: LicenseDatabaseAdapter,
  unchangedPolicy = false
) {
  const f = await makeCommandFixture(false);
  const release = Promise.withResolvers<void>();
  let pending: Promise<void> | undefined;
  let retired = '';
  let inject = true;
  const move = vi.spyOn(licenseFileIo, 'rename').mockImplementation(async (from, to) => {
    if (inject && from === f.output && fault === 'rename') {
      retired = to;
      pending = release.promise.then(() => rename(from, to));
      throw new Error('Retirement rename acknowledgement lost');
    }
    await rename(from, to);
    if (inject && !database && to === f.output) throw new Error('Publication acknowledgement lost');
  });
  const remove = vi.spyOn(licenseFileIo, 'remove').mockImplementation(async (path) => {
    if (inject && fault === 'unlink') {
      retired = path;
      pending = release.promise.then(() => unlink(path));
      throw new Error('Retirement unlink acknowledgement lost');
    }
    return unlink(path);
  });
  if (unchangedPolicy) await database!.apply(f.artifact, false);
  const workflow = new LicenseWorkflow(
    { ...f.options, destination: database ? 'both' : 'json' },
    {
      apiKey: '',
      destinationDatabase: async () =>
        database
          ? {
              ...database,
              apply: async (...args) => {
                await database.apply(...args);
                if (inject) throw new Error('Database COMMIT acknowledgement lost');
              },
            }
          : f.adapter,
    }
  );
  try {
    await workflow.inspect(1);
    const preview = await workflow.preview(1, 1);
    const request = {
      previewToken: preview.token,
      operationId: crypto.randomUUID(),
      configurationRevision: 1,
      contentRevision: 1,
      agreeToReplace: false,
    };
    const planned = serializeLicenseArtifact(preview.plan.jsonArtifact!).bytes;
    const error = await workflow.save(request).catch((error: unknown) => error);
    if (!(error instanceof LicenseWriteUncertainError))
      throw error ?? new Error('Unsettled removal was acknowledged');
    expect(error.recovery.retainedTemporary.some((entry) => entry.startsWith(retired))).toBe(true);
    expect(retired).toMatch(/\.retired\.tmp$/);
    expect(retired).not.toBe(f.output);
    const reconcile = () => workflow.reconcileSave(request.operationId);
    const early = await reconcile();
    expect(early.outcome).toBe('uncertain');
    if (database)
      expect(early.targets).toContainEqual({
        target: 'license_classifications',
        match: unchangedPolicy ? 'both' : 'planned',
      });
    await expect(workflow.preview(1, 1)).rejects.toThrow('uncertain');
    expect(() => workflow.save({ ...request, operationId: crypto.randomUUID() })).toThrow();
    if (fault === 'unlink') {
      expect(await readFile(retired, 'utf8')).toBe(planned);
      expect(await licenseFileIo.read(f.output)).toBeNull();
      expect(early.targets).toContainEqual({ target: retired, match: 'unverified' });
      await writeFile(f.output, 'independent output', { flag: 'wx' });
    } else {
      expect(early.targets).toContainEqual({ target: f.output, match: 'unverified' });
      // Temporary public absence alone cannot certify the outstanding rename.
      const parked = `${f.dir}/parked`;
      await rename(f.output, parked);
      expect((await reconcile()).outcome).toBe('uncertain');
      await rename(parked, f.output);
    }
    release.resolve();
    await pending;
    if (fault === 'unlink') {
      expect(await readFile(f.output, 'utf8')).toBe('independent output');
      expect((await reconcile()).outcome).toBe('uncertain');
      await unlink(f.output);
    } else {
      // Observe retirement while its identity is still available, then release the retained copy.
      expect(await readFile(retired, 'utf8')).toBe(planned);
      const observed = await reconcile();
      expect(observed.targets).toContainEqual({ target: f.output, match: 'prior' });
      expect(observed.outcome).toBe('uncertain');
      await unlink(retired);
    }
    const settled = await reconcile();
    expect(settled.targets).toContainEqual({ target: f.output, match: 'prior' });
    if (database && !unchangedPolicy) {
      expect(settled.outcome).toBe('uncertain');
      expect(workflow.status.state).toBe('uncertain');
      expect((await database.load()).classifications).toHaveLength(
        f.artifact.classifications.length
      );
    } else {
      expect(settled.outcome).toBe('prior');
      inject = false;
      const fresh = await workflow.preview(1, 1);
      expect(fresh.token).not.toBe(request.previewToken);
      await workflow.save({
        ...request,
        operationId: crypto.randomUUID(),
        previewToken: fresh.token,
      });
      expect(await readFile(f.output, 'utf8')).toBe(planned);
    }
  } finally {
    release.resolve();
    await pending?.catch(() => undefined);
    remove.mockRestore();
    move.mockRestore();
    await workflow.close();
    await f.cleanup();
  }
}
