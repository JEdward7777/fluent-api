function keys(items) {
  return items.map((key) => key || '(empty notice)').join(' | ') || '(none)';
}

export function jsonDecisionCounts(json) {
  return `${json.inserted.length} inserts, ${json.updated.length} updates (${json.permissionChanges.length} permission, ${json.metadataChanges.length} metadata only), ${json.preserved.length} preserved, ${json.unchanged.length} unchanged. File contains ${json.artifactRows} rows (${json.artifactBytes} bytes).`;
}

export function licenseWorkbenchPreviewLines(next) {
  const preview = next.preview;
  return [
    `Configuration ${preview.configurationRevision}; content revision ${preview.contentRevision}.`,
    preview.reviewer ? `Pending decisions: ${preview.reviewer}, ${preview.reviewedAt}.` : '',
    `Working review SHA-256: ${preview.reviewContentHash}.`,
    `Source: ${preview.sourceLabel}.${next.inspected?.sourceHash ? ` Inspected source SHA-256: ${next.inspected.sourceHash}.` : ''}`,
    next.sourceDraftPending
      ? 'This preview uses the loaded source. The newly selected source has not been loaded.'
      : '',
    ...(preview.destinationDatabaseLabel
      ? [`Destination: ${preview.destinationDatabaseLabel}.`]
      : []),
    ...preview.targets.map(
      (target) =>
        `${target.role}: ${target.path} (${target.existed ? `will replace SHA-256 ${target.previousHash}` : 'new file'}).`
    ),
    preview.json
      ? `JSON ${preview.json.operation}: ${jsonDecisionCounts(preview.json)} JSON review SHA-256: ${preview.json.reviewContentHash}. Whole JSON SHA-256: ${preview.json.wholeFileHash}.`
      : 'No JSON write selected.',
    preview.json
      ? preview.json.assertion
        ? `JSON target whole-file assertion by ${preview.json.assertion.reviewedBy} at ${preview.json.assertion.reviewedAt}.`
        : 'JSON target whole-file assertion: absent.'
      : '',
    ...(preview.json?.deleted?.length
      ? [
          `JSON classification deletions (${preview.json.deleted.length}): ${keys(preview.json.deleted)}.`,
        ]
      : []),
    ...(preview.json?.deletedCatalog?.length
      ? [
          `JSON catalog deletions (${preview.json.deletedCatalog.length}): ${preview.json.deletedCatalog.map(({ provider, externalId }) => `${provider}/${externalId}`).join(' | ')}.`,
        ]
      : []),
    preview.database
      ? `Database ${preview.database.operation}: ${preview.database.inserted.length} inserts, ${preview.database.updated.length} updates (${preview.database.permissionChanges.length} permission, ${preview.database.metadataChanges.length} metadata only), ${preview.database.preserved.length} preserved, ${preview.database.unchanged.length} unchanged; no deletes or resource-cache writes. Forecast review SHA-256: ${preview.database.reviewContentHash}.`
      : 'Database remains unchanged.',
    ...(preview.database?.identityExplanation ? [preview.database.identityExplanation] : []),
    ...(preview.conflicts ?? []).map((conflict) => `Save conflict: ${conflict}`),
    preview.policy
      ? `Policy diff: ${preview.policy.inserts.length} inserts, ${preview.policy.updates.length} updates, ${preview.policy.deletes.length} deletes.`
      : 'No immediate policy diff in this JSON-only Save.',
    ...(preview.policy
      ? [
          `Insert keys: ${keys(preview.policy.inserts)}.`,
          `Update keys: ${keys(preview.policy.updates)}.`,
          `Delete keys: ${keys(preview.policy.deletes)}.`,
        ]
      : []),
    preview.forecast
      ? `${preview.forecast.context.disclaimer} Later ordinary sync forecast: status changes ${preview.forecast.changedStatuses ?? 'unavailable'}, gains ${preview.forecast.gains ?? 'unavailable'}, losses ${preview.forecast.losses ?? 'unavailable'}; ${preview.forecast.missingClassifications} missing classifications.`
      : '',
    preview.forecast?.preservationWarning ?? '',
    preview.incomplete
      ? 'The working whole-file assertion is absent or no longer bound to this content. Validated mixed-state decisions can still be saved.'
      : preview.assertion
        ? `Working whole-file assertion by ${preview.assertion.reviewedBy} on ${preview.assertion.reviewedAt}. Reason: ${preview.assertion.reviewReason}.`
        : 'A separate whole-file assertion remains bound to this content.',
  ];
}
