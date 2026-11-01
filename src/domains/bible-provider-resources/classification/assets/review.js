const section = document.getElementById('review');
const form = document.getElementById('review-filter');
const rows = document.getElementById('review-rows');
const summary = document.getElementById('review-summary');
const detail = document.getElementById('review-detail');
const pager = document.getElementById('review-pager');
let request;
let selectedId = null;
let loadedRevision = null;
let page = 1;
let listRequest = 0;
let detailRequest = 0;
let viewEpoch = 0;

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
    back.addEventListener('click', () => {
      selectedId = null;
      detail.hidden = true;
      document.getElementById('review-results').hidden = false;
      const origin = rows.querySelector(`[data-row-id="${id}"]`);
      (origin ?? form.elements.search).focus();
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
    detail.append(title, back, node('p', item.context.disclaimer), facts);
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
        block('Exact saved request', JSON.stringify(sample.request, null, 2)),
        block('Raw saved response', sample.response),
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

export function initReview(fetchReview) {
  request = fetchReview;
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

export function updateReview(setup) {
  section.hidden = !setup.analysis;
  if (!setup.analysis) {
    viewEpoch++;
    listRequest++;
    detailRequest++;
    if (loadedRevision !== null) form.reset();
    loadedRevision = null;
    selectedId = null;
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
