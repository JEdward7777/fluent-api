export function licenseWorkbenchPreviewLines(next) {
  const preview = next.preview;
  return [
    `Configuration ${preview.configurationRevision}; content revision ${preview.contentRevision}.`,
    `Working review SHA-256: ${preview.reviewContentHash}.`,
    `Source: ${preview.sourceLabel}.${next.inspected?.sourceHash ? ` Inspected source SHA-256: ${next.inspected.sourceHash}.` : ''}`,
    ...(preview.destinationDatabaseLabel
      ? [`Destination: ${preview.destinationDatabaseLabel}.`]
      : []),
    ...preview.targets.map(
      (target) =>
        `${target.role}: ${target.path} (${target.existed ? `will replace SHA-256 ${target.previousHash}` : 'new file'}).`
    ),
    preview.json
      ? `JSON ${preview.json.operation}: ${preview.json.inserted.length} inserts, ${preview.json.updated.length} updates (${preview.json.permissionChanges.length} permission, ${preview.json.metadataChanges.length} metadata only), ${preview.json.preserved.length} preserved, ${preview.json.unchanged.length} unchanged. File contains ${preview.json.artifactRows} rows. Whole JSON SHA-256: ${preview.json.wholeFileHash}.`
      : 'No JSON write selected.',
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
          `Insert keys: ${preview.policy.inserts.join(' | ') || '(none)'}.`,
          `Update keys: ${preview.policy.updates.join(' | ') || '(none)'}.`,
          `Delete keys: ${preview.policy.deletes.join(' | ') || '(none)'}.`,
        ]
      : []),
    preview.forecast
      ? `${preview.forecast.context.disclaimer} Later ordinary sync forecast: ${preview.forecast.changedStatuses} status changes, ${preview.forecast.gains ?? 'unavailable'} gains, ${preview.forecast.losses ?? 'unavailable'} losses; ${preview.forecast.missingClassifications} missing classifications.`
      : '',
    preview.forecast?.preservationWarning ?? '',
    preview.incomplete
      ? 'The optional whole-file assertion is absent or no longer bound to this content. Validated mixed-state decisions can still be saved.'
      : 'A separate whole-file assertion remains bound to this content.',
  ];
}
