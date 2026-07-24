// Options page: one setting, the Echo server address.

const serverInput = document.getElementById('server');
const statusEl = document.getElementById('status');

function setStatus(message, kind = '') {
  statusEl.textContent = message;
  statusEl.className = kind;
}

async function load() {
  const stored = await chrome.storage.sync.get({ server: ECHO_DEFAULT_SERVER });
  serverInput.value = stored.server || ECHO_DEFAULT_SERVER;
}

async function save() {
  const normalized = echoNormalizeServer(serverInput.value);
  if (!normalized) {
    // The value ends up in a URL the worker navigates to, so anything that
    // isn't plainly http(s) is refused rather than silently stored.
    setStatus('That needs to be a full http:// or https:// address.', 'error');
    return;
  }
  await chrome.storage.sync.set({ server: normalized });
  serverInput.value = normalized;
  setStatus(`Saved — videos will open at ${normalized}`, 'ok');
}

async function reset() {
  await chrome.storage.sync.set({ server: ECHO_DEFAULT_SERVER });
  serverInput.value = ECHO_DEFAULT_SERVER;
  setStatus(`Reset to ${ECHO_DEFAULT_SERVER}`, 'ok');
}

document.getElementById('save').addEventListener('click', save);
document.getElementById('reset').addEventListener('click', reset);
serverInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });

load();
