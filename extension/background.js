// background.js — MV3 service worker for the Study Highlighter extension.
//
// Relays content-script and popup requests to the Socius AI backend. The
// backend holds the API keys; nothing secret lives here. Every response uses
// one envelope: { ok: true, ... } on success, or
// { ok: false, error: { code, message } } on failure. Stack traces and
// internal details are never forwarded.

const DEFAULT_SETTINGS = {
  enabled: true,
  apiUrl: 'http://localhost:3000',
  siteUrl: 'http://localhost:3000',
};

const TIMEOUT_MS = 15000;

function networkError() {
  return {
    ok: false,
    error: { code: 'NETWORK_ERROR', message: 'Could not reach the Socius AI server.' },
  };
}

function validationError(message) {
  return { ok: false, error: { code: 'VALIDATION_ERROR', message } };
}

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return {
    enabled: stored.enabled ?? DEFAULT_SETTINGS.enabled,
    apiUrl: stored.apiUrl ?? DEFAULT_SETTINGS.apiUrl,
    siteUrl: stored.siteUrl ?? DEFAULT_SETTINGS.siteUrl,
  };
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

// POST JSON to the backend. Never throws; failures come back in the envelope.
async function postJson(apiUrl, path, body) {
  let res;
  try {
    res = await fetch(apiUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return networkError();
  }

  if (!res.ok) {
    let code = 'HTTP_' + res.status;
    let message = 'Server error.';
    try {
      const parsed = await res.json();
      if (parsed && typeof parsed === 'object' && parsed.error) {
        code = parsed.error.code || code;
        message = parsed.error.message || message;
      }
    } catch {
      // Body was not JSON; keep the defaults.
    }
    return { ok: false, error: { code, message } };
  }

  try {
    return { ok: true, data: await res.json() };
  } catch {
    return { ok: false, error: { code: 'BAD_RESPONSE', message: 'Server error.' } };
  }
}

async function handleRelevance(message) {
  if (!Array.isArray(message.blocks)) {
    return validationError('Expected an array of blocks.');
  }
  const { apiUrl } = await getSettings();
  if (!isHttpUrl(apiUrl)) {
    return validationError('The Socius AI server URL is not a valid http(s) address.');
  }
  const result = await postJson(apiUrl, '/api/extension/relevance', { blocks: message.blocks });
  if (!result.ok) return result;
  return {
    ok: true,
    matches: result.data ? result.data.matches : undefined,
    minScore: result.data ? result.data.minScore : undefined,
  };
}

async function handleBriefing(message) {
  if (typeof message.text !== 'string' || message.text.length === 0) {
    return validationError('Expected a non-empty text string.');
  }
  const { apiUrl } = await getSettings();
  if (!isHttpUrl(apiUrl)) {
    return validationError('The Socius AI server URL is not a valid http(s) address.');
  }
  const body = { text: message.text };
  if (message.sourceIds !== undefined) body.sourceIds = message.sourceIds;
  const result = await postJson(apiUrl, '/api/extension/briefing', body);
  if (!result.ok) return result;
  const data = result.data || {};
  return {
    ok: true,
    answer: data.answer,
    citations: data.citations,
    needsContent: data.needsContent,
    model: data.model,
  };
}

async function handleOpenSite() {
  const { siteUrl } = await getSettings();
  if (!isHttpUrl(siteUrl)) {
    return validationError('The Socius AI site URL is not a valid http(s) address.');
  }
  await chrome.tabs.create({ url: siteUrl });
  return { ok: true };
}

async function handleGetState() {
  const { enabled, apiUrl, siteUrl } = await getSettings();
  return { ok: true, enabled, apiUrl, siteUrl };
}

async function handleMessage(message) {
  switch (message && message.type) {
    case 'relevance':
      return handleRelevance(message);
    case 'briefing':
      return handleBriefing(message);
    case 'openSite':
      return handleOpenSite();
    case 'getState':
      return handleGetState();
    default:
      return {
        ok: false,
        error: { code: 'UNKNOWN_MESSAGE', message: 'Unknown message type.' },
      };
  }
}

// Top-level, synchronous listener. Returns literal true so Chrome keeps the
// message channel open while the async handler answers via sendResponse.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch(() => sendResponse(networkError()));
  return true;
});
