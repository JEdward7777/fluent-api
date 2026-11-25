import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';

import type { LicenseFileIo } from './license-write';

interface TemporaryEntry {
  inode: string;
  links: string;
  regular: boolean;
}

export async function inspectTemporaryEntry(path: string): Promise<TemporaryEntry | null> {
  try {
    const entry = await lstat(path, { bigint: true });
    return {
      inode: `${entry.dev}:${entry.ino}`,
      links: entry.nlink.toString(),
      regular: entry.isFile(),
    };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

export interface LicenseTemporary {
  path: string;
  bytes: string;
  inode?: string;
  pending: boolean;
  renameAttempted?: boolean;
}

export async function stageTemporary(fs: LicenseFileIo, file: LicenseTemporary, bytes: string) {
  file.bytes = bytes;
  file.inode = undefined;
  file.renameAttempted = false;
  file.pending = true;
  await fs.write(file.path, bytes, (inode) => {
    file.inode = inode;
  });
}

/** Read only the authenticated regular inode, even if its name is replaced during open. */
export async function matchesStagedBytes(path: string, inode: string, bytes: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const same = async () => {
      const entry = await handle.stat({ bigint: true });
      return entry.isFile() && entry.nlink === 1n && `${entry.dev}:${entry.ino}` === inode;
    };
    return (
      (await same()) &&
      (await handle.readFile()).equals(Buffer.from(bytes, 'utf8')) &&
      (await same())
    );
  } finally {
    await handle.close();
  }
}

export async function temporaryState(
  fs: LicenseFileIo,
  file: Pick<LicenseTemporary, 'path' | 'inode' | 'bytes'>
) {
  if (!fs.entry) return 'unverified';
  const owned = (entry: TemporaryEntry | null) =>
    entry?.regular && entry.links === '1' && entry.inode === file.inode;
  try {
    const before = await fs.entry(file.path);
    if (!before) return 'absent';
    if (
      !file.inode ||
      !owned(before) ||
      !(await fs.matchesStagedBytes?.(file.path, file.inode, file.bytes))
    )
      return 'unverified';
    return owned(await fs.entry(file.path)) ? 'owned' : 'unverified';
  } catch {
    return 'unverified';
  }
}

export async function publishTemporary(
  fs: LicenseFileIo,
  file: LicenseTemporary,
  destination: string
) {
  if ((await temporaryState(fs, file)) !== 'owned')
    throw new Error('Staged JSON identity or bytes changed before atomic replacement');
  file.renameAttempted = true;
  await fs.rename(file.path, destination);
  file.pending = false;
}

/** Both exact bytes and the created inode identify a completed but unacknowledged rename. */
export async function installedAfterRename(
  fs: LicenseFileIo,
  file: LicenseTemporary,
  destination: string
) {
  if (
    !file.renameAttempted ||
    (await temporaryState(fs, { ...file, path: destination })) !== 'owned'
  )
    return false;
  // A foreign or unreadable entry at the old name is retained for cleanup reconciliation.
  if (
    fs.entry &&
    (await fs.entry(file.path).then(
      (entry) => entry === null,
      () => false
    ))
  )
    file.pending = false;
  return true;
}

export async function priorFileMatches(
  fs: LicenseFileIo,
  path: string,
  bytes: string | null,
  inode?: string | null
) {
  if (bytes === null)
    return (
      inode === null &&
      Boolean(
        fs.entry &&
        (await fs.entry(path).then(
          (entry) => entry === null,
          () => false
        ))
      )
    );
  return (await temporaryState(fs, { path, bytes, inode: inode ?? undefined })) === 'owned';
}

/** A moved temporary name is free for other callers. Only unlink our surviving revision. */
export async function cleanupTemporary(fs: LicenseFileIo, file: LicenseTemporary) {
  if (!file.pending) return true;
  const state = await temporaryState(fs, file);
  if (state === 'absent') return true;
  if (state !== 'owned' || !fs.entry) return false;
  try {
    await fs.remove(file.path);
  } catch {
    /* Check the directory entry after an ambiguous unlink. */
  }
  return fs.entry(file.path).then(
    (entry) => entry === null,
    () => false
  );
}
