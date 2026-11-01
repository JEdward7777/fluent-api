export function licenseWorkbenchPreviewLines(next) {
  const preview = next.preview;
  return [
    `Configuration ${preview.configurationRevision}; content revision ${preview.contentRevision}.`,
    `Review SHA-256: ${preview.reviewContentHash}. Whole JSON SHA-256: ${preview.wholeFileHash}.`,
    `Source: ${next.source} ${next.input}. ${next.inspected?.sourceHash ? `Inspected source SHA-256: ${next.inspected.sourceHash}.` : 'Source identity is the frozen database snapshot.'} Destination: ${next.destination}. ${next.databaseTarget}.`,
    ...preview.targets.map(
      (target) =>
        `${target.role}: ${target.path} (${target.existed ? `will replace SHA-256 ${target.previousHash}` : 'new file'}).`
    ),
    preview.replace
      ? 'JSON import replaces the whole classification table. It changes no resource-cache rows now.'
      : next.destination === 'json'
        ? 'This Save writes JSON only; it does not import policy.'
        : 'Database maintenance writes changed classification rows only.',
    preview.requiresForceAgreement
      ? 'The target policy table is nonempty. Force must be selected in setup, and separate replacement agreement is required at Save.'
      : '',
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
      ? `JSON is incomplete. ${preview.review?.reasons.join(' ') ?? ''} ${preview.replace ? 'It cannot replace policy until attested.' : next.destination === 'json' ? 'It can be saved as JSON.' : 'Maintenance can write changed classification rows; this JSON remains incomplete.'}`
      : 'Review is attested. The exact hash above is bound to this preview.',
  ];
}
