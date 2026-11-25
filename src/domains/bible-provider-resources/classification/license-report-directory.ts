import { constants } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

export interface ReportDirectory {
  canonical: string;
  ancestor: string;
  inode: string;
}

const changed = () =>
  new Error('The report target directory changed. Inspect the report path again.');
const missing = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';
const identity = (entry: { dev: bigint; ino: bigint; birthtimeNs: bigint }) =>
  `${entry.dev}:${entry.ino}:${entry.birthtimeNs}`;

/** A missing suffix is resolved relative to the physical directory that exists at consent. */
export async function inspectReportDirectory(directory: string): Promise<ReportDirectory> {
  let parent = directory;
  for (;;) {
    const canonical = await realpath(parent).catch((error) => {
      if (!missing(error)) throw error;
      return null;
    });
    if (canonical !== null) {
      const entry = await stat(canonical, { bigint: true });
      if (!entry.isDirectory()) throw changed();
      return {
        canonical: resolve(canonical, relative(parent, directory)),
        ancestor: canonical,
        inode: identity(entry),
      };
    }
    // Do not interpret a dangling link as a directory which can be created.
    const entry = await lstat(parent).catch((error) => {
      if (!missing(error)) throw error;
    });
    if (entry || dirname(parent) === parent) throw changed();
    parent = dirname(parent);
  }
}

export async function requireReportDirectory(directory: string, saved: ReportDirectory) {
  const current = await inspectReportDirectory(directory);
  if (
    saved.canonical !== current.canonical ||
    identity(await stat(saved.ancestor, { bigint: true })) !== saved.inode
  )
    throw changed();
}

/** Pin the physical directory through staging, publication and cleanup on Linux. On other hosts
 * resolve operations against the inspected canonical directory and verify the mapping again. */
export async function withReportDirectory(
  directory: string,
  saved: ReportDirectory,
  mkdir: (path: string) => Promise<void>,
  publish: (physical: string, verify: (checkSelection?: boolean) => Promise<void>) => Promise<void>
) {
  await requireReportDirectory(directory, saved);
  const suffix = relative(saved.ancestor, saved.canonical).split(sep).filter(Boolean);
  if (process.platform !== 'linux') {
    let parent = saved.ancestor;
    for (const part of suffix) {
      await requireReportDirectory(directory, saved);
      parent = join(parent, part);
      await mkdir(parent);
    }
    const final = await inspectReportDirectory(directory);
    if (final.canonical !== saved.canonical || final.ancestor !== saved.canonical) throw changed();
    await publish(saved.canonical, (checkSelection = true) =>
      requireReportDirectory(checkSelection ? directory : saved.canonical, final)
    );
    return;
  }
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  let handle = await open(saved.ancestor, flags);
  try {
    if (identity(await handle.stat({ bigint: true })) !== saved.inode) throw changed();
    for (const part of suffix) {
      await requireReportDirectory(directory, saved);
      const child = join(`/proc/self/fd/${handle.fd}`, part);
      await mkdir(child);
      const next = await open(child, flags);
      await handle.close();
      handle = next;
    }
    const physical = `/proc/self/fd/${handle.fd}`;
    const inode = identity(await handle.stat({ bigint: true }));
    const verify = async (checkSelection = true) => {
      if (!checkSelection) return; // The descriptor still owns the physical staging directory.
      await requireReportDirectory(directory, saved);
      if (identity(await stat(directory, { bigint: true })) !== inode) throw changed();
    };
    await verify();
    await publish(physical, verify);
  } finally {
    await handle.close();
  }
}
