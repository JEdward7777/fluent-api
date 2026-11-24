import type { LicenseAnalysis, LicenseInspection } from './license-workflow.types';

export function visibleWorkbenchInspection(
  inspected: Pick<LicenseInspection, 'inspectedAt' | 'preflight'> | undefined,
  sourceHash: string | undefined
) {
  if (!inspected) return null;
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
