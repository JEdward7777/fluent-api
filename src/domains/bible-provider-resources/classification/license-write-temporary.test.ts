import { readFile, readlink, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';

import { makeCommandFixture } from './license-command.test-fixtures';
import { exerciseDeferredRetirement } from './license-output-retirement.test-fixtures';
import {
  exerciseRenameAcknowledgement,
  exerciseStagedSubstitution,
} from './license-staged-substitution.test-fixtures';
import { LicenseWorkflow } from './license-workflow';
import { licenseFileIo, LicenseWriteUncertainError } from './license-write';

it.each(['partial', 'unlink denied', 'external replacement'])(
  'fences unverified staging cleanup after %s',
  async (fault) => {
    const f = await makeCommandFixture(false);
    let temporary = '';
    let retained = '';
    let fail = true;
    const remove = vi.fn(async (path: string) => {
      if (fail) throw Object.assign(new Error('unlink denied'), { code: 'EACCES' });
      return licenseFileIo.remove(path);
    });
    const workflow = new LicenseWorkflow(f.options, {
      ...f.dependencies,
      destinationDatabase: f.dependencies.database,
      fs: {
        ...licenseFileIo,
        remove,
        write: async (path, bytes, opened) => {
          if (!fail) return licenseFileIo.write(path, bytes, opened);
          temporary = path;
          retained = fault === 'partial' ? bytes.slice(0, 24) : bytes;
          await licenseFileIo.write(path, retained, opened);
          if (fault === 'external replacement') {
            const foreign = `${path}.external`;
            await writeFile(foreign, retained);
            await rename(foreign, path);
          }
          throw Object.assign(new Error('stage failed'), { code: 'ENOSPC' });
        },
      },
    });
    try {
      await workflow.inspect(1);
      const preview = await workflow.preview(1, 1);
      const request = {
        operationId: crypto.randomUUID(),
        previewToken: preview.token,
        configurationRevision: 1,
        contentRevision: 1,
        agreeToReplace: false,
      };
      const error = await workflow.save(request).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(LicenseWriteUncertainError);
      if (!(error instanceof LicenseWriteUncertainError)) throw error;
      expect(error.recovery.retainedTemporary).toEqual([`${temporary} (cleanup unverified)`]);
      expect(await readFile(temporary, 'utf8')).toBe(retained);
      expect(remove).toHaveBeenCalledTimes(fault === 'unlink denied' ? 1 : 0);
      const reconcile = () => workflow.reconcileSave(request.operationId);
      expect(await reconcile()).toMatchObject({
        outcome: 'uncertain',
        targets: expect.arrayContaining([{ target: temporary, match: 'unverified' }]),
      });
      expect(workflow.status.state).toBe('uncertain');
      await expect(workflow.preview(1, 1)).rejects.toThrow('uncertain');
      expect(() => workflow.save({ ...request, operationId: crypto.randomUUID() })).toThrow();
      await unlink(temporary);
      const missing = `${f.dir}/missing`;
      await symlink(missing, temporary);
      expect((await reconcile()).outcome).toBe('uncertain');
      expect(await readlink(temporary)).toBe(missing);
      await unlink(temporary);
      expect((await reconcile()).outcome).toBe('prior');
      expect(await licenseFileIo.read(f.output)).toBeNull();
      expect(await readFile(f.input, 'utf8')).toBe(f.sourceBytes);
      fail = false;
      const fresh = await workflow.preview(1, 1);
      expect(fresh.token).not.toBe(request.previewToken);
      await workflow.save({
        ...request,
        operationId: crypto.randomUUID(),
        previewToken: fresh.token,
      });
      expect(workflow.status.state).toBe('saved');
    } finally {
      await workflow.close();
      await f.cleanup();
    }
  }
);

for (const stage of ['publication', 'compensation'] as const) {
  it.each(['symlink', 'inode', 'bytes', 'hardlink'] as const)(
    `preserves substituted %s at ${stage} without renaming it`,
    async (change) => {
      await exerciseStagedSubstitution(stage, change);
    }
  );
}

for (const stage of ['publication', 'compensation'] as const) {
  it.each(['unchanged', 'installed', 'foreign'] as const)(
    `checks %s target after rejected ${stage} rename`,
    async (outcome) => {
      await exerciseRenameAcknowledgement(stage, outcome, false);
    }
  );
}
it('removes a newly installed output after its rename acknowledgement is lost', async () => {
  await exerciseRenameAcknowledgement('publication', 'installed', true);
});

it('keeps a late publication fenced when it completes after observing prior bytes but before cleanup', async () => {
  await exerciseRenameAcknowledgement('publication', 'late', false);
});

it('recognizes the exact restored inode when compensation completes after the first reconciliation read', async () => {
  await exerciseRenameAcknowledgement('compensation', 'late', false);
});

it.each(['unlink', 'rename'] as const)(
  'fences a deferred retirement %s after JSON-only Save',
  async (fault) => {
    await exerciseDeferredRetirement(fault);
  }
);
