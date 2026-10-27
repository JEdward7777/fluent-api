import type { LicenseReportModel } from './license-report-model';

import { escapeReportHtml as html } from './license-report-formats';

export function renderLicenseHtml(model: LicenseReportModel): string {
  const { impact } = model;
  const list = (items: string[]) =>
    items.length ? `<ul>${items.map((item) => `<li>${item}</li>`).join('')}</ul>` : '<p>None.</p>';
  const bible = (row: {
    name: string;
    provider: string;
    externalId: string;
    bibleId?: number | null;
  }) =>
    `${html(row.name)} [${html(row.provider)}:${html(row.externalId)}${row.bibleId !== undefined ? `; Bible ID ${row.bibleId ?? 'not assigned'}` : ''}]`;
  const inventory = model.inventory
    .map((entry) => {
      const search = [
        entry.normalizedText,
        entry.exampleNotice,
        entry.rationale,
        entry.rowNote ?? '',
        ...entry.bibles.map(
          (row) => `${row.name} ${row.provider}:${row.externalId} ${row.bibleId ?? ''}`
        ),
      ].join(' ');
      return `<article class="license-entry" data-status="${entry.status}" data-search="${html(search)}">
<h3>${html(entry.normalizedText || '(empty normalized notice)')}</h3><p>Status: <strong>${entry.status}</strong>; source: ${entry.source}.</p>
<p>Rationale: ${html(entry.rationale)}</p><p>Example notice:</p><pre>${html(entry.exampleNotice)}</pre>
${entry.rowNote ? `<p>Human row note: ${html(entry.rowNote)}</p>` : ''}
${entry.automaticDecision ? `<p>Preserved automatic proposal: ${entry.automaticDecision.status} (${entry.automaticDecision.source}) — ${html(entry.automaticDecision.rationale)}</p>` : ''}
${entry.rule ? `<p>Rule: ${html(entry.rule.id)}; priority ${entry.rule.priority}; matched excerpt: ${html(entry.rule.matchedExcerpt)}.</p>` : ''}
<details><summary>Affected Bibles (${entry.bibles.length})</summary>${list(entry.bibles.map(bible))}</details>
${entry.samples.map((sample) => `<details><summary>Model evidence: ${html(sample.provider)}:${html(sample.model)}, sample ${sample.index}, ${sample.decision}</summary><p>${html(sample.rationale)}</p><p>Request hash: ${sample.requestHash}</p><p>Raw response:</p><pre>${html(sample.response)}</pre><p>Semantic request:</p><pre>${html(JSON.stringify(sample.request, null, 2))}</pre></details>`).join('')}
</article>`;
    })
    .join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>License classification review</title>
<style>body{font:16px system-ui;max-width:1000px;margin:2rem auto;padding:0 1rem;line-height:1.5}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f1f3f5;padding:1rem}.notice{border:2px solid #685300;padding:1rem}.license-entry{border-top:1px solid #aaa;padding:1rem 0}details{margin:.8rem 0}input,select{font:inherit;padding:.5rem}[hidden]{display:none}</style></head><body>
<h1>License classification review</h1><p class="notice"><strong>${html(impact.context.disclaimer)}</strong></p>
<p>Resource effects are projections after the next ordinary table-derived sync. This report and review do not update resource caches.</p>
<p>Review content hash: <code>${model.reviewContentHash}</code><br>Whole-file SHA-256: <code>${model.wholeFileHash}</code><br>Revision: ${model.reviewState}</p>
<h2>Summary</h2><p>Classification decisions: ${model.inventory.length}. Allowed: ${impact.classificationTotals.allowed}; forbidden: ${impact.classificationTotals.forbidden}; unknown: ${impact.classificationTotals.unknown}.</p>
<p>Projected catalog resources: allowed ${impact.totals.allowed}; forbidden ${impact.totals.forbidden}; unknown ${impact.totals.unknown}.</p><p>Unchanged status/notice records: ${impact.unchanged ?? 'unavailable'}; TTS eligibility gains: ${impact.ttsGains ?? 'unavailable'}; losses: ${impact.ttsLosses ?? 'unavailable'}.</p>
<p>Recorded evidence diagnostics: ${impact.diagnostics.cacheHits} cache hits; ${impact.diagnostics.freshSamples} fresh samples; ${impact.diagnostics.newCalls} recorded provider calls; ${impact.diagnostics.unreportedSamples} samples without complete runtime diagnostics.</p>
<p>Models: ${model.models.map((entry) => `${html(entry.provider)}:${html(entry.model)} (${entry.sampleCount} samples)`).join(', ')}.</p>
${model.attestation ? `<p>Attested by ${html(model.attestation.reviewedBy)} at ${html(model.attestation.reviewedAt)}: ${html(model.attestation.reviewReason)}</p>` : ''}
${impact.preservationWarning ? `<p class="notice"><strong>${html(impact.preservationWarning)}</strong></p>` : ''}
<h2>Proposed resource status changes</h2>${impact.context.kind === 'artifact-only' ? '<p>Unavailable without database context.</p>' : list(impact.changes.map((row) => `${bible(row)}: ${row.currentStatus ?? 'new catalog record'} → ${row.status}.`))}
<h2>New catalog records</h2>${impact.context.kind === 'artifact-only' ? '<p>New membership cannot be determined without database context.</p>' : list(impact.newCatalogRows.map((row) => `${bible(row)}: proposed ${row.status}.`))}
<h2>Notice changes</h2>${impact.noticeChanges.map((row) => `<h3>${bible(row)}</h3><p>Previous notice:</p><pre>${html(row.currentNotice ?? '(none)')}</pre><p>Proposed notice:</p><pre>${html(row.rawNotice ?? '(none)')}</pre>`).join('') || '<p>None identified in the supplied comparison.</p>'}
<h2>Conflicts and review items</h2>${list([
    ...impact.disagreements.map(
      (row) =>
        `Preservation disagreement: ${bible(row)} retains ${row.status}; exact table derivation is ${row.derivedStatus}.`
    ),
    ...impact.unknownClassifications.map(
      (row) =>
        `Unknown: ${html(row.normalizedText)} — ${html(row.rowNote ?? 'Human row note required to complete JSON review.')}`
    ),
    ...impact.missingClassifications.map(
      (row) =>
        `Missing exact classification: ${bible(row)}; normalized notice ${html(row.normalizedText ?? '')}. Projected derived status: unknown.`
    ),
  ])}
<h2>Normalization collisions</h2>${impact.collisions.map((collision) => `<h3>${html(collision.normalizedText)}</h3>${collision.notices.map((notice) => `<pre>${html(notice)}</pre>`).join('')}`).join('') || '<p>None.</p>'}
<h2>Complete license inventory</h2><label>Search notices, reasons or Bible identities <input id="license-search" type="search"></label> <label>Status <select id="license-status"><option value="all">All</option><option value="allowed">Allowed</option><option value="forbidden">Forbidden</option><option value="unknown">Unknown</option></select></label><p id="visible-count"></p>
${inventory}
<script>const search=document.getElementById('license-search');const status=document.getElementById('license-status');function filter(){let count=0;const q=search.value.toLowerCase();for(const entry of document.querySelectorAll('.license-entry')){entry.hidden=!(entry.dataset.search.toLowerCase().includes(q)&&(status.value==='all'||entry.dataset.status===status.value));if(!entry.hidden)count++;}document.getElementById('visible-count').textContent=count+' classification entries shown';}search.addEventListener('input',filter);status.addEventListener('change',filter);filter();</script>
</body></html>\n`;
}
