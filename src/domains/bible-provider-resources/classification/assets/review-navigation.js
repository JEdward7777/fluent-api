const stateKey = 'licenseReviewNavigationV2';
const initial = {
  search: '',
  status: 'all',
  source: 'all',
  reviewState: 'all',
  page: 1,
  pageSize: 25,
  row: null,
};
const maxSearchLength = 500;
function validEntry(entry) {
  const uuid = /^[\da-f-]{36}$/;
  const row = /^[\da-f]{64}$/;
  return (
    entry &&
    uuid.test(entry.launchId) &&
    uuid.test(entry.chain) &&
    Number.isSafeInteger(entry.index) &&
    entry.index >= 0 &&
    Number.isSafeInteger(entry.configuration) &&
    typeof entry.search === 'string' &&
    entry.search.length <= maxSearchLength &&
    ['all', 'allowed', 'forbidden', 'unknown'].includes(entry.status) &&
    ['all', 'table', 'rule', 'gemini', 'manual'].includes(entry.source) &&
    ['all', 'unreviewed', 'llm_reviewed', 'human_reviewed'].includes(entry.reviewState) &&
    [1, 10, 25, 50, 100].includes(entry.pageSize) &&
    Number.isSafeInteger(entry.page) &&
    entry.page > 0 &&
    (entry.row === null ||
      (row.test(entry.row) &&
        Number.isSafeInteger(entry.listIndex) &&
        entry.listIndex >= 0 &&
        entry.listIndex < entry.index)) &&
    (entry.anchor == null || row.test(entry.anchor))
  );
}
export function reviewQuery(view) {
  return Object.fromEntries(
    Object.keys(initial)
      .filter((key) => key !== 'row')
      .map((key) => [key, view[key]])
  );
}

export function showFilters(form, view) {
  const banner = document.getElementById('review-filtered');
  const active = view.search ? [`Search: ${view.search}`] : [];
  for (const [key, name] of Object.entries({
    status: 'Decision',
    source: 'Source',
    reviewState: 'Review state',
  })) {
    if (view[key] === 'all') continue;
    const option = Array.from(form.elements[key].options).find(
      (option) => option.value === view[key]
    );
    active.push(`${name}: ${option.text}`);
  }
  banner.hidden = !active.length;
  banner.textContent = active.length ? `Filtered view · ${active.join(' · ')}` : '';
}

export function initReviewNavigation(form, onNavigate, flush) {
  let entry;
  let dirty = false;
  let traversal;
  let departure;
  const read = () => {
    const value = history.state?.[stateKey];
    return validEntry(value) ? value : undefined;
  };
  const write = (method, url = location.href) => history[method]({ [stateKey]: entry }, '', url);
  const notify = () => {
    window.dispatchEvent(new Event('review-location'));
    onNavigate();
  };
  function push(change, url, render = true) {
    if (!entry || traversal) return false;
    if (!render) {
      entry.index++;
      write('pushState', url);
      return true;
    }
    entry = { ...entry, ...change, index: entry.index + 1 };
    write('pushState', url);
    if (render) onNavigate();
    return true;
  }
  async function depart(proceed, ready = () => !dirty || flush()) {
    if (!entry || departure || traversal) return false;
    const source = entry;
    const intent = {};
    departure = intent;
    try {
      if (!(await ready()) || departure !== intent || source !== entry || traversal) return false;
      const here = read();
      if (here?.chain !== source.chain || here.index !== source.index) return false;
      return proceed();
    } finally {
      if (departure === intent) departure = undefined;
    }
  }
  function openRow(row) {
    if (!row || row === entry.row) return false;
    if (!entry.row) {
      entry.anchor = row;
      entry.scroll = window.scrollY;
      write('replaceState');
    }
    return push({ row, listIndex: entry.row ? entry.listIndex : entry.index });
  }
  function back() {
    if (!entry.row) return false;
    if (entry.listIndex < entry.index) {
      traversal = { destination: entry.listIndex };
      history.go(entry.listIndex - entry.index);
    } else {
      entry = { ...entry, row: null };
      write('replaceState');
      onNavigate();
    }
    return true;
  }
  window.addEventListener('popstate', async () => {
    departure = undefined;
    const target = read();
    if (!entry) return;
    if (!target) {
      const raw = history.state?.[stateKey];
      if (
        raw?.chain === entry.chain &&
        Number.isSafeInteger(raw.index) &&
        raw.index !== entry.index
      ) {
        traversal = { repair: true, destination: entry.index };
        history.go(entry.index - raw.index);
      }
      return;
    }
    if (target.chain !== entry.chain) return;
    if (traversal?.repair) {
      if (target.index !== entry.index) {
        history.go(entry.index - target.index);
        return;
      }
      const repair = traversal;
      const destination = repair.destination;
      if (destination === entry.index) {
        traversal = undefined;
        return;
      }
      const kept = await flush();
      if (traversal !== repair || read()?.index !== entry.index) return;
      if (kept) {
        traversal = { destination };
        history.go(destination - entry.index);
      } else traversal = undefined;
      return;
    }
    if (dirty && target.index !== entry.index) {
      traversal = { repair: true, destination: target.index };
      history.go(entry.index - target.index);
      return;
    }
    traversal = undefined;
    entry = target;
    notify();
  });
  const search = form.elements.search;
  search.maxLength = maxSearchLength;
  search.addEventListener('input', () => search.setCustomValidity(''));
  const filters = () => {
    search.setCustomValidity(
      search.value.length > maxSearchLength
        ? `Search must be ${maxSearchLength} characters or fewer.`
        : ''
    );
    if (!search.reportValidity()) {
      search.focus();
      return;
    }

    const change = Object.fromEntries(
      ['search', 'status', 'source', 'reviewState'].map((key) => [key, form.elements[key].value])
    );
    if (Object.keys(change).some((key) => change[key] !== entry[key]))
      push({ ...change, page: 1, anchor: null, scroll: 0 });
  };
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    filters();
  });
  for (const key of ['status', 'source', 'reviewState'])
    form.elements[key].addEventListener('change', filters);
  const beforeUnload = (event) => {
    event.preventDefault();
    event.returnValue = '';
  };
  return {
    sync(setup) {
      entry ??= read();
      if (
        entry?.launchId !== setup.launchId ||
        entry.configuration !== setup.loadRevision ||
        (!setup.analysis && entry.row)
      ) {
        entry = {
          ...initial,
          launchId: setup.launchId,
          configuration: setup.loadRevision,
          chain: entry?.chain ?? crypto.randomUUID(),
          index: entry?.index ?? 0,
        };
        write('replaceState');
      }
      return entry;
    },
    pushStage(url) {
      return depart(() => push({}, url, false));
    },
    goTo(page, pageSize = entry.pageSize) {
      if (page !== entry.page || pageSize !== entry.pageSize)
        push({ page, pageSize, anchor: null, scroll: 0 });
    },
    openRow(row) {
      return depart(() => openRow(typeof row === 'function' ? row() : row));
    },
    backToResults() {
      return depart(back);
    },
    finishAction(ready, nextRow) {
      return depart(() => {
        const row = nextRow();
        return row === null ? back() : openRow(row);
      }, ready);
    },
    forgetRow() {
      entry = { ...entry, row: null };
      write('replaceState');
      onNavigate();
    },
    setPage(view, page) {
      if (entry === view && entry.page !== page) {
        entry.page = page;
        write('replaceState');
      }
    },
    setDirty(value) {
      dirty = value;
      if (value) window.addEventListener('beforeunload', beforeUnload);
      else window.removeEventListener('beforeunload', beforeUnload);
    },
  };
}
