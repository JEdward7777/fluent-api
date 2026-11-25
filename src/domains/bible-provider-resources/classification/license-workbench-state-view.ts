import { createHash } from 'node:crypto';

import type { LicenseAnalysis, LicenseInspection } from './license-workflow.types';

const hashes = new WeakMap<LicenseInspection, string>();
export function visibleWorkbenchInspection(inspected: LicenseInspection | undefined) {
  if (!inspected) return null;
  let sourceHash = hashes.get(inspected);
  if (!sourceHash && inspected.inputBytes !== null) {
    sourceHash = createHash('sha256').update(inspected.inputBytes).digest('hex');
    hashes.set(inspected, sourceHash);
  }
  return {
    inspectedAt: inspected.inspectedAt,
    sourceHash: sourceHash ?? null,
    preflight: {
      source: inspected.preflight.source,
      distinctKeys: inspected.preflight.distinctKeys,
      tableHits: inspected.preflight.tableHits,
      ruleHits: inspected.preflight.ruleHits,
      modelKeys: inspected.preflight.modelKeys,
      validCacheHits: inspected.preflight.validCacheHits,
      expectedUncachedRequests: inspected.preflight.expectedUncachedRequests,
      maximumAttempts: inspected.preflight.maximumAttempts,
      savedEvidenceReuse: inspected.preflight.rows.filter(
        (row) => row.action === 'retain' && row.savedEvidenceReuse
      ).length,
      rows: inspected.preflight.rows.filter((row) => row.action !== 'retain'),
      samples: inspected.preflight.samples,
      cost: inspected.preflight.cost,
    },
  };
}

export function visibleWorkbenchAnalysis(
  analysis: LicenseAnalysis | undefined,
  pendingReviews: number
) {
  return analysis
    ? {
        pendingReviews,
        rows: analysis.artifact.classifications.length,
        contentRevision: analysis.contentRevision,
      }
    : null;
}
