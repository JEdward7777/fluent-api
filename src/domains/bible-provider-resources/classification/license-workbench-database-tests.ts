import type { WorkbenchDatabase } from './license-workbench-database';

import { testWorkbenchDatabase } from './license-workbench-database';

export class DatabaseTestUnavailableError extends Error {}

/** Test has its own connection. Reserve the session while another operation prepares review state. */
export class LicenseWorkbenchDatabaseTests {
  private pending?: Promise<void>;
  private reservations = 0;
  appliedStatus: 'untested' | 'passed' | 'failed' = 'untested';

  get running() {
    return this.pending !== undefined;
  }

  async reserve<T>(work: () => Promise<T>) {
    if (this.running) throw new Error('A database test is running');
    this.reservations++;
    try {
      return await work();
    } finally {
      this.reservations--;
    }
  }

  async run(connection: WorkbenchDatabase, draft: boolean) {
    if (this.running || this.reservations)
      throw new DatabaseTestUnavailableError('Cannot test while an operation runs');
    if (!draft) this.appliedStatus = 'untested';
    this.pending = testWorkbenchDatabase(connection, draft ? 'draft-test' : 'test');
    try {
      await this.pending;
      if (!draft) this.appliedStatus = 'passed';
    } catch (error) {
      if (!draft) this.appliedStatus = 'failed';
      throw error;
    } finally {
      this.pending = undefined;
    }
  }

  async settle() {
    await this.pending?.catch(() => undefined);
  }
}
