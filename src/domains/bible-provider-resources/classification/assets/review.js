import { reviewEditFeedback, validateReviewEdit } from './review-edit-feedback.js';
import { initReviewNavigation } from './review-navigation.js';
import { initReviewPagination } from './review-pagination.js';
import { reassessmentUnavailable, reviewRerunActions, syncRerunButtons } from './review-rerun.js';

const section = document.getElementById('review');
const form = document.getElementById('review-filter');
const rows = document.getElementById('review-rows');
const summary = document.getElementById('review-summary');
const detail = document.getElementById('review-detail');
const results = document.getElementById('review-results');
const heading = document.getElementById('review-heading');
const viewStatus = document.getElementById('review-view-status');
let request;
let submitEdit;
let selectRerun;
let onDraftChange = () => {};
let currentSetup;
let loadedRevision = null;
let renderedView;
let listRequest = 0;
let detailRequest = 0;
let editBusy = false;
let externalBusy = false;
let dirtySettings = false;
let editDirty = false;
let editMessage = '';
let updateEditorControls = () => {};
const navigation = initReviewNavigation(
  form,
  () => updateReview(currentSetup),
  () => !editBusy
);

const pagination = initReviewPagination(section, (page) => navigation.goTo(page));

function setDraftDirty(value) {
  if (editDirty === value) return;
  editDirty = value;
  navigation.setDirty(value);
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
function currentRevision(result) {
  return `${result.configurationRevision}:${result.contentRevision}` === loadedRevision;
}
async function loadRows(view, focusRow) {
  const sequence = ++listRequest;
  pagination.loading();
  try {
    const { search, status, source, page: requestedPage } = view;
    const result = await request(
      `review?${new URLSearchParams({ search, status, source, page: requestedPage })}`
    );
    if (sequence !== listRequest) return;
    if (!currentRevision(result))
      throw new Error('Review changed. Reload to see the current results.');
    const { page, total, allCount } = result;
    navigation.setPage(view, page);
    rows.replaceChildren();
    for (const item of result.rows) {
      const tr = node('tr');
      const action = node('button', item.preview);
      action.type = 'button';
      action.dataset.rowId = item.id;
      action.addEventListener('click', () => navigation.openRow(item.id));
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
          `${item.reviewState ?? 'unreviewed'}${item.reviewedBy ? ` — ${item.reviewedBy}` : ''}`
        ),
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
          ['Affected Bibles', 'Source', 'Decision', 'Review state', 'Saved model votes'][index],
        ]))
        cell.dataset.label = label;
      rows.append(tr);
    }
    summary.textContent =
      (total < allCount ? `${total} of ${allCount} classifications match. ` : '') +
      result.context.disclaimer;
    pagination.render(result);
    if (!result.rows.length) {
      const empty = node('tr');
      empty.append(node('td', 'No matching classifications. Change search or filters.'));
      rows.append(empty);
    }
    if (focusRow && !view.row)
      (rows.querySelector(`[data-row-id="${focusRow}"]`) ?? form.elements.search).focus();
  } catch (error) {
    if (sequence === listRequest) {
      rows.replaceChildren();
      pagination.clear();
      summary.textContent =
        error.message === 'Start analysis before reviewing evidence'
          ? 'Review is no longer available. Reload to see the current setup.'
          : error.message;
    }
  }
}
function reviewEditor(item) {
  const editor = node('form', undefined, 'review-editor');
  const heading = node('h4', 'Human review');
  const help = node(
    'p',
    'Applying a reasoned decision records a new human review, even if the decision stays the same. For an unknown entry, updating the note keeps the existing decision, reason, reviewer and review time. After an edit changes the review, Preview again and Save to write it.'
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
  const reviewer = node('input');
  reviewer.name = 'reviewedBy';
  reviewer.type = 'text';
  reviewer.maxLength = 200;
  reviewer.value = item.reviewedBy ?? '';
  const initialReviewer = reviewer.value;
  const note = node('textarea');
  note.name = 'note';
  note.rows = 3;
  note.value = item.rowNote ?? '';
  const initialNote = note.value;
  const decisionLabel = node('label', 'Decision');
  decisionLabel.append(decision);
  const reasonLabel = node('label', 'Reason for decision');
  reasonLabel.append(reason);
  const reviewerLabel = node('label', 'Human reviewer name');
  reviewerLabel.append(reviewer);
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
  const feedback = reviewEditFeedback(error);
  const apply = node('button', 'Apply reasoned decision');
  apply.type = 'submit';
  apply.value = 'disposition';
  apply.name = 'editKind';
  const saveNote = node('button', 'Update unknown note');
  saveNote.type = 'submit';
  saveNote.value = 'unknown-note';
  saveNote.name = 'editKind';
  const actions = node('div', undefined, 'actions');
  const applyHelp = node('span', undefined, 'action-help');
  const noteHelp = node('span', undefined, 'action-help');
  applyHelp.append(apply);
  noteHelp.append(saveNote);
  actions.append(applyHelp, noteHelp);
  editor.append(heading, decisionLabel, reviewerLabel, reasonLabel, warning, agreement, noteLabel);
  editor.append(actions, error, help);
  const update = () => {
    const message = item.overrideWarnings[decision.value];
    warning.hidden = !message;
    warning.textContent = message ?? '';
    agreement.hidden = !message;
    noteLabel.hidden = decision.value !== 'unknown' && note.value === initialNote;
    noteHelp.hidden = item.status !== 'unknown' || decision.value !== 'unknown';
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
  editor.addEventListener('input', feedback.onInput);
  editor.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (editBusy || externalBusy) return;
    const kind = event.submitter?.value ?? 'disposition';
    const message = item.overrideWarnings[decision.value];
    feedback.clear();
    if (
      kind === 'unknown-note' &&
      (decision.value !== item.status ||
        reason.value !== initialReason ||
        reviewer.value !== initialReviewer)
    ) {
      feedback.showNoteConflict(decision, reason, reviewer);
      return;
    }
    if (kind === 'disposition' && decision.value !== 'unknown' && note.value !== initialNote) {
      noteLabel.hidden = false;
      feedback.show('Restore the note before applying a decision other than unknown.', note);
      return;
    }
    if (!validateReviewEdit(kind, reviewer, reason, note, feedback)) return;
    if (kind === 'disposition' && message && !agree.checked) {
      feedback.show(
        'Acknowledge the automatic-decision warning before applying this override.',
        agree
      );
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
            reviewedBy: reviewer.value,
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
        ? `Review edit applied. ${result.warning} Preview again before Save.`
        : 'Review edit applied. Preview again before Save.';
      if (result.setup.contentRevision === item.contentRevision) {
        error.textContent = 'No content changed; the existing preview remains current.';
        editMessage = '';
      }
    } catch (failure) {
      feedback.show(failure.message);
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
  try {
    const item = await request(`review/${encodeURIComponent(id)}`);
    if (sequence !== detailRequest) return;
    if (!currentRevision(item))
      throw new Error('Review changed. Reload to see the current results.');
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
    discardPrompt.append(
      node(
        'p',
        'This row has unsaved edits. Choose Keep editing, then apply the decision or update the note to keep your changes.'
      ),
      discard,
      keep
    );
    back.addEventListener('click', () => {
      if (editBusy) return;
      if (editDirty) {
        discardPrompt.hidden = false;
        keep.focus();
      } else navigation.backToResults();
    });
    discard.addEventListener('click', () => navigation.backToResults(true));
    keep.addEventListener('click', () => {
      discardPrompt.hidden = true;
      back.focus();
    });
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
    detail.append(
      title,
      back,
      discardPrompt,
      node('p', item.context.disclaimer),
      facts,
      reviewEditor(item)
    );
    if (!currentSetup.practice)
      detail.append(
        node('h4', 'Explicit reassessment'),
        reviewRerunActions(item, {
          selectRerun,
          isBusy: rerunUnavailable,
          showError: (message) => {
            summary.textContent = message;
          },
        })
      );
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
    viewStatus.hidden = true;
    detail.hidden = false;
    back.focus();
  } catch (error) {
    if (sequence === detailRequest) {
      navigation.forgetRow();
      viewStatus.hidden = false;
      viewStatus.textContent =
        error.message === 'Review row was not found'
          ? 'This row is no longer available. Showing results.'
          : 'Could not open this row. Check the results or reload the review.';
    }
  }
}

export function initReview(fetchReview, sendEdit, draftChanged, onRerun = async () => {}) {
  request = fetchReview;
  submitEdit = sendEdit;
  selectRerun = onRerun;
  onDraftChange = draftChanged;
}

function rerunUnavailable() {
  const busy = dirtySettings || editDirty || editBusy || externalBusy;
  return reassessmentUnavailable(currentSetup, busy);
}
export function setReviewBusy(busy, settingsChanged = dirtySettings) {
  dirtySettings = settingsChanged;
  externalBusy = busy;
  updateEditorControls();
  syncRerunButtons(detail, rerunUnavailable());
}

export function updateReview(setup) {
  currentSetup = setup;
  const view = navigation.sync(setup);
  const previous = renderedView;
  renderedView = view;
  updateEditorControls();
  syncRerunButtons(detail, rerunUnavailable());
  section.hidden = !setup.analysis;
  if (!setup.analysis) {
    listRequest++;
    detailRequest++;
    if (loadedRevision !== null || previous !== view) form.reset();
    loadedRevision = null;
    setDraftDirty(false);
    editMessage = '';
    updateEditorControls = () => {};
    rows.replaceChildren();
    summary.textContent = setup.practice
      ? 'Prepare free evidence to review the practice rows.'
      : 'Inspect a source to review its classifications.';
    detail.replaceChildren();
    detail.hidden = true;
    results.hidden = false;
    viewStatus.hidden = true;
    return;
  }
  const revision = `${setup.configurationRevision}:${setup.contentRevision}`;
  if (loadedRevision !== revision || previous !== view) {
    listRequest++;
    detailRequest++;
    const focusRow = previous?.row;
    if (['search', 'status', 'source', 'page'].some((key) => previous?.[key] !== view[key]))
      rows.replaceChildren();
    if (previous !== view) {
      for (const key of ['search', 'status', 'source']) form.elements[key].value = view[key];
      setDraftDirty(false);
      editMessage = '';
    }
    loadedRevision = revision;
    detail.replaceChildren();
    detail.hidden = true;
    results.hidden = Boolean(view.row);
    viewStatus.hidden = !view.row;
    viewStatus.textContent = view.row ? 'Loading classification evidence…' : '';
    updateEditorControls = () => {};
    if (view.row) void openDetail(view.row);
    void loadRows(view, focusRow);
    if (!view.row && !focusRow && previous === view) {
      heading.tabIndex = -1;
      heading.focus();
    }
  }
}
