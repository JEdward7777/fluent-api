import { freezeReviewValue } from '../license-review-revision';

interface LicenseOperationSnapshot {
  operationId: string;
  kind: 'inspect' | 'analysis' | 'save' | 'export-report';
  state: 'running' | 'succeeded' | 'failed';
  result?: unknown;
  error?: string;
}

interface LicenseOperationRecord<T> {
  fingerprint: string;
  promise: Promise<T>;
  snapshot: LicenseOperationSnapshot;
}

/** Invocation-scoped retry records; never infer or read again for a matching ID. */
export class LicenseOperationRegistry {
  private readonly records = new Map<string, LicenseOperationRecord<unknown>>();

  get(operationId: string) {
    return this.records.get(operationId)?.snapshot;
  }

  run<T>(
    operationId: string,
    kind: LicenseOperationSnapshot['kind'],
    fields: readonly unknown[],
    start: () => Promise<T>
  ): Promise<T> {
    if (!operationId.trim()) throw new Error(`${kind} operation ID is required`);
    const fingerprint = JSON.stringify([kind, ...fields]);
    const prior = this.records.get(operationId);
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new Error('License operation ID was reused with different arguments');
      return prior.promise as Promise<T>;
    }
    const snapshot: LicenseOperationSnapshot = freezeReviewValue({
      operationId,
      kind,
      state: 'running',
    });
    let promise: Promise<T>;
    try {
      promise = start();
    } catch (error) {
      promise = Promise.reject(error);
    }
    const record: LicenseOperationRecord<T> = { fingerprint, promise, snapshot };
    this.records.set(operationId, record);
    void promise.then(
      (result) => {
        record.snapshot = freezeReviewValue({ operationId, kind, state: 'succeeded', result });
      },
      (error: unknown) => {
        record.snapshot = freezeReviewValue({
          operationId,
          kind,
          state: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    );
    return promise;
  }

  track<T>(
    operationId: string,
    kind: LicenseOperationSnapshot['kind'],
    fields: readonly unknown[],
    promise: Promise<T>
  ) {
    return this.run(operationId, kind, fields, () => promise);
  }
}
