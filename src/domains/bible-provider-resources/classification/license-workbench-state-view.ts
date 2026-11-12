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
      cost: inspected.preflight.cost,
    },
  };
}

export function visibleWorkbenchAnalysis(analysis: LicenseAnalysis | undefined) {
  return analysis
    ? { rows: analysis.artifact.classifications.length, contentRevision: analysis.contentRevision }
    : null;
}
