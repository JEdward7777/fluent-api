const launchedToken = window.location.hash.slice(1);
if (launchedToken) window.sessionStorage.setItem('license-workbench-token', launchedToken);
const token = launchedToken || window.sessionStorage.getItem('license-workbench-token');
window.history.replaceState(null, '', window.location.pathname + window.location.search);
const status = document.getElementById('status');
if (!token) {
  status.textContent =
    'Open the exact local URL printed by the workbench. Its fragment contains this session’s access token.';
} else {
  try {
    const response = await fetch('/api/setup', { headers: { 'x-workbench-token': token } });
    if (!response.ok)
      throw new Error(`Session access failed (${response.status}). Open the printed URL again.`);
    const setup = await response.json();
    for (const key of ['source', 'destination', 'input', 'output', 'model', 'sampleCount']) {
      document.getElementById(key).textContent =
        setup[key] === null ? 'Choose in setup' : String(setup[key]);
    }
    document.getElementById('settings').hidden = false;
    status.textContent =
      'Connected. Prefilled settings shown below; no inputs have been inspected.';
  } catch (error) {
    status.textContent =
      error instanceof Error ? error.message : 'Could not connect to the local session.';
  }
}
