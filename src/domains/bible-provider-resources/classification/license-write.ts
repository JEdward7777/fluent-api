import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { LicenseArtifact } from '../license-artifact.schemas';
import type { LicenseDatabaseAdapter, StoredLicenseClassification } from './license-database.types';

import { checkLicenseArtifactReview, serializeLicenseArtifact } from '../license-artifact';
import { LicensePolicyDriftError } from './license-database.types';

export interface LicenseFileIo {
  read: (path: string) => Promise<string | null>;
  write: (path: string, bytes: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  remove: (path: string) => Promise<void>;
  mkdir: (path: string) => Promise<void>;
}

interface LicenseExpectedFile {
  path: string;
  bytes: string | null;
}

export class LicenseFileDriftError extends Error {
  constructor(path: string) {
    super(`Inspected file changed: ${path}. Inspect and preview again before saving.`);
    this.name = 'LicenseFileDriftError';
  }
}
class LicenseWriteUncertainError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'LicenseWriteUncertainError';
  }
}
export const licenseFileIo: LicenseFileIo = {
  read: async (path) => {
    try {
      const bytes = await readFile(path);
      const text = bytes.toString('utf8');
      if (!Buffer.from(text, 'utf8').equals(bytes))
        throw new Error(`File is not valid UTF-8; cannot establish exact baseline: ${path}`);
      return text;
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
  /** Invocation-scoped source and target bytes. Omit to preserve legacy CLI behavior. */
  expectedFiles?: LicenseExpectedFile[];
  expectedPolicy?: StoredLicenseClassification[];
}) {
  const fs = options.fs ?? licenseFileIo;
  const { bytes } = serializeLicenseArtifact(options.artifact);
  if (checkLicenseArtifactReview(JSON.parse(bytes)).status === 'invalid')
    throw new Error('Invalid staged JSON');
  const expected = options.expectedFiles;
  if (expected) {
    const paths = new Set(expected.map((file) => file.path));
    if (paths.size !== expected.length) throw new Error('Duplicate expected file path');
    for (const file of options.files) {
      const baseline = expected.find((candidate) => candidate.path === file.path);
      if (!baseline || baseline.bytes !== file.previous)
        throw new Error(`Missing or mismatched expected bytes for target: ${file.path}`);
    }
  }
  const staged: {
    path: string;
    temporary: string;
    previous: string | null;
    replaced: boolean;
    retained: boolean;
  }[] = [];
  const requireExpectedFiles = async () => {
    for (const file of expected ?? []) {
      const published = staged.some(
        (candidate) => candidate.path === file.path && candidate.replaced
      );
      if ((await fs.read(file.path)) !== (published ? bytes : file.bytes))
        throw new LicenseFileDriftError(file.path);
    }
  };
  try {
    await requireExpectedFiles();
    // Preflight every file before staging any DB mutation. Sources were captured before review.
    for (const file of options.files) {
      await fs.mkdir(dirname(file.path));
      const temporary = `${file.path}.${randomUUID()}.tmp`;
      staged.push({ ...file, temporary, replaced: false, retained: false });
      await fs.write(temporary, bytes);
    }
    await requireExpectedFiles();
    const publish = async () => {
      await requireExpectedFiles();
      for (const file of staged) {
        // A last-moment read detects ordinary external edits, but is not an OS compare-and-swap.
        await requireExpectedFiles();
        await fs.rename(file.temporary, file.path);
        file.replaced = true;
      }
    };
    if (options.database)
      await options.database.apply(
        options.artifact,
        options.replace,
        publish,
        options.force,
        options.expectedPolicy
      );
    else await publish();
  } catch (cause) {
    const failures: string[] = [];
    const retained: string[] = [];
    const retainedTemporary: string[] = [];
    const recoveryFailures: string[] = [];
    const preserveRecovery = async (file: (typeof staged)[number]) => {
      const suffix = randomUUID();
      const copies = [
        ...(file.previous === null
          ? []
          : [{ path: `${file.path}.${suffix}.prior.recovery`, bytes: file.previous }]),
        { path: `${file.path}.${suffix}.staged.recovery`, bytes },
      ];
      for (const copy of copies) {
        try {
          await fs.write(copy.path, copy.bytes);
          retained.push(copy.path);
        } catch {
          recoveryFailures.push(copy.path);
        }
      }
    };
    // Reverse publication order; retain exact prior bytes, not a reserialized approximation.
    for (const file of [...staged].reverse()) {
      if (!file.replaced) continue;
      try {
        if (expected && (await fs.read(file.path)) !== bytes) {
          // Preserve the external edit and both known revisions for manual reconciliation.
          await preserveRecovery(file);
          failures.push(file.path);
          continue;
        }
        if (file.previous === null) await fs.remove(file.path);
        else {
          await fs.write(file.temporary, file.previous);
          await fs.rename(file.temporary, file.path);
        }
      } catch {
        await preserveRecovery(file);
        try {
          const temporaryBytes = await fs.read(file.temporary);
          if (temporaryBytes !== null) {
            file.retained = true;
            const role = temporaryBytes === file.previous ? 'prior bytes' : 'contents uncertain';
            retainedTemporary.push(`${file.temporary} (${role})`);
          }
        } catch {
          // Keep an unreadable temporary path: it may hold the only surviving prior bytes.
          file.retained = true;
          retainedTemporary.push(`${file.temporary} (unverified; read failed)`);
        }
        failures.push(file.path);
      }
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    if (
      (cause instanceof LicenseFileDriftError || cause instanceof LicensePolicyDriftError) &&
      !staged.some((file) => file.replaced)
    )
      throw cause;
    if (failures.length)
      throw new LicenseWriteUncertainError(
        `Database/file operation failed: ${message}. DIVERGENCE: unable to restore ${failures.join(', ')}. Recovery files: ${retained.join(', ') || 'none written'}; retained temporary files: ${retainedTemporary.join(', ') || 'none confirmed'}${recoveryFailures.length ? `; recovery writes failed: ${recoveryFailures.join(', ')}` : ''}. Inspect actual files and license_classifications before retrying.`,
        cause
      );
    throw new LicenseWriteUncertainError(
      `License write failed; prior JSON restored where applicable. Database commit outcome may be uncertain; inspect license_classifications before retrying: ${message}`,
      cause
    );
  } finally {
    for (const file of staged) {
      if (file.retained) continue;
      try {
        await fs.remove(file.temporary);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
          console.warn(`Could not remove temporary license file ${file.temporary}`);
      }
    }
  }
}
