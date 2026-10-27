import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { LicenseArtifact } from '../license-artifact.schemas';
import type { LicenseDatabaseAdapter } from './license-database.types';

import { checkLicenseArtifactReview, serializeLicenseArtifact } from '../license-artifact';

export interface LicenseFileIo {
  read: (path: string) => Promise<string | null>;
  write: (path: string, bytes: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  remove: (path: string) => Promise<void>;
  mkdir: (path: string) => Promise<void>;
}
export const licenseFileIo: LicenseFileIo = {
  read: async (path) => {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
  },
  write: (path, bytes) => writeFile(path, bytes, { encoding: 'utf8', mode: 0o600 }),
  rename,
  remove: unlink,
  mkdir: async (path) => {
    await mkdir(path, { recursive: true });
  },
};

/** Bounded compensation, not distributed atomicity: staged DB, atomic files, then DB commit. */
export async function writeLicenseDestinations(options: {
  artifact: LicenseArtifact;
  files: { path: string; previous: string | null }[];
  database?: LicenseDatabaseAdapter;
  replace: boolean;
  force?: boolean;
  fs?: LicenseFileIo;
}) {
  const fs = options.fs ?? licenseFileIo;
  const { bytes } = serializeLicenseArtifact(options.artifact);
  if (checkLicenseArtifactReview(JSON.parse(bytes)).status === 'invalid')
    throw new Error('Invalid staged JSON');
  const staged: { path: string; temporary: string; previous: string | null; replaced: boolean }[] =
    [];
  try {
    // Preflight every file before staging any DB mutation. Sources were captured before review.
    for (const file of options.files) {
      await fs.mkdir(dirname(file.path));
      const temporary = `${file.path}.${randomUUID()}.tmp`;
      staged.push({ ...file, temporary, replaced: false });
      await fs.write(temporary, bytes);
    }
    const publish = async () => {
      for (const file of staged) {
        await fs.rename(file.temporary, file.path);
        file.replaced = true;
      }
    };
    if (options.database)
      await options.database.apply(options.artifact, options.replace, publish, options.force);
    else await publish();
  } catch (cause) {
    const failures: string[] = [];
    // Reverse publication order; retain exact prior bytes, not a reserialized approximation.
    for (const file of [...staged].reverse()) {
      if (!file.replaced) continue;
      try {
        if (file.previous === null) await fs.remove(file.path);
        else {
          await fs.write(file.temporary, file.previous);
          await fs.rename(file.temporary, file.path);
        }
      } catch {
        failures.push(file.path);
      }
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    if (failures.length)
      throw new Error(
        `Database/file operation failed: ${message}. DIVERGENCE: unable to restore ${failures.join(', ')}. Restore these files from their prior reviewed revision and compare license_classifications before retrying.`,
        { cause }
      );
    throw new Error(
      `License write failed; prior JSON restored. Verify license_classifications before retrying if the database commit outcome was uncertain: ${message}`,
      { cause }
    );
  } finally {
    for (const file of staged) {
      try {
        await fs.remove(file.temporary);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
          console.warn(`Could not remove temporary license file ${file.temporary}`);
      }
    }
  }
}
