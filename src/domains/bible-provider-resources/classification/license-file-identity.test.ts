import { copyFile, link, lstat, mkdir, readlink, rename, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { makeCommandFixture } from './license-command.test-fixtures';
import { inspectLicenseFile } from './license-file-identity';
import { LicenseWorkflow } from './license-workflow';

let f: Awaited<ReturnType<typeof makeCommandFixture>>;
let workflow: LicenseWorkflow;
beforeEach(async () => {
  f = await makeCommandFixture(false);
  workflow = new LicenseWorkflow(f.options, {
    ...f.dependencies,
    destinationDatabase: f.dependencies.database,
  });
});
afterEach(async () => {
  await workflow.close();
  await f.cleanup();
});

it('publishes a same-file symlink to its target and preserves the link', async () => {
  await symlink(f.input, f.output);
  await workflow.inspect(1);
  const preview = await workflow.preview(1, 1);
  expect(preview.plan.overwriteJson).toBe(true);
  expect(preview.plan.targets[0].path).toBe(f.input);
  await workflow.save({
    previewToken: workflow.previewed!.token,
    operationId: 'alias',
    configurationRevision: 1,
    contentRevision: 1,
    agreeToReplace: false,
  });
  expect(await readlink(f.output)).toBe(f.input);
});

it('treats distinct equal files as sync and detects equal-byte inode replacement before Save', async () => {
  await copyFile(f.input, f.output);
  await workflow.inspect(1);
  expect((await workflow.preview(1, 1)).plan.overwriteJson).toBe(false);
  const other = join(f.dir, 'other.json');
  await copyFile(f.input, other);
  await rename(other, f.output);
  await expect(
    workflow.save({
      previewToken: workflow.previewed!.token,
      operationId: 'changed',
      configurationRevision: 1,
      contentRevision: 1,
      agreeToReplace: false,
    })
  ).rejects.toThrow(/destination changed/i);
});
it('rejects hard-link publication and equal-byte source replacement', async () => {
  await link(f.input, f.output);
  await workflow.inspect(1);
  await expect(workflow.preview(1, 1)).rejects.toThrow(/multiply linked/);
  await unlink(f.output);
  await copyFile(f.input, f.output);
  await rename(f.output, f.input);
  await expect(workflow.preview(1, 1)).rejects.toThrow(/changed/);
});
it('resolves absent filenames through physical parent directories and refuses symlink escapes', async () => {
  const mount = join(f.dir, 'mount');
  await mkdir(mount);
  await symlink(mount, join(f.dir, 'alias'));
  const file = await inspectLicenseFile(join(f.dir, 'alias', 'new.json'), mount);
  expect(file.canonical).toBe(join(mount, 'new.json'));
  expect(file.inode).toBeNull();
  await symlink(f.input, join(mount, 'escape'));
  await expect(inspectLicenseFile(join(mount, 'escape'), mount)).rejects.toThrow(/outside/);
  expect((await lstat(f.input)).isFile()).toBe(true);
});
