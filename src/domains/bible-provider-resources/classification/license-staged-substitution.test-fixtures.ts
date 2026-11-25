import {
  link,
  readFile,
  readlink,
  rename,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { expect, vi } from 'vitest';

import type { LicenseDatabaseAdapter } from './license-database.types';

import { serializeLicenseArtifact } from '../license-artifact';
import { makeCommandFixture } from './license-command.test-fixtures';
import { LicenseDatabaseAbortedError } from './license-database.types';
import { LicenseWorkflow } from './license-workflow';
import { licenseFileIo, LicenseWriteUncertainError } from './license-write';

export async function exerciseStagedSubstitution(
  stage: 'publication' | 'compensation',
  change: 'symlink' | 'inode' | 'bytes' | 'hardlink',
  database?: LicenseDatabaseAdapter
) {
  const f = await makeCommandFixture(false);
  const adapter = database ?? f.adapter;
  const prior = `${f.sourceBytes}\n  `;
  await writeFile(f.output, prior);
  const original = await stat(f.output, { bigint: true });
  const external = `${f.dir}/external`;
  await writeFile(external, 'external file');
  let temporary = '';
  let expectedBytes = '';
  let stages = 0;
  let publishes = 0;
  const substitute = async () => {
    if (change === 'bytes') return writeFile(temporary, 'changed in place');
    if (change === 'hardlink') return link(temporary, `${f.dir}/extra-link`);
    const sibling = `${temporary}.replacement`;
    if (change === 'symlink') await symlink(external, sibling);
    else await writeFile(sibling, expectedBytes);
    await rename(sibling, temporary);
  };
  const workflow = new LicenseWorkflow(
    { ...f.options, destination: 'both' },
    {
      apiKey: '',
      fs: {
        ...licenseFileIo,
        write: async (path, bytes, opened) => {
          await licenseFileIo.write(path, bytes, opened);
          if (!path.endsWith('.tmp')) return;
          stages++;
          temporary = path;
          expectedBytes = bytes;
          if (stages === 2 && stage === 'compensation') await substitute();
        },
        rename: async (from, to) => {
          publishes++;
          await rename(from, to);
        },
      },
      destinationDatabase: async () => ({
        ...adapter,
        apply: (artifact, replace, publish, force, policy, identity) =>
          adapter.apply(
            artifact,
            replace,
            async () => {
              if (stage === 'publication') await substitute();
              await publish?.();
              if (stage === 'compensation') throw new Error('Abort disposable publication');
            },
            force,
            policy,
            identity
          ),
      }),
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
    const error = await workflow.save(request).catch((error: unknown) => error);
    if (!(error instanceof LicenseWriteUncertainError))
      throw error ?? new Error('Substitution unexpectedly succeeded');
    expect(error.recovery.retainedTemporary.some((entry) => entry.startsWith(temporary))).toBe(
      true
    );
    expect(workflow.status.state).toBe('uncertain');
    expect(publishes).toBe(stage === 'publication' ? 0 : 1);
    expect((await workflow.reconcileSave(request.operationId)).outcome).toBe('uncertain');
    await expect(workflow.preview(1, 1)).rejects.toThrow('uncertain');
    const planned = serializeLicenseArtifact(preview.plan.jsonArtifact!).bytes;
    expect(await readFile(f.output, 'utf8')).toBe(stage === 'publication' ? prior : planned);
    if (stage === 'publication')
      expect((await stat(f.output, { bigint: true })).ino).toBe(original.ino);
    if (change === 'symlink') expect(await readlink(temporary)).toBe(external);
    else
      expect(await readFile(temporary, 'utf8')).toBe(
        change === 'bytes' ? 'changed in place' : expectedBytes
      );
    expect(await readFile(external, 'utf8')).toBe('external file');
    expect((await adapter.load()).classifications).toHaveLength(0);
  } finally {
    await workflow.close();
    await f.cleanup();
  }
}

export async function exerciseRenameAcknowledgement(
  stage: 'publication' | 'compensation',
  outcome: 'unchanged' | 'installed' | 'foreign' | 'late',
  missing: boolean,
  database?: LicenseDatabaseAdapter
) {
  const f = await makeCommandFixture(false);
  const adapter: LicenseDatabaseAdapter = database ?? f.adapter;
  const output = missing ? f.output : f.input;
  const prior = missing ? null : `${f.sourceBytes}\n  `;
  if (prior !== null) await writeFile(output, prior);
  const oldInode = prior === null ? undefined : (await stat(output, { bigint: true })).ino;
  let renames = 0;
  let pendingRestore = '';
  let inject = true;
  const syscall = vi.spyOn(licenseFileIo, 'rename').mockImplementation(async (from, to) => {
    renames++;
    if (!inject || renames !== (stage === 'publication' ? 1 : 2)) return rename(from, to);
    if (outcome === 'late' && stage === 'compensation') pendingRestore = from;
    if (outcome === 'foreign' || outcome === 'installed') await rename(from, to);
    if (outcome === 'foreign') {
      const outsider = `${f.dir}/outside`;
      await writeFile(outsider, 'independent replacement');
      await rename(outsider, to);
    }
    throw new Error('Rename acknowledgement unavailable');
  });
  const cleanup = vi.spyOn(licenseFileIo, 'remove').mockImplementation(async (path) => {
    if (inject && outcome === 'late' && path.endsWith('.tmp')) await rename(path, output);
    return unlink(path);
  });
  const workflow = new LicenseWorkflow(
    { ...f.options, output, destination: 'both' },
    {
      apiKey: '',
      destinationDatabase: async () => ({
        ...adapter,
        apply: async (artifact, replace, publish, force, policy, identity) => {
          try {
            await adapter.apply(
              artifact,
              replace,
              async () => {
                await publish?.();
                if (inject && stage === 'compensation')
                  throw new Error('Abort disposable transaction');
              },
              force,
              policy,
              identity
            );
          } catch (cause) {
            if (!database) throw new LicenseDatabaseAbortedError(cause);
            throw cause;
          }
        },
      }),
    }
  );
  try {
    await workflow.inspect(1);
    const preview = await workflow.preview(1, 1);
    const planned = serializeLicenseArtifact(preview.plan.jsonArtifact!).bytes;
    const request = {
      previewToken: preview.token,
      operationId: crypto.randomUUID(),
      configurationRevision: 1,
      contentRevision: 1,
      agreeToReplace: false,
    };
    const save = workflow.save(request);
    const uncertain =
      outcome === 'foreign' ||
      outcome === 'late' ||
      (stage === 'compensation' && outcome === 'unchanged');
    if (uncertain) {
      await expect(save).rejects.toBeInstanceOf(LicenseWriteUncertainError);
      expect(workflow.status.state).toBe('uncertain');
      const checked = await workflow.reconcileSave(request.operationId);
      expect(checked.outcome).toBe('uncertain');
      expect(checked.targets).toContainEqual({
        target: output,
        match: outcome === 'foreign' ? 'other' : 'planned',
      });
      if (database)
        expect(checked.targets).toContainEqual({
          target: 'license_classifications',
          match: 'prior',
        });
      expect(await licenseFileIo.read(output)).toBe(
        outcome === 'foreign' ? 'independent replacement' : planned
      );
      await expect(workflow.preview(1, 1)).rejects.toThrow('uncertain');
    } else {
      await expect(save).rejects.toThrow('did not commit');
      expect(workflow.status.state).toBe('reviewing');
      expect(await licenseFileIo.read(output)).toBe(prior);
      if (stage === 'publication' && outcome === 'unchanged' && prior !== null)
        expect((await stat(output, { bigint: true })).ino).toBe(oldInode);
    }
    expect((await adapter.load()).classifications).toHaveLength(0);
    if (pendingRestore) {
      await rename(pendingRestore, output);
      const checked = await workflow.reconcileSave(request.operationId);
      expect(checked.targets).toContainEqual({ target: output, match: 'prior' });
      expect(checked.outcome).toBe(database ? 'prior' : 'uncertain');
    }
    if (!uncertain || (pendingRestore && database)) {
      inject = false;
      if (pendingRestore)
        await expect(workflow.save(request)).rejects.toBeInstanceOf(LicenseWriteUncertainError);
      else await expect(workflow.save(request)).rejects.toThrow('did not commit');
      const fresh = await workflow.preview(1, 1);
      expect(fresh.token).not.toBe(request.previewToken);
      await workflow.save({
        ...request,
        operationId: crypto.randomUUID(),
        previewToken: fresh.token,
      });
      expect(workflow.status.state).toBe('saved');
      expect(await licenseFileIo.read(output)).toBe(planned);
      if (database)
        expect((await adapter.load()).classifications).toHaveLength(
          f.artifact.classifications.length
        );
    }
  } finally {
    cleanup.mockRestore();
    syscall.mockRestore();
    await workflow.close();
    await f.cleanup();
  }
}
