import { lstat, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface LicenseFileIdentity {
  path: string;
  canonical: string;
  root?: string;
  inode: string | null;
  links: string | null;
}

const missing = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!missing(error)) throw error;
    // A dangling symlink is an existing entry with an unresolved target.
    const entry = await lstat(path).catch((error) => {
      if (!missing(error)) throw error;
    });
    if (entry || dirname(path) === path) throw new Error('Cannot resolve selected JSON path');
    return join(await canonicalPath(dirname(path)), basename(path));
  }
}

export async function inspectLicenseFile(
  path: string,
  root?: string
): Promise<LicenseFileIdentity> {
  path = resolve(path);
  const canonical = await canonicalPath(path);
  if (root) {
    const suffix = relative(await realpath(root), canonical);
    if (!suffix || isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..${sep}`))
      throw new Error('Selected JSON path is outside its authorized directory');
  }
  const info = await stat(canonical, { bigint: true }).catch((error) => {
    if (!missing(error)) throw error;
  });
  if (info && !info.isFile()) throw new Error('Selected JSON path must be a regular file');
  return {
    path,
    canonical,
    root,
    inode: info ? `${info.dev}:${info.ino}` : null,
    links: info?.nlink.toString() ?? null,
  };
}

export function reviewerJsonRoot(practice?: { input: string }) {
  return practice
    ? dirname(practice.input)
    : process.env.LICENSE_REVIEWER_CONTAINER === '1'
      ? '/app/docs/features/tts-license-ingestion/reference'
      : undefined;
}

export async function matchesLicenseFile(identity: LicenseFileIdentity) {
  const current = await inspectLicenseFile(identity.path, identity.root).catch(() => undefined);
  if (!current) return false;
  return (
    current.canonical === identity.canonical &&
    current.inode === identity.inode &&
    current.links === identity.links
  );
}
