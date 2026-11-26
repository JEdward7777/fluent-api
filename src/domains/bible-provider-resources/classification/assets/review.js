import { reviewAddress } from './review-address.js';
import { createDraftSync, reviewShortcuts } from './review-edit-feedback.js';
import { appendEvidence, node, reviewChip } from './review-evidence.js';
import {
  bindReviewLink,
  initReviewNavigation,
  keepEditorPosition,
  reviewLink,
  reviewQuery,
  showFilters,
} from './review-navigation.js';
import { initReviewPagination, renderReviewRows } from './review-pagination.js';
import {
  reassessmentUnavailable,
  reviewRerunActions,
  syncRerunButtons,
  syncRerunOutcome,
} from './review-rerun.js';

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
let openEstimate;
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
let activeSync;
let refreshEditor;
let shortcut;
let refreshSetup;
const filtered = (view) =>
  view.search || [view.status, view.source, view.reviewState].some((v) => v !== 'all');
const detailPath = (id) =>
  `review/${encodeURIComponent(id)}?${new URLSearchParams(reviewQuery(renderedView))}`;
document.addEventListener('keydown', (event) => {
  if (!detail.hidden && section.getClientRects().length) shortcut?.(event);
});
let updateEditorControls = () => {};
const navigation = initReviewNavigation(
  form,
  () => updateReview(currentSetup),
  () => activeSync?.flush() ?? true
);

export const { pushStage } = navigation;

const pageAddress = (page) => reviewAddress({ ...renderedView, page, row: null });
const pagination = initReviewPagination(
  section,
  (page, size) => navigation.goTo(page, size),
  pageAddress
);
const backLinks = ['back-results-top', 'back-results-bottom'].map((id) =>
  document.getElementById(id)
);
for (const link of backLinks) bindReviewLink(link, navigation.backToResults);

function setDraftDirty(value) {
  if (editDirty === value) return;
  editDirty = value;
  navigation.setDirty(value);
  onDraftChange(value);
}

export const hasUnsavedReviewDraft = () => editDirty;

function currentRevision(result) {
  return `${result.configurationRevision}:${result.contentRevision}` === loadedRevision;
}
async function loadRows(view, focusRow) {
  const sequence = ++listRequest;
  pagination.loading();
  try {
    const result = await request(`review?${new URLSearchParams(reviewQuery(view))}`);
    if (sequence !== listRequest) return;
    if (!currentRevision(result))
      throw new Error('Review changed. Reload to see the current results.');
    const { page, total, allCount } = result;
    navigation.setPage(view, page);
    renderReviewRows(rows, result.rows, view, navigation.openRow);
    summary.textContent = `${total} of ${allCount} classifications · ${result.remaining} left${filtered(view) ? ' (filtered)' : ''}. ${result.context.disclaimer}`;
    pagination.render(result);
    if (!result.rows.length) {
      const empty = node('tr');
      empty.append(node('td', 'No matching classifications. Change search or filters.'));
      rows.append(empty);
    }
    if (focusRow && !view.row && section.getClientRects().length) {
      (
        rows.querySelector(`[data-row-id="${view.anchor ?? focusRow}"]`) ?? form.elements.search
      ).focus({ preventScroll: true });
      window.scrollTo(0, view.scroll ?? 0);
    }
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
function reviewEditor(item, refreshEvidence) {
  const editor = node('section', undefined, 'review-editor');
  const decision = node('select');
  decision.name = 'status';
  for (const [status, key] of [
    ['allowed', 'A'],
    ['forbidden', 'F'],
    ['unknown', 'U'],
  ])
    decision.append(new Option(`${status[0].toUpperCase() + status.slice(1)} (${key})`, status));
  decision.value = item.status;
  const comment = node('textarea');
  comment.name = 'reviewComment';
  comment.maxLength = 2000;
  comment.value = item.reviewComment ?? '';
  const state = node('p');
  const count = node('span');
  const warning = node('p', '', 'notice');
  const feedback = node('p');
  feedback.setAttribute('role', 'status');
  const decisionLabel = node('label', 'Permission');
  const commentLabel = node('label', 'Optional comment');
  decisionLabel.append(decision);
  commentLabel.append(comment);
  const button = (text, run) => {
    const el = node('button', text);
    el.type = 'button';
    el.addEventListener('click', run);
    return el;
  };
  let nextNavigation;
  let retry;
  let useSession;
  let update;
  function rebaseFields(values, unchanged) {
    if (unchanged('status')) decision.value = values.status;
    if (unchanged('reviewComment') && comment.value !== (values.reviewComment ?? ''))
      comment.value = values.reviewComment ?? '';
  }
  const sync = createDraftSync(item, {
    send: submitEdit,
    rebaseFields,
    values: () => ({ status: decision.value, reviewComment: comment.value || null }),
    dirty: setDraftDirty,
    feedback: (text, failed = false, conflict = false) => {
      feedback.textContent = text;
      retry.hidden = !failed;
      useSession.hidden = !conflict;
      update();
    },
    async acknowledged(ack, kind, unchanged) {
      const [fresh, setup] = await Promise.all([request(detailPath(item.id)), request('setup')]);
      if (
        fresh.epoch !== ack.epoch ||
        fresh.contentRevision !== ack.contentRevision ||
        setup.contentRevision !== ack.contentRevision
      ) {
        throw Object.assign(
          new Error(
            JSON.stringify({
              epoch: fresh.epoch,
              contentRevision: fresh.contentRevision,
              values: fresh,
            })
          ),
          { status: 409 }
        );
      }
      refreshEvidence(fresh);
      Object.assign(item, fresh);
      loadedRevision = `${item.configurationRevision}:${item.contentRevision}`;
      currentSetup = setup;
      refreshSetup(setup);
      rebaseFields(item, unchanged);
      if (kind === 'mark-next') nextNavigation = ack.navigation;
      else if (nextNavigation) nextNavigation = fresh.navigation;
      update();
    },
  });
  activeSync = sync;
  const run = async (kind) => {
    if (editBusy || externalBusy) return;
    editBusy = true;
    try {
      if (kind === 'mark-next') {
        await navigation.finishAction(
          () => sync.command({ kind, query: reviewQuery(renderedView) }),
          () => nextNavigation?.nextEligibleId
        );
      } else await sync.command({ kind });
    } finally {
      editBusy = false;
      syncRerunButtons(detail, rerunUnavailable());
    }
  };
  const mark = button('Mark reviewed (R)', () => run('mark'));
  const next = button('Mark reviewed & next (Shift+Enter)', () => run('mark-next'));
  const revert = button('Revert edit (Ctrl+Backspace)', () => run('revert'));
  retry = button('Retry sync', () =>
    navigation.finishAction(
      () => sync.retry(),
      () => nextNavigation?.nextEligibleId
    )
  );
  retry.hidden = true;
  useSession = button('Discard my local edit and load the session version', async () => {
    try {
      const before = sync.generation;
      const latest = await request('setup');
      if (before !== sync.generation) {
        feedback.textContent = 'You edited this row again. Retry sync or discard the current edit.';
        return;
      }
      setDraftDirty(false);
      loadedRevision = null;
      refreshEditor = undefined;
      refreshSetup(latest);
    } catch (error) {
      feedback.textContent = error.message;
    }
  });
  useSession.hidden = true;
  const move = (key) => {
    if (!editBusy) void navigation.openRow(() => item.navigation[key]);
  };
  const prev = reviewLink('Previous (K)', () => move('previousId'));
  const following = reviewLink('Next (J)', () => move('nextId'));
  const guide = node('details');
  guide.append(
    node('summary', 'Keyboard shortcuts'),
    node(
      'p',
      'J / K: next / previous. A / F / U: Allowed / Forbidden / Unknown. R: mark reviewed. Shift+Enter: mark reviewed and next. Ctrl+Backspace: revert. Escape: back to results. Shift+Enter also works in Permission and Optional comment. Other editing keys keep their ordinary behavior. Tab leaves the field.'
    )
  );
  editor.append(
    state,
    decisionLabel,
    warning,
    commentLabel,
    mark,
    next,
    count,
    revert,
    feedback,
    retry,
    useSession,
    prev,
    following,
    guide
  );
  update = () => {
    state.replaceChildren(
      reviewChip(sync.hasLocalIntent ? { reviewState: 'human_reviewed', pending: true } : item)
    );
    count.setAttribute('aria-live', 'polite');
    count.textContent = `${item.remaining} left${filtered(renderedView) ? ' (filtered)' : ''}`;
    warning.textContent = item.overrideWarnings[decision.value] ?? '';
    warning.hidden = !warning.textContent;
    prev.hidden = !item.navigation.previousId;
    following.hidden = !item.navigation.nextId;
    for (const [link, row] of [
      [prev, item.navigation.previousId],
      [following, item.navigation.nextId],
    ])
      if (row) link.href = reviewAddress({ ...renderedView, row });
    const locked =
      externalBusy ||
      Boolean(currentSetup.activeOperationId) ||
      !['inspected', 'reviewing', 'previewed', 'saved'].includes(currentSetup.state);
    for (const control of [decision, comment, mark, next, revert]) control.disabled = locked;
  };
  refreshEditor = (fresh) => {
    refreshEvidence(fresh);
    Object.assign(item, fresh);
    decision.value = item.status;
    const value = item.reviewComment ?? '';
    if (comment.value !== value) {
      const { selectionStart, selectionEnd } = comment;
      comment.value = value;
      comment.setSelectionRange(selectionStart, selectionEnd);
    }
    feedback.textContent = item.pending ? 'Kept in session · awaiting Save' : 'No pending edit';
    update();
  };
  updateEditorControls = update;
  const change = (field) => {
    sync.schedule(field);
    update();
  };
  decision.addEventListener('change', () => change('status'));
  comment.addEventListener('input', () => change('reviewComment'));
  for (const el of [comment, decision])
    el.addEventListener('blur', () => {
      if (editDirty) void sync.flush();
    });
  shortcut = reviewShortcuts({
    back: navigation.backToResults,
    decision,
    comment,
    change: () => change('status'),
    mark,
    next,
    revert,
    move,
  });
  feedback.textContent = item.pending ? 'Kept in session · awaiting Save' : 'No pending edit';
  update();
  return editor;
}
async function openDetail(id, focus = true, retainEditor = false, restorePosition) {
  const sequence = ++detailRequest;
  try {
    const item = await request(detailPath(id));
    if (sequence !== detailRequest) return;
    if (!currentRevision(item))
      throw new Error('Review changed. Reload to see the current results.');
    if (retainEditor && editDirty) return;
    if (retainEditor && refreshEditor) {
      refreshEditor(item);
      return;
    }
    detail.replaceChildren();
    const title = node('h3', item.originalNoticeLabel.slice(0, 160));
    detail.dataset.rowId = item.id;
    const evidence = node('div', undefined, 'review-evidence');
    const refreshEvidence = appendEvidence(evidence, item);
    detail.append(
      title,
      node('p', item.context.disclaimer),
      reviewEditor(item, refreshEvidence),
      evidence
    );
    if (!currentSetup.practice)
      detail.append(
        node('h4', 'Explicit reassessment'),
        reviewRerunActions(item, {
          selectRerun,
          isBusy: rerunUnavailable,
          openEstimate,
          getSetup: () => currentSetup,
        })
      );
    viewStatus.hidden = true;
    detail.hidden = false;
    if (focus && section.getClientRects().length) {
      if (restorePosition) restorePosition(detail.querySelector('.review-editor'));
      else backLinks[0].focus();
    }
  } catch (error) {
    if (sequence === detailRequest) {
      if (retainEditor) {
        viewStatus.hidden = false;
        viewStatus.textContent =
          'Review changed. Local edits will be checked against the session before syncing.';
        return;
      }
      navigation.forgetRow();
      viewStatus.hidden = false;
      viewStatus.textContent =
        error.message === 'Review row was not found'
          ? 'This row is no longer available. Showing results.'
          : 'Could not open this row. Check the results or reload the review.';
    }
  }
}

export function initReview(fetchReview, sendEdit, draftChanged, onRerun, refresh, openAiEstimate) {
  openEstimate = openAiEstimate;
  refreshSetup = refresh;
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

export function updateReview(setup, focus = true) {
  currentSetup = setup;
  const view = navigation.sync(setup);
  for (const link of backLinks) {
    link.hidden = !setup.analysis || !view.row;
    link.href = reviewAddress({ ...view, row: null });
  }
  const previous = renderedView;
  renderedView = view;
  if (previous !== view) showFilters(form, view);
  updateEditorControls();
  syncRerunButtons(detail, rerunUnavailable());
  syncRerunOutcome(detail, detail.dataset.rowId, setup);
  section.hidden = !setup.analysis;
  if (!setup.analysis) {
    listRequest++;
    detailRequest++;
    if (loadedRevision !== null || previous !== view) form.reset();
    loadedRevision = null;
    setDraftDirty(false);
    activeSync = undefined;
    updateEditorControls = () => {};
    rows.replaceChildren();
    summary.textContent = 'Load a source to review its classifications.';
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
    if (
      ['search', 'status', 'source', 'reviewState', 'pageSize', 'page'].some(
        (key) => previous?.[key] !== view[key]
      )
    )
      rows.replaceChildren();
    if (previous !== view) {
      for (const key of ['search', 'status', 'source', 'reviewState'])
        form.elements[key].value = view[key];
      setDraftDirty(false);
      activeSync = undefined;
    }
    loadedRevision = revision;
    if (previous === view && view.row && !detail.hidden && !focus) {
      void openDetail(view.row, false, true);
      return;
    }
    const restorePosition = focusRow && view.row ? keepEditorPosition(detail) : undefined;
    detail.replaceChildren();
    detail.hidden = true;
    results.hidden = Boolean(view.row);
    viewStatus.hidden = !view.row;
    viewStatus.textContent = view.row ? 'Loading classification evidence…' : '';
    updateEditorControls = () => {};
    if (view.row) void openDetail(view.row, focus, false, restorePosition);
    else {
      rows.replaceChildren();
      void loadRows(view, focus && focusRow);
    }
    if (focus && !view.row && !focusRow && previous === view) {
      heading.tabIndex = -1;
      heading.focus();
    }
  }
}
