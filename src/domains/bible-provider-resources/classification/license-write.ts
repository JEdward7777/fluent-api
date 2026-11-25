import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { LicenseArtifact } from '../license-artifact.schemas';
import type { LicenseDatabaseAdapter, StoredLicenseClassification } from './license-database.types';
import type { LicenseFileIdentity } from './license-file-identity';
import type { DatabaseFence, TargetMatch } from './license-write-fence';
import type { LicenseTemporary } from './license-write-temporary';

import { checkLicenseArtifactReview, serializeLicenseArtifact } from '../license-artifact';
import { LicenseDatabaseAbortedError, LicensePolicyDriftError } from './license-database.types';
import { inspectLicenseFile } from './license-file-identity';
import { LicenseInspectionStaleError } from './license-freshness';
import { LicenseOutputRetirements } from './license-output-retirement';
import { targetMatch } from './license-write-fence';
import {
  cleanupTemporary,
  inspectTemporaryEntry,
  installedAfterRename,
  matchesStagedBytes,
  priorFileMatches,
  publishTemporary,
  stageTemporary,
  temporaryState,
} from './license-write-temporary';

export interface LicenseFileIo {
  entry?: typeof inspectTemporaryEntry;
  matchesStagedBytes?: typeof matchesStagedBytes;
  identity?: (path: string) => Promise<LicenseFileIdentity>;
  read: (path: string) => Promise<string | null>;
  write: (path: string, bytes: string, opened?: (inode: string) => void) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  remove: (path: string) => Promise<void>;
  mkdir: (path: string) => Promise<void>;
}

interface LicenseExpectedFile {
  path: string;
  bytes: string | null;
}

export class LicenseWritePreflightError extends Error {
  constructor(
    cause: unknown,
    readonly restoredFiles: LicenseFileIdentity[] = []
  ) {
    super('Save did not commit. Prepare a fresh preview before retrying.', { cause });
    this.name = 'LicenseWritePreflightError';
  }
}

export class LicenseFileDriftError extends Error {
  constructor(readonly path: string) {
    super(`Inspected file changed: ${path}. Inspect and preview again before saving.`);
    this.name = 'LicenseFileDriftError';
  }
}
export interface LicenseWriteRecovery {
  cleanupUnverified?: boolean;
  diverged: boolean;
  affectedPaths: string[];
  recoveryFiles: string[];
  retainedTemporary: string[];
  recoveryFailures: string[];
}
export interface LicenseReconciliation {
  outcome: 'planned' | 'prior' | 'uncertain';
  targets: { target: string; match: TargetMatch }[];
}
export class LicenseWriteUncertainError extends Error {
  constructor(
    message: string,
    cause: unknown,
    readonly recovery: LicenseWriteRecovery,
    readonly reconcile?: () => Promise<LicenseReconciliation>,
    readonly restoredFiles: LicenseFileIdentity[] = []
  ) {
    super(message, { cause });
    this.name = 'LicenseWriteUncertainError';
  }
}
export const licenseFileIo: LicenseFileIo = {
  identity: inspectLicenseFile,
  entry: inspectTemporaryEntry,
  matchesStagedBytes,
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
  write: async (path, bytes, opened) => {
    if (!opened) return writeFile(path, bytes, { encoding: 'utf8', mode: 0o600 });
    const file = await open(path, 'wx', 0o600);
    try {
      const entry = await file.stat({ bigint: true });
      opened(`${entry.dev}:${entry.ino}`);
      await file.writeFile(bytes, 'utf8');
    } finally {
      await file.close();
    }
  },
  rename,
  remove: unlink,
  mkdir: async (path) => {
    await mkdir(path, { recursive: true });
  },
};

/** Bounded compensation, not distributed atomicity: staged DB, atomic files, then DB commit. */
export async function writeLicenseDestinations(options: {
  artifact: LicenseArtifact;
  fileArtifact?: LicenseArtifact;
  files: { path: string; previous: string | null }[];
  database?: LicenseDatabaseAdapter;
  replace: boolean;
  force?: boolean;
  fs?: LicenseFileIo;
  /** Invocation-scoped source and target bytes. Omit to preserve legacy CLI behavior. */
  expectedFiles?: LicenseExpectedFile[];
  expectedPolicy?: StoredLicenseClassification[];
  databaseIdentity?: Parameters<LicenseDatabaseAdapter['apply']>[5];
  checkAbortedDatabase?: DatabaseFence;
  targetIdentity?: LicenseFileIdentity;
  captureFile?: (path: string, inode?: string) => void;
  checkSourceBeforePublish?: () => Promise<void>;
  checkFileIdentities?: () => Promise<void>;
}) {
  const fs = options.fs ?? licenseFileIo;
  // A DB delta contains only selected keys and is not a standalone JSON artifact.
  // Validate/serialize only an actual JSON destination, whose complete rows and
  // catalog were built and checked in the destination plan.
  const bytes = options.files.length
    ? serializeLicenseArtifact(options.fileArtifact ?? options.artifact).bytes
    : '';
  if (options.files.length && checkLicenseArtifactReview(JSON.parse(bytes)).status === 'invalid')
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
    temporary: LicenseTemporary;
    previous: string | null;
    priorIdentity?: LicenseFileIdentity;
    stagedInode?: string;
    restoreInode?: string;
    replaced: boolean;
    retained: boolean;
  }[] = [];
  const requireExpectedFiles = async () => {
    await options.checkFileIdentities?.();
    for (const file of expected ?? []) {
      const published = staged.some(
        (candidate) => candidate.path === file.path && candidate.replaced
      );
      if ((await fs.read(file.path)) !== (published ? bytes : file.bytes))
        throw new LicenseFileDriftError(file.path);
    }
  };
  const restoredFiles: LicenseFileIdentity[] = [];
  let writerStarted = false;
  let databaseAborted = false;
  const uncertainCleanup = new Set<string>();
  const retirements = new LicenseOutputRetirements(fs);
  let databaseFence: DatabaseFence | undefined;
  let publicationClosed = false;
  let publication: Promise<void> | undefined;
  const readFiles = async () => {
    const targets: LicenseReconciliation['targets'] = [];
    const pendingRemovals = await retirements.pendingOutputs();
    for (const path of uncertainCleanup) {
      // Only absence proves cleanup when the previous unlink or read failed.
      if (
        !fs.entry ||
        (await fs.entry(path).then(
          (entry) => entry !== null,
          () => true
        ))
      )
        targets.push({ target: path, match: 'unverified' });
    }
    for (const file of options.files) {
      if (pendingRemovals.has(file.path)) {
        targets.push({ target: file.path, match: 'unverified' });
        continue;
      }
      const entry = staged.find((candidate) => candidate.path === file.path);
      const selected = options.targetIdentity;
      let match: TargetMatch = 'unverified';
      try {
        const identify = () =>
          selected ? inspectLicenseFile(selected.path, selected.root) : fs.identity?.(file.path);
        const current = await identify();
        if (!current || current.canonical !== file.path) throw new Error('Target identity changed');
        const actual = await fs.read(file.path);
        const after = await identify();
        if (
          current &&
          current.canonical === file.path &&
          after?.canonical === current.canonical &&
          after.inode === current.inode &&
          after.links === current.links &&
          (current.links === null || current.links === '1')
        ) {
          if (
            entry?.restoreInode &&
            current.inode === entry.restoreInode &&
            actual === file.previous &&
            entry.priorIdentity?.inode !== current.inode
          ) {
            // Previously rejected compensation has now installed its exact prior revision.
            entry.priorIdentity = current;
            restoredFiles.push(current);
          }
          match = targetMatch(
            current.inode === (entry?.priorIdentity ?? selected)?.inode && actual === file.previous,
            current.inode === entry?.stagedInode && actual === bytes
          );
        }
      } catch {
        /* Unreadable, unauthorized or unresolved target stays fenced. */
      }
      targets.push({ target: file.path, match });
    }
    return targets;
  };
  const reconcile = async (): Promise<LicenseReconciliation> => {
    let observed: ReturnType<typeof readFiles> | undefined;
    const checkFiles = async () => {
      observed ??= readFiles();
      await observed;
    };
    const targets: LicenseReconciliation['targets'] = [];
    if (options.database) {
      const fence = databaseAborted
        ? (options.checkAbortedDatabase ?? databaseFence)
        : databaseFence;
      const match = await fence?.(checkFiles).catch(() => 'unverified' as const);
      targets.push({ target: 'license_classifications', match: match ?? 'unverified' });
    }
    targets.push(...(await (observed ?? readFiles())));
    const all = (side: 'prior' | 'planned') =>
      targets.length > 0 && targets.every(({ match }) => match === side || match === 'both');
    return { targets, outcome: all('planned') ? 'planned' : all('prior') ? 'prior' : 'uncertain' };
  };
  try {
    await requireExpectedFiles();
    // Preflight every file before staging any DB mutation. Sources were captured before review.
    for (const file of options.files) {
      await fs.mkdir(dirname(file.path));
      const temporary = `${file.path}.${randomUUID()}.tmp`;
      const stagedFile: (typeof staged)[number] = {
        ...file,
        temporary: { path: temporary, bytes, pending: false },
        priorIdentity: options.targetIdentity ?? (await fs.identity?.(file.path)),
        replaced: false,
        retained: false,
      };
      staged.push(stagedFile);
      await stageTemporary(fs, stagedFile.temporary, bytes);
      stagedFile.stagedInode = stagedFile.temporary.inode;
      options.captureFile?.(stagedFile.path, stagedFile.stagedInode);
    }
    await requireExpectedFiles();
    const publish = async () => {
      await options.checkSourceBeforePublish?.();
      await requireExpectedFiles();
      for (const file of staged) {
        // A last-moment read detects ordinary external edits, but is not an OS compare-and-swap.
        await requireExpectedFiles();
        await publishTemporary(fs, file.temporary, file.path);
        file.replaced = true;
        if (
          (await temporaryState(fs, { path: file.path, inode: file.stagedInode, bytes })) !==
          'owned'
        )
          throw new Error('Published JSON identity or bytes changed during replacement');
      }
    };
    writerStarted = true;
    if (options.database)
      await options.database.apply(
        options.artifact,
        options.replace,
        () => {
          if (publicationClosed) throw new Error('Save publication already ended');
          publication ??= publish();
          return publication;
        },
        options.force,
        options.expectedPolicy,
        ...(options.databaseIdentity
          ? ([
              {
                ...options.databaseIdentity,
                registerFence: (fence: DatabaseFence) => {
                  databaseFence = fence;
                },
              },
            ] as const)
          : [])
      );
    else await publish();
    if (staged.some((file) => file.temporary.pending))
      throw new Error('The writer returned without publishing all staged JSON targets');
  } catch (failure) {
    const aborted = failure instanceof LicenseDatabaseAbortedError;
    const cause = aborted ? failure.cause : failure;
    databaseAborted = aborted || !writerStarted;
    publicationClosed = true;
    await publication?.catch(() => undefined);
    const failures: string[] = [];
    const rejectedRenames = new Set<(typeof staged)[number]>();
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
          await fs.write(copy.path, copy.bytes, () => {});
          retained.push(copy.path);
        } catch {
          recoveryFailures.push(copy.path);
        }
      }
    };
    // Reverse publication order; retain exact prior bytes, not a reserialized approximation.
    for (const file of [...staged].reverse()) {
      if (!file.replaced && file.temporary.renameAttempted) {
        rejectedRenames.add(file);
        // A transport or filesystem acknowledgement can be lost after the directory entry moved.
        file.replaced = await installedAfterRename(fs, file.temporary, file.path);
        if (
          !file.replaced &&
          !(await priorFileMatches(fs, file.path, file.previous, file.priorIdentity?.inode))
        ) {
          await preserveRecovery(file);
          failures.push(file.path);
        }
      }
      if (!file.replaced) continue;
      try {
        const stillPublished = async () =>
          (await temporaryState(fs, { path: file.path, inode: file.stagedInode, bytes })) ===
            'owned' &&
          (!expected || (await fs.read(file.path)) === bytes);
        if (!(await stillPublished())) {
          // Preserve the external edit and both known revisions for manual reconciliation.
          await preserveRecovery(file);
          failures.push(file.path);
          continue;
        }
        if (file.previous === null) await retirements.retire(file.path, file.stagedInode, bytes);
        else {
          await stageTemporary(fs, file.temporary, file.previous);
          if (!(await stillPublished())) {
            await preserveRecovery(file);
            failures.push(file.path);
            continue;
          }
          try {
            await publishTemporary(fs, file.temporary, file.path);
          } catch (error) {
            if (file.temporary.renameAttempted) {
              rejectedRenames.add(file);
              file.restoreInode = file.temporary.inode;
            }
            if (!(await installedAfterRename(fs, file.temporary, file.path))) {
              // While this name remains, a delayed restore can still change the target.
              if (file.temporary.renameAttempted) uncertainCleanup.add(file.temporary.path);
              throw error;
            }
          }
          if ((await temporaryState(fs, { ...file.temporary, path: file.path })) !== 'owned')
            throw new Error('Restored JSON identity or bytes changed during replacement');
          const restored = {
            path: file.path,
            canonical: file.path,
            inode: file.temporary.inode!,
            links: '1',
          };
          file.priorIdentity = restored;
          restoredFiles.push(restored);
        }
      } catch {
        await preserveRecovery(file);
        try {
          const entry = await fs.entry?.(file.temporary.path);
          if (
            entry &&
            (!entry.regular || entry.links !== '1' || entry.inode !== file.temporary.inode)
          )
            throw new Error('Temporary ownership unverified');
          const temporaryBytes = entry === null ? null : await fs.read(file.temporary.path);
          if (temporaryBytes !== null) {
            file.retained = true;
            const role = temporaryBytes === file.previous ? 'prior bytes' : 'contents uncertain';
            if (temporaryBytes !== file.previous) uncertainCleanup.add(file.temporary.path);
            retainedTemporary.push(`${file.temporary.path} (${role})`);
          }
        } catch {
          // Keep an unreadable temporary path: it may hold the only surviving prior bytes.
          file.retained = true;
          uncertainCleanup.add(file.temporary.path);
          retainedTemporary.push(`${file.temporary.path} (unverified; read failed)`);
        }
        failures.push(file.path);
      }
    }
    for (const file of staged) {
      if (file.retained || (await cleanupTemporary(fs, file.temporary))) continue;
      uncertainCleanup.add(file.temporary.path);
      retainedTemporary.push(`${file.temporary.path} (cleanup unverified)`);
    }
    await retirements.cleanup(retainedTemporary, uncertainCleanup);
    // Verify the final target after retiring the temporary name. A delayed rename
    // may have completed between the first prior-state observation and cleanup.
    for (const file of rejectedRenames) {
      if (
        failures.includes(file.path) ||
        (await priorFileMatches(fs, file.path, file.previous, file.priorIdentity?.inode))
      )
        continue;
      await preserveRecovery(file);
      failures.push(file.path);
    }
    if (uncertainCleanup.size && !failures.length)
      throw new LicenseWriteUncertainError(
        'Temporary file cleanup could not be verified. Inspect the retained paths and check the Save targets before retrying.',
        cause,
        {
          cleanupUnverified: true,
          diverged: false,
          affectedPaths: options.files.map((file) => file.path),
          recoveryFiles: retained,
          retainedTemporary,
          recoveryFailures,
        },
        reconcile,
        restoredFiles
      );
    const message = cause instanceof Error ? cause.message : String(cause);
    if (
      (cause instanceof LicenseInspectionStaleError ||
        cause instanceof LicenseFileDriftError ||
        cause instanceof LicensePolicyDriftError) &&
      !failures.length &&
      !staged.some((file) => file.replaced)
    )
      throw cause;
    if (
      (!options.database || !writerStarted || aborted) &&
      !failures.length &&
      options.expectedFiles
    )
      throw new LicenseWritePreflightError(cause, restoredFiles);
    if (failures.length)
      throw new LicenseWriteUncertainError(
        `Database/file operation failed: ${message}. DIVERGENCE: unable to restore ${failures.join(', ')}. Recovery files: ${retained.join(', ') || 'none written'}; retained temporary files: ${retainedTemporary.join(', ') || 'none confirmed'}${recoveryFailures.length ? `; recovery writes failed: ${recoveryFailures.join(', ')}` : ''}. Inspect actual files and license_classifications before retrying.`,
        cause,
        {
          diverged: true,
          affectedPaths: failures,
          recoveryFiles: retained,
          retainedTemporary,
          recoveryFailures,
        },
        reconcile,
        restoredFiles
      );
    throw new LicenseWriteUncertainError(
      `License write failed; prior JSON restored where applicable. Database commit outcome may be uncertain; inspect license_classifications before retrying: ${message}`,
      cause,
      {
        diverged: false,
        affectedPaths: options.files.map((file) => file.path),
        recoveryFiles: retained,
        retainedTemporary,
        recoveryFailures,
      },
      reconcile,
      restoredFiles
    );
  }
}
