import { readFile, readlink, symlink, unlink, writeFile } from 'node:fs/promises';
import postgres from 'postgres';
import { expect, vi } from 'vitest';

import type { LicenseDatabaseAdapter } from './license-database.types';

import { serializeLicenseArtifact } from '../license-artifact';
import { createOwnedLicenseDatabaseAdapter } from './license-classifications.service';
import { makeCommandFixture } from './license-command.test-fixtures';
import { licenseReviewRowId } from './license-workbench-review';
import { startLicenseWorkbenchServer } from './license-workbench-server';
import { LicenseWorkflow } from './license-workflow';
import { licenseFileIo, LicenseWriteUncertainError } from './license-write';

export async function exerciseDelayedSave(
  endpoint: string,
  finish: 'rollback' | 'commit' | 'mixed'
) {
  const fixture = await makeCommandFixture(false);
  const url = `postgres://api_user@${endpoint}/postgres`;
  const independent = postgres(url, { max: 1 });
  const application = `license-fence-${crypto.randomUUID()}`;
  const writer = createOwnedLicenseDatabaseAdapter(`${url}?application_name=${application}`);
  const published = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let physicalWrite: Promise<void> | undefined;
  let calls = 0;
  const intercepted: LicenseDatabaseAdapter = {
    ...writer,
    apply: async (artifact, replace, publish, force, policy, identity) => {
      ++calls;
      if (calls > 1) return writer.apply(artifact, replace, publish, force, policy, identity);
      physicalWrite = writer.apply(
        artifact,
        replace,
        async () => {
          await publish?.();
          published.resolve();
          await release.promise;
          if (finish === 'rollback') throw new Error('Abort disposable transaction');
        },
        force,
        policy,
        identity
      );
      await Promise.race([physicalWrite, published.promise]);
      throw new Error('Lost transaction acknowledgement');
    },
  };
  await independent`DELETE FROM license_classifications`;
  const output = finish === 'rollback' ? fixture.input : fixture.output;
  await writeFile(output, fixture.sourceBytes);
  const server = await startLicenseWorkbenchServer(
    { ...fixture.options, output, destination: finish === 'commit' ? 'database' : 'both' },
    0,
    false,
    undefined,
    {
      apiKey: '',
      destinationDatabase: async () => intercepted,
    }
  );
  const base = new URL(server.url).origin;
  const headers = {
    origin: base,
    'content-type': 'application/json',
    'x-workbench-token': new URL(server.url).hash.slice(1),
  };
  const post = (route: string, body: unknown, auth = headers) =>
    fetch(`${base}/api/${route}`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
  const setup = async () => (await fetch(`${base}/api/setup`, { headers })).json();
  const id = crypto.randomUUID();
  const reconcile = () => post('save/reconcile', { operationId: id });
  try {
    expect(
      (await post('inspect', { operationId: crypto.randomUUID(), configurationRevision: 1 })).status
    ).toBe(202);
    await vi.waitFor(async () => expect((await setup()).state).toBe('inspected'));
    const revisions = { configurationRevision: 1, contentRevision: 1 };
    const row = fixture.artifact.classifications[0];
    const edit = {
      ...revisions,
      id: licenseReviewRowId(row.normalizedText),
      acknowledgeWarning: true,
      edit: {
        kind: 'disposition',
        status: 'allowed',
        normalizedText: row.normalizedText,
        reason: 'Reviewed disposition',
        reviewedBy: 'Fixture reviewer',
      },
    };
    expect((await post('review/edit', edit)).status).toBe(200);
    revisions.contentRevision++;
    const preview = await (await post('preview', revisions)).json();
    const request = {
      ...revisions,
      operationId: id,
      previewToken: preview.preview.token,
      agreeToReplace: false,
    };
    expect((await post('save', request)).status).toBe(202);
    await vi.waitFor(async () => expect((await setup()).state).toBe('uncertain'), {
      timeout: 6000,
    });
    const actual = () => independent`SELECT normalized_text FROM license_classifications`;
    expect(await actual()).toHaveLength(0);
    expect(await readFile(output, 'utf8')).toBe(fixture.sourceBytes);
    expect(
      (
        await post(
          'save/reconcile',
          { operationId: id },
          { ...headers, 'x-workbench-token': 'wrong' }
        )
      ).status
    ).toBe(403);
    expect(
      (
        await post(
          'save/reconcile',
          { operationId: id },
          { ...headers, origin: 'http://wrong.invalid' }
        )
      ).status
    ).toBe(403);
    expect((await post('save/reconcile', { operationId: crypto.randomUUID() })).status).toBe(409);
    const early = await (await reconcile()).json();
    expect(early.reconciliation).toMatchObject({
      outcome: 'uncertain',
      targets: expect.arrayContaining([{ target: 'license_classifications', match: 'unverified' }]),
    });
    expect((await post('preview', revisions)).status).toBe(409);
    expect((await post('review/edit', { ...edit, ...revisions })).status).toBe(409);
    expect((await post('save', { ...request, operationId: crypto.randomUUID() })).status).toBe(409);
    // Only the observer is idle while the separate writer is inside its locked transaction.
    const witness = await independent<
      { pid: number }[]
    >`SELECT pid FROM pg_stat_activity WHERE application_name = ${application} AND state = 'idle'`;
    expect(witness).toHaveLength(1);
    release.resolve();
    await physicalWrite?.catch(() => undefined);
    const terminal = await (await reconcile()).json();
    expect(terminal.reconciliation.outcome).toBe(
      finish === 'rollback' ? 'prior' : finish === 'commit' ? 'planned' : 'uncertain'
    );
    expect(terminal.reconciliation.targets).toContainEqual({
      target: 'license_classifications',
      match: finish === 'rollback' ? 'prior' : 'planned',
    });
    if (finish !== 'commit')
      expect(terminal.reconciliation.targets).toContainEqual({
        target: output,
        match: 'prior',
      });
    expect(await actual()).toHaveLength(
      finish === 'rollback' ? 0 : fixture.artifact.classifications.length
    );
    expect((await (await post('save', request)).json()).state).toBe(
      finish === 'commit' ? 'succeeded' : 'failed'
    );
    expect(calls).toBe(1);
    if (finish === 'mixed') {
      const [termination] =
        await independent`SELECT pg_terminate_backend(${witness[0].pid}, 3000) AS stopped`;
      expect(termination.stopped).toBe(true);
      const lost = await (await reconcile()).json();
      expect(lost.reconciliation).toMatchObject({
        outcome: 'uncertain',
        targets: expect.arrayContaining([
          { target: 'license_classifications', match: 'unverified' },
        ]),
      });
      expect((await post('preview', revisions)).status).toBe(409);
    }
    if (finish === 'rollback') {
      const fresh = await (await post('preview', revisions)).json();
      expect(fresh.preview.token).not.toBe(request.previewToken);
      expect(
        (
          await post('save', {
            ...request,
            operationId: crypto.randomUUID(),
            previewToken: fresh.preview.token,
          })
        ).status
      ).toBe(202);
      await vi.waitFor(async () => expect((await setup()).state).toBe('saved'));
      expect(calls).toBe(2);
    }
  } finally {
    release.resolve();
    await physicalWrite?.catch(() => undefined);
    await server.close();
    await independent.end();
    await fixture.cleanup();
  }
}

export async function exerciseBothDrift(
  endpoint: string,
  drift: 'catalog' | 'policy' | 'file' | 'lock' | 'lock-cleanup'
) {
  const f = await makeCommandFixture(false);
  const url = `postgres://api_user@${endpoint}/postgres`;
  const independent = postgres(url, { max: 1 });
  const writer = createOwnedLicenseDatabaseAdapter(url);
  const concurrent = createOwnedLicenseDatabaseAdapter(url);
  const block = drift.startsWith('lock');
  const cleanup = drift === 'lock-cleanup';
  let temporary = '';
  const locked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let blocker: Promise<unknown> | undefined;
  await independent`DELETE FROM license_classifications`;
  await writeFile(f.output, f.sourceBytes);
  const workflow = new LicenseWorkflow(
    { ...f.options, destination: 'both' },
    {
      apiKey: '',
      fs: cleanup
        ? {
            ...licenseFileIo,
            remove: async (path) => {
              if (path.endsWith('.tmp')) {
                temporary = path;
                throw Object.assign(new Error('Cleanup denied'), { code: 'EACCES' });
              }
              await licenseFileIo.remove(path);
            },
          }
        : undefined,
      destinationDatabase: async () => ({
        ...writer,
        apply: async (artifact, replace, publish, force, policy, identity) => {
          if (block && !blocker) {
            blocker = independent.begin(async (tx) => {
              await tx`LOCK TABLE license_classifications IN SHARE ROW EXCLUSIVE MODE`;
              locked.resolve();
              await release.promise;
            });
            await Promise.race([locked.promise, blocker]);
          }
          if (drift === 'catalog') {
            await independent`INSERT INTO bibles (id, provider, external_id, name) VALUES (800, 'dbl', '5c-fixture', 'Fixture')`;
            await independent`INSERT INTO bible_provider_resources (provider, external_id, text_license_notice) VALUES ('dbl', '5c-fixture', 'Changed catalog')`;
          }
          if (drift === 'policy') await concurrent.apply(f.artifact, false);
          return writer.apply(
            artifact,
            replace,
            async () => {
              if (drift === 'file') await writeFile(f.output, 'external bytes');
              await publish?.();
            },
            force,
            policy,
            identity
          );
        },
      }),
    }
  );
  try {
    await workflow.inspect(1);
    const preview = await workflow.preview(1, 1);
    const request = {
      previewToken: preview.token,
      operationId: crypto.randomUUID(),
      contentRevision: 1,
      configurationRevision: 1,
      agreeToReplace: false,
    };
    const save = workflow.save(request);
    if (cleanup) {
      const error = await save.catch((error: unknown) => error);
      if (!(error instanceof LicenseWriteUncertainError)) throw error;
      expect(error.recovery.retainedTemporary).toContain(`${temporary} (cleanup unverified)`);
      expect(workflow.status.state).toBe('uncertain');
      expect(temporary).toMatch(/\.tmp$/);
      expect(await readFile(temporary, 'utf8')).toBe(
        serializeLicenseArtifact(preview.plan.jsonArtifact!).bytes
      );
      await expect(workflow.preview(1, 1)).rejects.toThrow('uncertain');
    } else {
      await expect(save).rejects.toThrow(block ? /did not commit/i : /changed/i);
      expect(workflow.status.state).toBe('reviewing');
    }
    release.resolve();
    await blocker;
    expect(await readFile(f.output, 'utf8')).toBe(
      drift === 'file' ? 'external bytes' : f.sourceBytes
    );
    expect((await concurrent.load()).classifications.length).toBe(
      drift === 'policy' ? f.artifact.classifications.length : 0
    );
    if (cleanup) {
      const check = () => workflow.reconcileSave(request.operationId);
      expect(await check()).toMatchObject({
        outcome: 'uncertain',
        targets: expect.arrayContaining([
          { target: 'license_classifications', match: 'prior' },
          { target: temporary, match: 'unverified' },
        ]),
      });
      await unlink(temporary);
      const dangling = `${f.dir}/does-not-exist`;
      await symlink(dangling, temporary);
      expect((await check()).outcome).toBe('uncertain');
      expect(await readlink(temporary)).toBe(dangling);
      await unlink(temporary);
      await writeFile(temporary, 'external replacement');
      expect((await check()).outcome).toBe('uncertain');
      expect(await readFile(temporary, 'utf8')).toBe('external replacement');
      await unlink(temporary);
      await concurrent.apply(f.artifact, false);
      expect(await check()).toMatchObject({
        outcome: 'uncertain',
        targets: expect.arrayContaining([{ target: 'license_classifications', match: 'other' }]),
      });
      await independent`DELETE FROM license_classifications`;
      expect((await check()).outcome).toBe('prior');
    }
    if (block) {
      const fresh = await workflow.preview(1, 1);
      expect(fresh.token).not.toBe(preview.token);
      await workflow.save({
        previewToken: fresh.token,
        operationId: crypto.randomUUID(),
        contentRevision: 1,
        configurationRevision: 1,
        agreeToReplace: false,
      });
      expect(workflow.status.state).toBe('saved');
      expect((await concurrent.load()).classifications).toHaveLength(
        f.artifact.classifications.length
      );
    }
  } finally {
    release.resolve();
    await blocker;
    await independent`DELETE FROM bible_provider_resources WHERE external_id = '5c-fixture'`;
    await independent`DELETE FROM bibles WHERE external_id = '5c-fixture'`;
    await Promise.all([independent.end(), concurrent.close?.(), workflow.close(), f.cleanup()]);
  }
}

export async function withEmptyLicenseTarget(
  endpoint: string,
  run: (target: LicenseDatabaseAdapter, independent: ReturnType<typeof postgres>) => Promise<void>
) {
  const url = `postgres://api_user@${endpoint}/postgres`;
  const independent = postgres(url, { max: 1 });
  const target = createOwnedLicenseDatabaseAdapter(url);
  try {
    await independent`DELETE FROM license_classifications`;
    await run(target, independent);
  } finally {
    await independent.end();
    await target.close?.();
  }
}
