export function node(tag, value, className) {
  const element = document.createElement(tag);
  if (value !== undefined) element.textContent = value;
  if (className) element.className = className;
  return element;
}

const notice = (value) =>
  value === null ? 'Original notice unavailable' : value === '' ? '(empty original notice)' : value;
const json = (value) => node('pre', JSON.stringify(value, null, 2));
function accordion(label, ...contents) {
  const section = node('details', undefined, 'evidence-block');
  section.append(node('summary', label), ...contents);
  return section;
}
function facts(entries) {
  const list = node('dl');
  for (const [label, value] of entries) {
    const pair = node('div');
    pair.append(
      node('dt', label),
      node('dd', value === '' ? '(empty string)' : (value ?? 'Not recorded'))
    );
    list.append(pair);
  }
  return list;
}

function decisionFacts(item) {
  return facts([
    ['Working decision', item.status],
    ['Source', item.source],
    [
      'Review state',
      item.pending ? 'Human reviewed · Unsaved' : (item.reviewState ?? 'unreviewed'),
    ],
    ['Decision event', item.pending ? 'Awaiting Save' : (item.decisionAt ?? 'Unknown legacy time')],
    ['Reviewer', item.reviewedBy],
    ['Human review event', item.humanReviewedAt],
    ['Review comment', item.reviewComment],
    ['Stable row ID', item.id],
    ['Content revision', item.contentRevision],
  ]);
}

function recordFacts(record) {
  return facts([
    ['Decision', record.status],
    ['Source', record.source],
    ['Original rationale', record.rationale],
    ['Legacy row note', record.rowNote],
    ['Review comment', record.reviewComment],
    ['Review state', record.reviewState],
    ['Decision event', record.decisionAt],
    ['Human reviewer', record.reviewedBy],
    ['Human review event', record.humanReviewedAt],
  ]);
}

function classification(item) {
  const sections = [];
  const recorded = item.recordedDecision;
  sections.push(accordion(`Recorded decision · ${recorded.status}`, recordFacts(recorded)));
  if (item.rule) sections.push(accordion(`Ordered rule · ${item.rule.id}`, json(item.rule)));
  if (item.automaticDecision)
    sections.push(
      accordion(
        `Preserved automatic proposal · ${item.automaticDecision.status}`,
        json(item.automaticDecision)
      )
    );
  if (item.evidenceContract)
    sections.push(accordion('Recorded model contract', json(item.evidenceContract)));
  for (const sample of item.samples)
    sections.push(
      accordion(
        `${sample.result.decision} · ${sample.provider}:${sample.model} · Sample ${sample.index}`,
        facts([
          ['Request hash', sample.requestHash],
          ['Cache hit', sample.cacheHit],
          ['Recorded attempts', sample.attempts],
          ['Parsed rationale', sample.result.rationale],
        ]),
        accordion('Exact saved request', json(sample.request)),
        accordion('Raw saved response', node('pre', sample.response)),
        accordion('Parsed result', json(sample.result))
      )
    );
  if (item.rowNoteProvenance)
    sections.push(accordion('Legacy note provenance', json(item.rowNoteProvenance)));
  for (const [index, entry] of item.reviewHistory.entries())
    sections.push(
      accordion(
        `Review history ${index + 1} · ${entry.status} · ${entry.reviewState}`,
        recordFacts(entry),
        ...(entry.rowNoteProvenance
          ? [accordion('Legacy note provenance', json(entry.rowNoteProvenance))]
          : [])
      )
    );
  return sections;
}

function render(content, kind, item) {
  content.replaceChildren();
  if (kind === 'Notice') {
    content.append(
      node('h4', 'Original notice'),
      node('pre', item.originalNoticeLabel),
      facts([['Normalized key', item.normalizedText]]),
      node('h4', `Saved original notice variants (${item.variants.length})`)
    );
    item.variantLabels.forEach((label, index) =>
      content.append(accordion(`Original notice variant ${index + 1}`, node('pre', label)))
    );
  } else if (kind === 'Affected Bibles') {
    content.append(node('p', item.context.label), node('p', item.context.disclaimer));
    for (const bible of item.bibles)
      content.append(
        accordion(
          [bible.name, bible.abbreviation, typeof bible.language === 'string' && bible.language]
            .filter(Boolean)
            .join(' · '),
          facts([
            ['Provider', bible.provider],
            ['External ID', bible.externalId],
            ['Bible ID', bible.bibleId],
            ['Affected notice', notice(bible.rawNotice)],
            ['Snapshot notice', notice(bible.snapshotNotice)],
            ...(bible.hasCurrentTarget
              ? [['Current target notice', notice(bible.currentNotice)]]
              : []),
          ])
        )
      );
  } else {
    const working = node('div', undefined, 'working-evidence');
    working.append(decisionFacts(item), node('p', item.overrideWarnings[item.status] ?? ''));
    content.append(working, node('p', item.modelEvidenceLabel));
    if (item.samples.length) {
      const votes = ['allowed', 'forbidden', 'unknown'].map((decision) => [
        decision,
        item.samples.filter((sample) => sample.result.decision === decision).length,
      ]);
      content.append(
        node(
          'p',
          `${votes.filter(([, n]) => n).length === 1 ? 'Unanimous' : 'Mixed'} saved votes · ${votes.map(([d, n]) => `${n} ${d}`).join(', ')}`
        )
      );
    }
    content.append(...classification(item));
  }
}

function evidenceCount(item) {
  return (
    1 +
    item.samples.length +
    item.reviewHistory.length +
    [item.rule, item.automaticDecision, item.evidenceContract, item.rowNoteProvenance].filter(
      Boolean
    ).length
  );
}
const drawerFields = {
  Notice: ['originalNoticeLabel', 'normalizedText', 'variantLabels'],
  'Affected Bibles': ['context', 'bibles'],
  'Classification evidence': [
    'recordedDecision',
    'samples',
    'rule',
    'automaticDecision',
    'evidenceContract',
    'rowNoteProvenance',
    'reviewHistory',
  ],
};

export function appendEvidence(detail, initial) {
  let item = initial;
  const dialog = node('dialog', undefined, 'evidence-drawer');
  const heading = node('h3');
  heading.id = 'evidence-drawer-title';
  dialog.setAttribute('aria-labelledby', heading.id);
  const close = node('button', 'Close');
  close.type = 'button';
  const header = node('header');
  header.append(heading, close);
  const content = node('div', undefined, 'drawer-content');
  content.tabIndex = 0;
  content.setAttribute('role', 'region');
  content.setAttribute('aria-labelledby', heading.id);
  dialog.append(header, content);
  let opener;
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    if (opener?.isConnected) opener.focus();
  });
  dialog.addEventListener('click', (event) => {
    const rect = dialog.getBoundingClientRect();
    if (
      event.target === dialog &&
      (event.clientX < rect.left ||
        event.clientX >= rect.right ||
        event.clientY < rect.top ||
        event.clientY >= rect.bottom)
    )
      dialog.close();
  });
  dialog.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const controls = [close, content, ...content.querySelectorAll('summary')].filter((el) =>
      el.checkVisibility()
    );
    const first = controls[0];
    const last = controls.at(-1);
    if (document.activeElement === (event.shiftKey ? first : last)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  });
  const buttons = new Map();
  const label = (kind) =>
    kind === 'Notice'
      ? kind
      : `${kind} (${kind === 'Affected Bibles' ? item.bibles.length : evidenceCount(item)})`;
  for (const kind of Object.keys(drawerFields)) {
    const button = node('button', label(kind), 'evidence-opener');
    buttons.set(kind, button);
    button.type = 'button';
    button.setAttribute('aria-haspopup', 'dialog');
    button.addEventListener('click', () => {
      opener = button;
      heading.textContent = button.textContent;
      render(content, kind, item);
      dialog.showModal();
      content.scrollTop = 0;
      close.focus();
    });
    detail.append(button);
  }
  detail.append(dialog);
  return (fresh) => {
    const previous = item;
    item = fresh;
    for (const [kind, button] of buttons) {
      button.textContent = label(kind);
      if (!dialog.open || button !== opener) continue;
      heading.textContent = button.textContent;
      if (
        drawerFields[kind].some(
          (key) => JSON.stringify(previous[key]) !== JSON.stringify(item[key])
        )
      ) {
        render(content, kind, item);
        close.focus();
      } else if (kind === 'Classification evidence') {
        content
          .querySelector('.working-evidence')
          .replaceChildren(
            decisionFacts(item),
            node('p', item.overrideWarnings[item.status] ?? '')
          );
      }
    }
  };
}
