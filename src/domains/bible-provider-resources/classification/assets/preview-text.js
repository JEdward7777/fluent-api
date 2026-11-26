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
    `Source: ${preview.sourceLabel}.`,
    next.sourceDraftPending
      ? 'This preview uses the loaded source. The newly selected source has not been loaded.'
      : '',
    ...(preview.destinationDatabaseLabel
      ? [`Destination: ${preview.destinationDatabaseLabel}.`]
      : []),
    ...preview.targets.map(
      (target) =>
        `${target.role}: ${target.path} (${target.existed ? 'will replace existing file' : 'new file'}).`
    ),
    preview.json
      ? `JSON ${preview.json.operation}: ${jsonDecisionCounts(preview.json)}`
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
      ? `Database ${preview.database.operation}: ${preview.database.inserted.length} inserts, ${preview.database.updated.length} updates (${preview.database.permissionChanges.length} permission, ${preview.database.metadataChanges.length} metadata only), ${preview.database.preserved.length} preserved, ${preview.database.unchanged.length} unchanged; no deletes or resource-cache writes.`
      : 'Database remains unchanged.',
    ...(preview.database?.identityExplanation ? [preview.database.identityExplanation] : []),
    ...(preview.conflicts ?? []).map((conflict) => `Save conflict: ${conflict}`),
    preview.policy
      ? `Policy diff: ${preview.policy.inserts.length} inserts, ${preview.policy.updates.length} updates, ${preview.policy.deletes.length} deletes.`
      : 'No immediate policy diff in this JSON-only Save.',
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

export function previewFingerprints(next) {
  const { preview, inspected } = next;
  return [
    ['Original practice source', next.originalHash],
    ['Inspected source file', inspected?.sourceHash],
    ['Working review content', preview.reviewContentHash],
    ...preview.targets.map((target) => [`Prior file ${target.path}`, target.previousHash]),
    ['Planned JSON content', preview.json?.reviewContentHash],
    ['Planned JSON file bytes', preview.json?.wholeFileHash],
    ['Forecast database decisions', preview.database?.reviewContentHash],
  ]
    .filter(([, hash]) => hash)
    .map(([label, hash]) => `${label}: ${hash}`)
    .join('\n');
}
