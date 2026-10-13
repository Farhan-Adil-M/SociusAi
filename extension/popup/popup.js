/* Popup logic for the Socius AI Study Highlighter toolbar popup.
   Settings live in chrome.storage.sync; the health check talks to the
   backend's /api/health endpoint. No inline handlers, vanilla JS only. */

'use strict';

const DEFAULTS = {
  enabled: true,
  siteUrl: 'http://localhost:3000',
  apiUrl: 'http://localhost:3000'
};

const HEALTH_TIMEOUT_MS = 4000;

const els = {};

/* ---------- storage helpers ---------- */

function storageGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.sync.get(keys, (items) => {
      if (chrome.runtime.lastError) {
        console.error('Could not read settings:', chrome.runtime.lastError.message);
        resolve({});
        return;
      }
      resolve(items || {});
    });
  });
}

function storageSet(items) {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.set(items, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

async function loadSettings() {
  const stored = await storageGet(DEFAULTS);
  return {
    enabled: typeof stored.enabled === 'boolean' ? stored.enabled : DEFAULTS.enabled,
    siteUrl: typeof stored.siteUrl === 'string' ? stored.siteUrl : DEFAULTS.siteUrl,
    apiUrl: typeof stored.apiUrl === 'string' ? stored.apiUrl : DEFAULTS.apiUrl
  };
}

/* ---------- elements ---------- */

function cacheElements() {
  els.toggle = document.getElementById('enabled-toggle');
  els.form = document.getElementById('settings-form');
  els.siteInput = document.getElementById('site-url');
  els.siteError = document.getElementById('site-url-error');
  els.apiInput = document.getElementById('api-url');
  els.apiError = document.getElementById('api-url-error');
  els.savedBadge = document.getElementById('saved-badge');
  els.saveError = document.getElementById('save-error');
  els.statusSpinner = document.getElementById('status-spinner');
  els.statusDot = document.getElementById('status-dot');
  els.statusText = document.getElementById('status-text');
  els.openBtn = document.getElementById('open-app-btn');
}

/* ---------- settings form ---------- */

function isValidUrl(value) {
  return value.startsWith('http://') || value.startsWith('https://');
}

function validateField(input, errorEl) {
  const valid = isValidUrl(input.value.trim());
  if (valid) {
    errorEl.hidden = true;
    input.removeAttribute('aria-invalid');
  } else {
    errorEl.hidden = false;
    input.setAttribute('aria-invalid', 'true');
  }
  return valid;
}

function clearSaveFeedback() {
  els.savedBadge.hidden = true;
  els.saveError.hidden = true;
  els.saveError.textContent = 'Could not save settings.';
}

/* Host permission for an API URL origin, requested only when it is not
   already covered by the manifest's host_permissions. Requires a user
   gesture (the Save click) so chrome.permissions.request may prompt. */
function toOriginPattern(url) {
  try {
    return new URL(url).origin + '/*';
  } catch (err) {
    return null;
  }
}

function requestOriginAccess(pattern) {
  return new Promise((resolve) => {
    chrome.permissions.contains({ origins: [pattern] }, (has) => {
      if (chrome.runtime.lastError) {
        resolve(false);
        return;
      }
      if (has) {
        resolve(true);
        return;
      }
      chrome.permissions.request({ origins: [pattern] }, (granted) => {
        resolve(!!granted && !chrome.runtime.lastError);
      });
    });
  });
}

async function handleSave(event) {
  event.preventDefault();
  clearSaveFeedback();

  const siteOk = validateField(els.siteInput, els.siteError);
  const apiOk = validateField(els.apiInput, els.apiError);
  if (!siteOk || !apiOk) return;

  const apiOrigin = toOriginPattern(els.apiInput.value.trim());
  if (!apiOrigin) {
    els.apiError.hidden = false;
    els.apiInput.setAttribute('aria-invalid', 'true');
    return;
  }
  if (!(await requestOriginAccess(apiOrigin))) {
    els.saveError.textContent =
      'Permission to reach that API URL was denied, so the setting was not saved.';
    els.saveError.hidden = false;
    return;
  }

  try {
    await storageSet({
      siteUrl: els.siteInput.value.trim(),
      apiUrl: els.apiInput.value.trim()
    });
    els.savedBadge.hidden = false;
  } catch (err) {
    console.error('Could not save settings:', err.message);
    els.saveError.hidden = false;
  }
}

async function handleToggleChange() {
  clearSaveFeedback();
  try {
    await storageSet({ enabled: els.toggle.checked });
  } catch (err) {
    console.error('Could not save setting:', err.message);
    els.saveError.hidden = false;
  }
}

/* ---------- connection status ---------- */

function setStatus(state) {
  if (state === 'checking') {
    els.statusSpinner.hidden = false;
    els.statusDot.hidden = true;
    els.statusDot.className = 'status-dot';
    els.statusText.textContent = 'Checking connection\u2026';
    return;
  }

  els.statusSpinner.hidden = true;
  els.statusDot.hidden = false;

  if (state === 'connected') {
    els.statusDot.className = 'status-dot';
    els.statusText.textContent = 'Connected';
  } else if (state === 'degraded') {
    els.statusDot.className = 'status-dot is-warn';
    els.statusText.textContent = 'Degraded';
  } else {
    els.statusDot.className = 'status-dot is-down';
    els.statusText.textContent = 'Server unreachable';
  }
}

async function checkConnection(apiUrl) {
  setStatus('checking');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  const healthUrl = apiUrl.replace(/\/+$/, '') + '/api/health';

  try {
    const response = await fetch(healthUrl, { signal: controller.signal });
    if (!response.ok) {
      setStatus('degraded');
      return;
    }
    const body = await response.json().catch(() => null);
    setStatus(body && body.status === 'ok' ? 'connected' : 'degraded');
  } catch (err) {
    setStatus('unreachable');
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- open app ---------- */

async function handleOpenApp() {
  const settings = await loadSettings();
  chrome.tabs.create({ url: settings.siteUrl });
  window.close();
}

/* ---------- init ---------- */

async function init() {
  cacheElements();

  els.toggle.addEventListener('change', handleToggleChange);
  els.form.addEventListener('submit', handleSave);
  els.openBtn.addEventListener('click', handleOpenApp);

  const clearFeedbackFor = (input, errorEl) => () => {
    errorEl.hidden = true;
    input.removeAttribute('aria-invalid');
    clearSaveFeedback();
  };
  els.siteInput.addEventListener('input', clearFeedbackFor(els.siteInput, els.siteError));
  els.apiInput.addEventListener('input', clearFeedbackFor(els.apiInput, els.apiError));

  const settings = await loadSettings();
  els.toggle.checked = settings.enabled;
  els.siteInput.value = settings.siteUrl;
  els.apiInput.value = settings.apiUrl;

  checkConnection(settings.apiUrl);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
