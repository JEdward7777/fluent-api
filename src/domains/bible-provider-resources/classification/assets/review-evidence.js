export function node(tag, value, className) {
  const element = document.createElement(tag);
  if (value !== undefined) element.textContent = value;
  if (className) element.className = className;
  return element;
}
function field(label, value) {
  const wrapper = node('div');
  wrapper.append(
    node('dt', label),
    node('dd', value === '' ? '(empty string)' : String(value ?? 'None'))
  );
  return wrapper;
}
function block(heading, value) {
  const wrapper = node('section', undefined, 'evidence-block');
  wrapper.append(node('h4', heading), node('pre', value));
  return wrapper;
}
function expandable(heading, value) {
  const wrapper = node('details', undefined, 'evidence-block');
  wrapper.append(node('summary', heading), node('pre', value));
  return wrapper;
}
export function refreshEvidenceFacts(detail, item) {
  const facts = node('dl');
  facts.append(
    field('Stable row ID', item.id),
    field('Normalized key', item.normalizedText),
    field('Decision', item.status),
    field('Review state', item.reviewState ?? 'unreviewed'),
    field('Decision event', item.decisionAt ?? 'Unknown legacy time'),
    field('Human reviewer', item.reviewedBy ?? 'None'),
    field('Human review event', item.humanReviewedAt ?? 'None'),
    field('Source', item.source),
    field('Rationale', item.rationale),
    field('Content revision', item.contentRevision),
    field('Human note', item.rowNote ?? 'None')
  );
  if (detail.firstElementChild?.tagName === 'DL') detail.firstElementChild.replaceWith(facts);
  else detail.prepend(facts);
}
export function appendEvidence(detail, item) {
  refreshEvidenceFacts(detail, item);
  const variants = node('div');
  if (item.missingNoticeLabel) variants.append(node('p', item.missingNoticeLabel));
  for (const [index, label] of item.variantLabels.entries())
    variants.append(block(`Original notice variant ${index + 1}`, label));
  detail.append(node('h4', `Saved original notice variants (${item.variants.length})`), variants);
  const bibles = node('ul');
  for (const bible of item.bibles) {
    const entry = node('li');
    entry.append(
      node('strong', `${bible.name} (${bible.abbreviation})`),
      node(
        'span',
        ` — ${bible.provider}:${bible.externalId}; Bible ID ${bible.bibleId ?? 'not assigned'}`
      )
    );
    if (bible.currentNotice !== null && bible.currentNotice !== bible.snapshotNotice)
      entry.append(block('Current target notice', bible.currentNotice));
    bibles.append(entry);
  }
  detail.append(
    node(
      'h4',
      `Affected Bibles in ${item.context.label ?? 'saved artifact'} (${item.bibles.length})`
    ),
    bibles
  );
  if (item.automaticDecision)
    detail.append(
      block('Preserved automatic proposal', JSON.stringify(item.automaticDecision, null, 2))
    );
  if (item.rule)
    detail.append(
      block(
        'Ordered rule match: ID, priority, decision, rationale and matched excerpt',
        JSON.stringify(item.rule, null, 2)
      )
    );
  detail.append(node('h4', 'Model evidence'), node('p', item.modelEvidenceLabel));
  for (const sample of item.samples) {
    const sampleSection = node('section', undefined, 'evidence-block');
    sampleSection.append(
      node('h5', `Historical sample ${sample.index}: ${sample.provider}:${sample.model}`),
      field('Request hash', sample.requestHash),
      field('Cache hit', sample.cacheHit === undefined ? 'Unreported' : String(sample.cacheHit)),
      field('Recorded attempts', sample.attempts ?? 'Unreported'),
      expandable('Exact saved request', JSON.stringify(sample.request, null, 2)),
      expandable('Raw saved response', sample.response),
      block('Parsed decision and rationale', JSON.stringify(sample.result, null, 2))
    );
    detail.append(sampleSection);
  }
}
