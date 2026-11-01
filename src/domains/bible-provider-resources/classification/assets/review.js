const section = document.getElementById('review');
const form = document.getElementById('review-filter');
const rows = document.getElementById('review-rows');
const summary = document.getElementById('review-summary');
const detail = document.getElementById('review-detail');
const pager = document.getElementById('review-pager');
let request;
let submitEdit;
let onDraftChange = () => {};
let currentSetup;
let selectedId = null;
let loadedRevision = null;
let page = 1;
let listRequest = 0;
let detailRequest = 0;
let viewEpoch = 0;
let editBusy = false;
let externalBusy = false;
let editDirty = false;
let editMessage = '';
let updateEditorControls = () => {};

function setDraftDirty(value) {
  if (editDirty === value) return;
  editDirty = value;
  onDraftChange(value);
}

export function hasUnsavedReviewDraft() {
  return editDirty;
}

function node(tag, value, className) {
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
function queryPath() {
  const params = new URLSearchParams({
    search: form.elements.search.value,
    status: form.elements.status.value,
    source: form.elements.source.value,
    page: String(page),
  });
  return `review?${params}`;
}
async function loadRows() {
  const sequence = ++listRequest;
  const epoch = viewEpoch;
  try {
    const result = await request(queryPath());
    if (sequence !== listRequest || epoch !== viewEpoch) return;
    page = result.page;
    rows.replaceChildren();
    for (const item of result.rows) {
      const tr = node('tr');
      const action = node('button', item.preview || '(empty original notice)');
      action.type = 'button';
      action.dataset.rowId = item.id;
      action.addEventListener('click', () => void openDetail(item.id));
      const preview = node('td');
      preview.append(action, node('small', `Row ID: ${item.id}`));
      preview.dataset.label = 'Original notice preview';
      tr.append(
        preview,
        node(
          'td',
          item.bibleNames.slice(0, 3).join(', ') +
            (item.bibleCount > 3 ? ` +${item.bibleCount - 3}` : '')
        ),
        node('td', item.source),
        node('td', item.status),
        node(
          'td',
          item.sampleCount
            ? `${item.votes.allowed} allowed / ${item.votes.forbidden} forbidden / ${item.votes.unknown} unknown`
            : 'No model votes'
        )
      );
      for (const [cell, label] of [...tr.children]
        .slice(1)
        .map((cell, index) => [
          cell,
          ['Affected Bibles', 'Source', 'Decision', 'Saved model votes'][index],
        ]))
        cell.dataset.label = label;
      rows.append(tr);
    }
    summary.textContent = `${result.total} of ${result.allCount} classifications match. Page ${page} of ${result.pageCount}; up to ${result.pageSize} per page. Search and filters replace these results. ${result.context.disclaimer}`;
    pager.querySelector('[name="previous"]').disabled = page <= 1;
    pager.querySelector('[name="next"]').disabled = page >= result.pageCount;
    if (!result.rows.length) {
      const empty = node('tr');
      empty.append(node('td', 'No matching classifications. Change search or filters.'));
      rows.append(empty);
    }
  } catch (error) {
    if (sequence === listRequest && epoch === viewEpoch) summary.textContent = error.message;
  }
}
function reviewEditor(item) {
  const editor = node('form', undefined, 'review-editor');
  const heading = node('h4', 'Human review');
  const help = node(
    'p',
    'Choose a decision and give your rationale. An unknown note can also be updated separately. Saving an edit invalidates any prior preview and attestation.'
  );
  const decision = node('select');
  decision.name = 'status';
  for (const status of ['allowed', 'forbidden', 'unknown'])
    decision.append(new Option(status[0].toUpperCase() + status.slice(1), status));
  decision.value = item.status;
  const reason = node('textarea');
  reason.name = 'reason';
  reason.rows = 3;
  reason.value = item.source === 'manual' ? item.rationale : '';
  const initialReason = reason.value;
  const note = node('textarea');
  note.name = 'note';
  note.rows = 3;
  note.value = item.rowNote ?? '';
  const initialNote = note.value;
  const decisionLabel = node('label', 'Decision');
  decisionLabel.append(decision);
  const reasonLabel = node('label', 'Reason for decision');
  reasonLabel.append(reason);
  const noteLabel = node(
    'label',
    'Human note for retained unknown (leave blank to use the reason)'
  );
  noteLabel.append(note);
  const warning = node('p', '', 'notice');
  const agreement = node('label');
  const agree = node('input');
  agree.type = 'checkbox';
  agreement.append(
    agree,
    node('span', 'I understand this overrides the automatic all-rights-reserved decision.')
  );
  const error = node('p', editMessage);
  error.setAttribute('role', 'status');
  const apply = node('button', 'Apply reasoned decision');
  apply.type = 'submit';
  apply.value = 'disposition';
  apply.name = 'editKind';
  const saveNote = node('button', 'Update unknown note');
  saveNote.type = 'submit';
  saveNote.value = 'unknown-note';
  saveNote.name = 'editKind';
  const actions = node('div', undefined, 'actions');
  actions.append(apply, saveNote);
  editor.append(
    heading,
    help,
    decisionLabel,
    reasonLabel,
    warning,
    agreement,
    noteLabel,
    actions,
    error
  );
  const update = () => {
    const message = item.overrideWarnings[decision.value];
    warning.hidden = !message;
    warning.textContent = message ?? '';
    agreement.hidden = !message;
    noteLabel.hidden = decision.value !== 'unknown' && note.value === initialNote;
    saveNote.hidden = item.status !== 'unknown' || decision.value !== 'unknown';
    const locked =
      editBusy ||
      externalBusy ||
      Boolean(currentSetup.activeOperationId) ||
      !['reviewing', 'previewed'].includes(currentSetup.state);
    for (const control of editor.elements) control.disabled = locked;
  };
  updateEditorControls = update;
  decision.addEventListener('change', update);
  editor.addEventListener('input', () => setDraftDirty(true));
  editor.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (editBusy) return;
    const kind = event.submitter?.value ?? 'disposition';
    const message = item.overrideWarnings[decision.value];
    if (
      kind === 'unknown-note' &&
      (decision.value !== item.status || reason.value !== initialReason)
    ) {
      error.textContent =
        'The decision or reason has an unapplied draft. Apply it first, or restore those fields before updating only the unknown note.';
      error.tabIndex = -1;
      error.focus();
      return;
    }
    if (kind === 'disposition' && decision.value !== 'unknown' && note.value !== initialNote) {
      error.textContent =
        'A non-unknown decision cannot retain the changed human note. Restore the note or discard this draft before applying the decision.';
      noteLabel.hidden = false;
      error.tabIndex = -1;
      error.focus();
      return;
    }
    if (kind === 'disposition' && message && !agree.checked) {
      error.textContent =
        'Acknowledge the automatic-decision warning before applying this override.';
      agree.focus();
      return;
    }
    const edit =
      kind === 'unknown-note'
        ? { kind, normalizedText: item.normalizedText, note: note.value }
        : {
            kind: 'disposition',
            normalizedText: item.normalizedText,
            status: decision.value,
            reason: reason.value,
            ...(decision.value === 'unknown' && note.value.trim()
              ? { unknownNote: note.value }
              : {}),
          };
    editBusy = true;
    update();
    try {
      const result = await submitEdit({
        configurationRevision: item.configurationRevision,
        contentRevision: item.contentRevision,
        id: item.id,
        edit,
        acknowledgeWarning: agree.checked,
      });
      setDraftDirty(false);
      editMessage = result.warning
        ? `Review edit applied. ${result.warning} Preview and attestation require renewal.`
        : 'Review edit applied. Preview and attestation require renewal.';
      if (result.setup.contentRevision === item.contentRevision) {
        error.textContent = 'No content changed; the existing preview remains current.';
        editMessage = '';
      }
    } catch (failure) {
      error.textContent = failure.message;
      error.tabIndex = -1;
      error.focus();
    } finally {
      editBusy = false;
      update();
    }
  });
  update();
  return editor;
}
async function openDetail(id) {
  const sequence = ++detailRequest;
  const epoch = viewEpoch;
  try {
    const item = await request(`review/${encodeURIComponent(id)}`);
    if (sequence !== detailRequest || epoch !== viewEpoch) return;
    selectedId = id;
    detail.replaceChildren();
    const title = node('h3', 'Classification evidence');
    const back = node('button', 'Back to results');
    back.type = 'button';
    const discardPrompt = node('div', undefined, 'notice');
    discardPrompt.hidden = true;
    const discard = node('button', 'Discard unsaved edits and return');
    discard.type = 'button';
    const keep = node('button', 'Keep editing');
    keep.type = 'button';
    discardPrompt.append(node('p', 'This row has unsaved form edits.'), discard, keep);
    const returnToResults = () => {
      setDraftDirty(false);
      editMessage = '';
      selectedId = null;
      detail.hidden = true;
      document.getElementById('review-results').hidden = false;
      const origin = rows.querySelector(`[data-row-id="${id}"]`);
      (origin ?? form.elements.search).focus();
    };
    back.addEventListener('click', () => {
      if (editDirty) {
        discardPrompt.hidden = false;
        discard.focus();
      } else returnToResults();
    });
    discard.addEventListener('click', returnToResults);
    keep.addEventListener('click', () => {
      discardPrompt.hidden = true;
      back.focus();
    });
    const facts = node('dl');
    facts.append(
      field('Stable row ID', item.id),
      field('Normalized key', item.normalizedText),
      field('Decision', item.status),
      field('Source', item.source),
      field('Rationale', item.rationale),
      field('Content revision', item.contentRevision),
      field('Human note', item.rowNote ?? 'None')
    );
    detail.append(
      title,
      back,
      discardPrompt,
      node('p', item.context.disclaimer),
      facts,
      reviewEditor(item)
    );
    const variants = node('div');
    for (const [index, variant] of item.variants.entries())
      variants.append(block(`Original notice variant ${index + 1}`, variant));
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
    document.getElementById('review-results').hidden = true;
    detail.hidden = false;
    back.focus();
  } catch (error) {
    if (sequence === detailRequest && epoch === viewEpoch) {
      selectedId = null;
      detail.hidden = true;
      document.getElementById('review-results').hidden = false;
      summary.textContent = error.message;
    }
  }
}

export function initReview(fetchReview, sendEdit, draftChanged) {
  request = fetchReview;
  submitEdit = sendEdit;
  onDraftChange = draftChanged;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    page = 1;
    void loadRows();
  });
  for (const key of ['status', 'source'])
    form.elements[key].addEventListener('change', () => {
      page = 1;
      void loadRows();
    });
  pager.querySelector('[name="previous"]').addEventListener('click', () => {
    page--;
    void loadRows();
  });
  pager.querySelector('[name="next"]').addEventListener('click', () => {
    page++;
    void loadRows();
  });
}

export function setReviewBusy(busy) {
  externalBusy = busy;
  updateEditorControls();
}

export function updateReview(setup) {
  currentSetup = setup;
  updateEditorControls();
  section.hidden = !setup.analysis;
  if (!setup.analysis) {
    viewEpoch++;
    listRequest++;
    detailRequest++;
    if (loadedRevision !== null) form.reset();
    loadedRevision = null;
    selectedId = null;
    setDraftDirty(false);
    editMessage = '';
    updateEditorControls = () => {};
    page = 1;
    rows.replaceChildren();
    summary.textContent = 'Start analysis to review evidence.';
    detail.replaceChildren();
    detail.hidden = true;
    document.getElementById('review-results').hidden = false;
    return;
  }
  const revision = `${setup.configurationRevision}:${setup.contentRevision}`;
  if (loadedRevision !== revision) {
    viewEpoch++;
    listRequest++;
    detailRequest++;
    const reopenId = selectedId;
    loadedRevision = revision;
    detail.replaceChildren();
    detail.hidden = true;
    document.getElementById('review-results').hidden = false;
    if (reopenId) void openDetail(reopenId);
    void loadRows();
    if (!reopenId) {
      const heading = document.getElementById('review-heading');
      heading.tabIndex = -1;
      heading.focus();
    }
  }
}
