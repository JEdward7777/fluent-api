import { node } from './review-evidence.js';

const dialog = document.getElementById('changes-drawer');
const button = document.getElementById('view-changes');
const download = document.getElementById('changes-download');
const status = document.getElementById('changes-status');
const records = document.getElementById('changes-records');
let token;
let snapshot;
let generation = 0;

function recordView(row) {
  const details = node('details', '');
  details.append(
    node('summary', `${row.operation} · ${row.group} · ${row.key || '(empty notice)'}`)
  );
  details.addEventListener('toggle', () => {
    if (!details.open || details.childElementCount > 1) return;
    if (row.decision) details.append(node('p', row.decision));
    for (const [side, title] of [
      ['before', 'Before'],
      ['after', 'After'],
    ]) {
      const position = row[`${side}Index`];
      details.append(
        node('h4', title + (position == null ? '' : ` · position ${position + 1}`)),
        node('pre', row[side] === null ? 'Absent' : JSON.stringify(row[side], null, 2))
      );
    }
  });
  return details;
}

function destinationView(destination) {
  const section = node('section', '');
  section.append(node('h3', `${destination.kind} · ${destination.target}`));
  if (destination.kind === 'Database')
    section.append(
      node(
        'p',
        'Policy columns are shown below. PostgreSQL sets the creation and update timestamps at write time.'
      )
    );
  const changed = destination.records.filter(
    (row) => !['Preserve', 'Unchanged'].includes(row.operation)
  );
  section.append(node('p', `${changed.length} changed records.`), ...changed.map(recordView));
  const retained = destination.records.filter((row) =>
    ['Preserve', 'Unchanged'].includes(row.operation)
  );
  if (retained.length) {
    const details = node('details', '');
    details.append(node('summary', `Preserved and unchanged records (${retained.length})`));
    details.addEventListener('toggle', () => {
      if (details.open && details.childElementCount === 1)
        details.append(...retained.map(recordView));
    });
    section.append(details);
  }
  return section;
}

export function syncSaveChanges(next, blocked) {
  const key =
    !blocked &&
    !next.practice &&
    !next.activeOperationId &&
    ['saved', 'previewed'].includes(next.state) &&
    !next.preview?.conflicts.length
      ? next.preview?.token
      : null;
  if (token !== key) {
    generation++;
    snapshot = undefined;
    download.disabled = true;
    records.replaceChildren();
    if (dialog.open) dialog.close();
  }
  token = key;
  button.disabled = !key;
}

export function initSaveChanges(request, stale) {
  document.getElementById('changes-close').addEventListener('click', () => dialog.close());
  button.addEventListener('click', async () => {
    if (!token) return;
    const started = ++generation;
    const expected = token;
    download.disabled = true;
    status.textContent = 'Loading destination changes…';
    records.replaceChildren();
    dialog.showModal();
    try {
      const response = await request(`changes/${expected}`);
      if (started !== generation || response.previewToken !== token || !dialog.open) return;
      snapshot = response;
      records.replaceChildren(...response.destinations.map(destinationView));
      status.textContent = response.reviewer
        ? `Pending decisions reviewed by ${response.reviewer}.`
        : '';
      download.disabled = false;
    } catch (error) {
      if (started === generation) {
        status.textContent = error.message;
        if (error.status === 409) stale(error.message);
      }
    }
  });
  download.addEventListener('click', async () => {
    if (!snapshot || token !== snapshot.previewToken || download.disabled) return;
    const started = generation;
    const expected = token;
    download.disabled = true;
    try {
      const current = await request(`changes/${expected}`);
      if (generation !== started || current.previewToken !== token || !dialog.open) return;
      const url = URL.createObjectURL(
        new Blob([`${JSON.stringify(current, null, 2)}\n`], { type: 'application/json' })
      );
      const link = node('a', '');
      link.href = url;
      link.download = 'license-destination-changes.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (error) {
      if (generation === started) {
        snapshot = undefined;
        records.replaceChildren();
        status.textContent = error.message;
        if (error.status === 409) stale(error.message);
      }
    } finally {
      if (generation === started) download.disabled = !snapshot;
    }
  });
}
