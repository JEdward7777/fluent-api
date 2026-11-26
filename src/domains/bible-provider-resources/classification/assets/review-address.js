export const defaultReview = {
  search: '',
  status: 'all',
  source: 'all',
  reviewState: 'all',
  page: 1,
  pageSize: 25,
  row: null,
};
export const maxSearchLength = 500;
const valid = {
  search: (value) => typeof value === 'string' && value.length <= maxSearchLength,
  status: (value) => ['all', 'allowed', 'forbidden', 'unknown'].includes(value),
  source: (value) => ['all', 'table', 'rule', 'gemini', 'manual'].includes(value),
  reviewState: (value) => ['all', 'unreviewed', 'llm_reviewed', 'human_reviewed'].includes(value),
  page: (value) => Number.isSafeInteger(value) && value > 0,
  pageSize: (value) => [1, 10, 25, 50, 100].includes(value),
  row: (value) => value === null || (typeof value === 'string' && /^[\da-f]{64}$/.test(value)),
};

export function validReview(view) {
  return Object.entries(valid).every(([key, check]) => check(view[key]));
}

export function readReview(params) {
  const view = { ...defaultReview };
  if (params.get('stage') !== 'review') return view;
  for (const [key, check] of Object.entries(valid)) {
    if (!params.has(key)) continue;
    const raw = params.get(key);
    const value = typeof view[key] === 'number' ? Number(raw) : raw;
    if (check(value)) view[key] = value;
    else console.warn(`Ignoring invalid review address field: ${key}`);
  }
  return view;
}

// Build addresses from navigation fields only. Session credentials and edit contents
// have no place in a link, including when a link came from a different local port.
export function reviewAddress(view, stage = 'review') {
  const params = new URLSearchParams({ stage });
  if (stage === 'review')
    for (const [key, fallback] of Object.entries(defaultReview))
      if (view[key] !== fallback) params.set(key, view[key]);
  return `?${params}`;
}

const pendingKey = 'license-workbench-shared-review';
const tokenKey = 'license-workbench-token';

export function requestWorkbenchLauncher() {
  sessionStorage.removeItem(tokenKey);
  const url = new URL(location.href);
  if (url.searchParams.get('stage') === 'review') {
    const address = reviewAddress(readReview(url.searchParams));
    sessionStorage.setItem(pendingKey, address);
    history.replaceState(null, '', address);
  }
  return 'Open the URL printed by your own reviewer in this tab. If you use another tab or local port, open its Load stage and paste the shared address under Open a shared review.';
}

export function openWorkbenchSession() {
  const url = new URL(location.href);
  const launcher = url.hash.slice(1);
  if (launcher) sessionStorage.setItem(tokenKey, launcher);
  const token = launcher || sessionStorage.getItem(tokenKey);
  const pending = sessionStorage.getItem(pendingKey);
  if (launcher) {
    const query =
      !url.search && pending ? reviewAddress(readReview(new URLSearchParams(pending))) : url.search;
    history.replaceState(null, '', url.pathname + query);
  }
  if (token) sessionStorage.removeItem(pendingKey);
  window.addEventListener('hashchange', () => {
    if (location.hash) location.reload();
  });
  const form = document.getElementById('shared-review-form');
  const input = form.elements.address;
  input.addEventListener('input', () => input.setCustomValidity(''));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    try {
      const shared = new URL(input.value);
      if (shared.searchParams.get('stage') !== 'review' || shared.hash)
        throw new Error('Invalid shared review address');
      location.assign(reviewAddress(readReview(shared.searchParams)));
    } catch {
      input.setCustomValidity(
        'Paste a review address from the browser after opening a classification.'
      );
      input.reportValidity();
    }
  });
  return token;
}
