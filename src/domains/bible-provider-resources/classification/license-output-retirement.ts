import { randomUUID } from 'node:crypto';

import type { LicenseFileIo } from './license-write';
import type { LicenseTemporary } from './license-write-temporary';

import {
  cleanupTemporary,
  installedAfterRename,
  priorFileMatches,
  publishTemporary,
  temporaryState,
} from './license-write-temporary';

interface Retirement {
  output: LicenseTemporary;
  retired: LicenseTemporary;
  confirmed: boolean;
}

/** Remove a newly published output by moving it to a one-use name. A delayed
 * unlink can then affect only this operation's retired inode, never a later Save. */
export class LicenseOutputRetirements {
  private readonly entries: Retirement[] = [];

  constructor(private readonly fs: LicenseFileIo) {}

  async retire(path: string, inode: string | undefined, bytes: string) {
    const output = { path, inode, bytes, pending: true };
    const retired = { path: `${path}.${randomUUID()}.retired.tmp`, inode, bytes, pending: true };
    if (!this.fs.entry || (await this.fs.entry(retired.path)) !== null)
      throw new Error('Could not reserve an absent retirement name');
    const entry: Retirement = { output, retired, confirmed: false };
    this.entries.push(entry);
    try {
      await publishTemporary(this.fs, output, retired.path);
    } catch (error) {
      entry.confirmed = await installedAfterRename(this.fs, output, retired.path);
      if (!entry.confirmed) throw error;
    }
    entry.confirmed ||= (await temporaryState(this.fs, retired)) === 'owned';
    if (!entry.confirmed || !(await priorFileMatches(this.fs, path, null, null)))
      throw new Error('Could not verify removal of the published JSON');
  }

  async cleanup(retained: string[], uncertain: Set<string>) {
    for (const { output, retired, confirmed } of this.entries) {
      if (!output.renameAttempted) continue;
      if (confirmed && (await cleanupTemporary(this.fs, retired))) continue;
      uncertain.add(retired.path);
      retained.push(
        `${retired.path} (${confirmed ? 'cleanup unverified' : 'retirement unconfirmed; check targets before removing'})`
      );
    }
  }

  /** Observe the transfer before any absence check or final target read. A missing
   * retirement name alone cannot distinguish a queued rename from a completed one. */
  async pendingOutputs() {
    const pending = new Set<string>();
    for (const entry of this.entries) {
      if (entry.confirmed || !entry.output.renameAttempted) continue;
      entry.confirmed = (await temporaryState(this.fs, entry.retired)) === 'owned';
      if (!entry.confirmed) pending.add(entry.output.path);
    }
    return pending;
  }
}
