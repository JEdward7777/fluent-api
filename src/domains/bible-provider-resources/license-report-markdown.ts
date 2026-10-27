import type { LicenseReportModel } from './license-report-model';

import { escapeReportHtml as html, escapeReportMarkdown as text } from './license-report-formats';

export function renderLicenseMarkdown(model: LicenseReportModel): string {
  const { impact } = model;
  const rows: string[] = [
    '# License classification review',
    '',
    `**${text(impact.context.disclaimer)}**`,
    '',
    'Resource effects below are projections after the next ordinary table-derived sync. This report and review do not update resource caches.',
    '',
    `Review content hash: ${model.reviewContentHash}`,
    `Whole-file SHA-256: ${model.wholeFileHash}`,
    `Revision: ${model.reviewState}`,
    '',
    '## Summary',
    '',
    `Classification decisions: ${model.inventory.length}. Allowed: ${impact.classificationTotals.allowed}; forbidden: ${impact.classificationTotals.forbidden}; unknown: ${impact.classificationTotals.unknown}.`,
    `Projected catalog resources: allowed ${impact.totals.allowed}; forbidden ${impact.totals.forbidden}; unknown ${impact.totals.unknown}.`,
    `Unchanged status/notice records: ${impact.unchanged ?? 'unavailable'}; TTS eligibility gains: ${impact.ttsGains ?? 'unavailable'}; losses: ${impact.ttsLosses ?? 'unavailable'}.`,
    `Recorded evidence diagnostics: ${impact.diagnostics.cacheHits} cache hits; ${impact.diagnostics.freshSamples} fresh samples; ${impact.diagnostics.newCalls} recorded provider calls; ${impact.diagnostics.unreportedSamples} samples without complete runtime diagnostics.`,
    `Models: ${model.models.map((entry) => `${text(entry.provider)}:${text(entry.model)} (${entry.sampleCount} samples)`).join(', ')}.`,
    '',
  ];
  if (model.attestation)
    rows.push(
      `Attested by ${text(model.attestation.reviewedBy)} at ${text(model.attestation.reviewedAt)}: ${text(model.attestation.reviewReason)}`,
      ''
    );
  if (impact.preservationWarning) rows.push(`**${text(impact.preservationWarning)}**`, '');
  if (impact.classificationChanges) {
    const changes = impact.classificationChanges;
    rows.push(
      '## WARNING: whole-table classification replacement',
      '',
      `Deletes ${changes.deletedKeys.length}; inserts ${changes.insertedKeys.length}; changes ${changes.changedKeys.length} (status, rationale, producer or recorded evidence).`,
      ...changes.deletedKeys.map((key) => `- Delete: ${text(key)}`),
      ...changes.insertedKeys.map((key) => `- Insert: ${text(key)}`),
      ...changes.changedKeys.map((key) => `- Change: ${text(key)}`),
      ''
    );
  }
  rows.push('## Proposed resource status changes', '');
  for (const change of impact.changes)
    rows.push(
      `- ${text(change.name)} [${text(change.provider)}:${text(change.externalId)}; Bible ID ${change.bibleId ?? 'not assigned'}]: ${change.currentStatus ?? 'new catalog record'} → ${change.status}.`
    );
  if (!impact.changes.length)
    rows.push(
      impact.context.kind === 'database'
        ? 'No projected resource status changes.'
        : 'Unavailable without database context.'
    );
  rows.push('', '## New catalog records', '');
  for (const bible of impact.newCatalogRows)
    rows.push(
      `- ${text(bible.name)} [${text(bible.provider)}:${text(bible.externalId)}]: proposed ${bible.status}.`
    );
  if (!impact.newCatalogRows.length)
    rows.push(
      impact.context.kind === 'database'
        ? 'None.'
        : 'New membership cannot be determined without database context.'
    );
  const targetOnly = impact.context.kind === 'database' && impact.context.classificationOnly;
  rows.push('', targetOnly ? '## Snapshot notice drift' : '## Notice changes', '');
  for (const bible of impact.noticeChanges)
    rows.push(
      `### ${text(bible.name)} [${text(bible.provider)}:${text(bible.externalId)}]`,
      '',
      'Previous notice:',
      `<pre>${html(bible.currentNotice ?? '(none)')}</pre>`,
      targetOnly ? 'Reviewed artifact snapshot notice (not written):' : 'Proposed notice:',
      `<pre>${html((targetOnly ? bible.snapshotNotice : bible.rawNotice) ?? '(none)')}</pre>`,
      ''
    );
  if (!impact.noticeChanges.length) rows.push('None identified in the supplied comparison.');
  rows.push('', '## Conflicts and review items', '');
  for (const bible of impact.disagreements)
    rows.push(
      `- Preservation disagreement: ${text(bible.name)} [${text(bible.provider)}:${text(bible.externalId)}] retains ${bible.status}, while exact table derivation is ${bible.derivedStatus}.`
    );
  for (const row of impact.unknownClassifications)
    rows.push(
      `- Unknown: ${text(row.normalizedText)} — ${text(row.rowNote ?? 'Human row note required to complete JSON review.')}`
    );
  for (const bible of impact.missingClassifications)
    rows.push(
      `- Missing exact classification: ${text(bible.name)} [${text(bible.provider)}:${text(bible.externalId)}], normalized notice ${text(bible.normalizedText ?? '')}. Projected derived status: unknown.`
    );
  if (
    !impact.disagreements.length &&
    !impact.unknownClassifications.length &&
    !impact.missingClassifications.length
  )
    rows.push('None.');
  rows.push('', '## Normalization collisions', '');
  for (const collision of impact.collisions)
    rows.push(
      `Normalized key: ${text(collision.normalizedText)}`,
      ...collision.notices.map((notice) => `<pre>${html(notice)}</pre>`),
      ''
    );
  if (!impact.collisions.length) rows.push('None.');
  rows.push('', '## Complete license inventory', '');
  for (const entry of model.inventory) {
    rows.push(
      `### ${text(entry.normalizedText || '(empty normalized notice)')}`,
      '',
      `Status: **${entry.status}**; source: ${entry.source}.`,
      `Rationale: ${text(entry.rationale)}`,
      'Example notice:',
      `<pre>${html(entry.exampleNotice)}</pre>`,
      ''
    );
    if (entry.rowNote) rows.push(`Human row note: ${text(entry.rowNote)}`, '');
    if (entry.automaticDecision)
      rows.push(
        `Preserved automatic proposal: ${entry.automaticDecision.status} (${entry.automaticDecision.source}) — ${text(entry.automaticDecision.rationale)}`,
        ''
      );
    if (entry.rule)
      rows.push(
        `Rule: ${text(entry.rule.id)}; priority ${entry.rule.priority}; matched excerpt: ${text(entry.rule.matchedExcerpt)}.`,
        ''
      );
    rows.push(`<details><summary>Affected Bibles (${entry.bibles.length})</summary>`, '');
    for (const bible of entry.bibles)
      rows.push(
        `- ${text(bible.name)} (${text(bible.abbreviation)}); ${text(bible.provider)}:${text(bible.externalId)}; Bible ID ${bible.bibleId ?? 'not assigned'}.`
      );
    rows.push('', '</details>', '');
    for (const sample of entry.samples)
      rows.push(
        `<details><summary>Model evidence: ${html(sample.provider)}:${html(sample.model)}, sample ${sample.index}, ${sample.decision}</summary>`,
        '',
        `Rationale: ${text(sample.rationale)}`,
        `Request hash: ${sample.requestHash}`,
        'Raw response:',
        `<pre>${html(sample.response)}</pre>`,
        'Semantic request:',
        `<pre>${html(JSON.stringify(sample.request, null, 2))}</pre>`,
        '',
        '</details>',
        ''
      );
  }
  return `${rows.join('\n')}\n`;
}
