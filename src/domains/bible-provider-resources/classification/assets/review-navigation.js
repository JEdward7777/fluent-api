const stateKey = 'licenseReviewNavigationV1';
const initialView = { search: '', status: 'all', source: 'all', page: 1, row: null };
const statuses = ['all', 'allowed', 'forbidden', 'unknown'];
const sources = ['all', 'table', 'rule', 'gemini', 'manual'];
const maxSearchLength = 500;

function readEntry(state) {
  const entry = state?.[stateKey];
  if (
    !entry ||
    !/^[\da-f-]{36}$/.test(entry.launchId) ||
    !/^[\da-f]{32}$/.test(entry.chain) ||
    !Number.isSafeInteger(entry.index) ||
    entry.index < 0 ||
    !Number.isSafeInteger(entry.configuration) ||
    typeof entry.search !== 'string' ||
    entry.search.length > maxSearchLength ||
    !statuses.includes(entry.status) ||
    !sources.includes(entry.source) ||
    !Number.isSafeInteger(entry.page) ||
    entry.page < 1 ||
    !(entry.row === null || (typeof entry.row === 'string' && /^[\da-f]{64}$/.test(entry.row)))
  )
    return null;
  const { launchId, chain, index, configuration, search, status, source, page, row } = entry;
  const listIndex =
    Number.isSafeInteger(entry.listIndex) && entry.listIndex >= 0 && entry.listIndex < index
      ? entry.listIndex
      : index - 1;
  return { launchId, chain, index, configuration, search, status, source, page, row, listIndex };
}

const chainId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');

export function initReviewNavigation(form, onNavigate, mayTraverse) {
  form.elements.search.maxLength = maxSearchLength;
  let entry;
  let pending = null;
  let repairTimer;
  let dirty = false;
  const beforeUnload = (event) => {
    event.preventDefault();
    event.returnValue = '';
  };

  const write = (method) => {
    if (!pending?.repair) window.history[method]({ [stateKey]: entry }, '');
  };
  const repairTraversal = () => {
    window.clearTimeout(repairTimer);
    repairTimer = window.setTimeout(() => {
      if (!pending?.repair) return;
      const here = readEntry(window.history.state);
      if (here?.chain === entry.chain && here.index !== entry.index)
        window.history.go(entry.index - here.index);
    }, 0);
  };
  const push = (change) => {
    if (!entry || entry.row || pending) return;
    if (Object.entries(change).every(([key, value]) => entry[key] === value)) return;
    entry = { ...entry, ...change, index: entry.index + 1 };
    write('pushState');
    onNavigate();
  };
  const replaceRow = () => {
    entry = { ...entry, row: null };
    write('replaceState');
    onNavigate();
  };

  window.addEventListener('popstate', (event) => {
    const target = readEntry(event.state);
    if (!entry) return;
    if (!target || target.chain !== entry.chain) {
      if (pending && !pending.repair) {
        pending = null;
        entry = { ...entry, index: 0, chain: chainId() };
        replaceRow();
      }
      return;
    }
    if (pending?.repair) {
      if (target.index === pending.index) {
        pending = null;
        write('replaceState');
      } else repairTraversal();
      return;
    }
    const discardConfirmed = pending?.index === target.index && pending.discardConfirmed;
    pending = null;
    if (target.index === entry.index) return;
    if (
      ['row', 'page', 'search', 'status', 'source', 'configuration'].every(
        (key) => target[key] === entry[key]
      )
    ) {
      Object.assign(entry, target);
      return;
    }
    if (
      !mayTraverse() ||
      (!discardConfirmed &&
        dirty &&
        // eslint-disable-next-line no-alert -- Confirm browser traversal before discarding the editor.
        !window.confirm(
          'Discard unsaved row edits? Cancel to stay and apply the decision or update the note.'
        ))
    ) {
      pending = { index: entry.index, repair: true };
      repairTraversal();
      return;
    }
    entry = target;
    onNavigate();
  });

  const applyFilters = () =>
    push({
      search: form.elements.search.value,
      status: form.elements.status.value,
      source: form.elements.source.value,
      page: 1,
    });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    applyFilters();
  });
  for (const key of ['status', 'source'])
    form.elements[key].addEventListener('change', applyFilters);
  return {
    sync(setup) {
      if (entry === undefined) entry = readEntry(window.history.state);
      const sameLaunch = entry?.launchId === setup.launchId;
      if (
        !sameLaunch ||
        entry.configuration !== setup.loadRevision ||
        (!setup.analysis && entry.row)
      ) {
        entry = {
          ...initialView,
          launchId: setup.launchId,
          chain: sameLaunch ? entry.chain : chainId(),
          index: sameLaunch ? entry.index : 0,
          configuration: setup.loadRevision,
        };
        write('replaceState');
      }
      return entry;
    },
    pushStage(url) {
      if (!entry || pending || !mayTraverse()) return false;
      entry.index++;
      window.history.pushState({ [stateKey]: entry }, '', url);
      return true;
    },
    goTo(page) {
      push({ page });
    },
    openRow(row) {
      push({ row, listIndex: entry.index });
    },
    backToResults(discardConfirmed = false) {
      if (!entry?.row || pending || !mayTraverse()) return;
      if (entry.index > 0) {
        const index = entry.listIndex ?? entry.index - 1;
        pending = { index, discardConfirmed };
        window.history.go(index - entry.index);
      } else replaceRow();
    },
    forgetRow: replaceRow,
    setPage(view, page) {
      if (entry !== view || entry.page === page) return;
      entry.page = page;
      write('replaceState');
    },
    setDirty(value) {
      dirty = value;
      if (value) window.addEventListener('beforeunload', beforeUnload);
      else window.removeEventListener('beforeunload', beforeUnload);
    },
  };
}
