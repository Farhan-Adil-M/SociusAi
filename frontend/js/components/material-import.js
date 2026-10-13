// components/material-import.js — import a PDF/PowerPoint file or paste a web
// page, then offer the backend's AI organisation suggestion for it.
//
// Responsibility: perform the import FIRST (upload/webpage endpoints), render
// status messages, then call POST /api/sources/:id/suggest-organization and
// render the suggestion card: accept it, choose a different session manually,
// or dismiss (leave in Unsorted). All classification happens on the backend —
// this file never talks to NVIDIA NIM, and a failed suggestion never undoes
// the upload.

import { api } from '../api.js';
import { icon, escapeHtml, errorMessage } from '../ui.js';

/* ------------------------------------------------------------- status --- */

function renderNotice(host, kind, html) {
  host.innerHTML = `<div class="banner banner-${kind}" style="margin-top: var(--s3);">${html}</div>`;
}

/* -------------------------------------------------------- import panel --- */

/**
 * Render the import panel (file upload + web page paste) into `host`.
 * @param {Object}   opts
 * @param {HTMLElement} opts.host         where the panel is drawn
 * @param {string|null} opts.sessionId    session to file under (null = Unsorted)
 * @param {Function}   opts.onOrganised   called with the source after any placement change
 */
export function mountImportPanel({ host, sessionId = null, onOrganised = () => {} }) {
  host.innerHTML = `
    <div class="imp-block">
      <label class="field-label" for="imp-file">Upload a PDF or PowerPoint</label>
      <input class="input" id="imp-file" type="file" accept=".pdf,.pptx,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation">
      <p class="field-hint">Text-based files only, up to 25 MB.</p>
    </div>
    <hr class="hairline">
    <form class="imp-block stack stack-2" data-imp-webpage novalidate>
      <label class="field-label" for="imp-url">Or paste a web page</label>
      <input class="input" id="imp-url" type="url" placeholder="https://example.org/lesson" required>
      <label class="field-label" for="imp-text">Page text</label>
      <textarea class="textarea" id="imp-text" placeholder="Paste the page text here (at least 50 characters)" required></textarea>
      <button class="btn btn-secondary btn-sm" type="submit">Add web page</button>
    </form>
    <div data-imp-status aria-live="polite"></div>`;

  const statusHost = host.querySelector('[data-imp-status]');
  const fileInput = host.querySelector('#imp-file');
  const form = host.querySelector('[data-imp-webpage]');

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    if (!/\.(pdf|pptx)$/i.test(file.name)) {
      renderNotice(statusHost, 'error', escapeHtml('Unsupported file — use a .pdf or .pptx.'));
      fileInput.value = '';
      return;
    }
    statusHost.innerHTML = `<div class="study-add-status"><span class="spinner" aria-hidden="true"></span> Extracting and indexing ${escapeHtml(file.name)}…</div>`;
    fileInput.value = '';
    try {
      const data = await api.uploadSource(file);
      // Upload succeeded — everything below is organisation, never blocking.
      await offerSuggestion(data.source, { host: statusHost, onOrganised });
    } catch (error) {
      renderNotice(statusHost, 'error', `<strong>Upload failed.</strong> ${escapeHtml(errorMessage(error))}`);
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const url = host.querySelector('#imp-url').value.trim();
    const text = host.querySelector('#imp-text').value.trim();

    if (!/^https?:\/\/\S+\.\S+/.test(url)) {
      renderNotice(statusHost, 'error', escapeHtml('Enter a full web address, starting with http:// or https://.'));
      return;
    }
    if (text.length < 50) {
      renderNotice(statusHost, 'error', escapeHtml(`Paste at least 50 characters of page text (currently ${text.length}).`));
      return;
    }
    if (text.length > 200000) {
      renderNotice(statusHost, 'error', escapeHtml('That text is too long — 200,000 characters maximum.'));
      return;
    }
    statusHost.innerHTML = `<div class="study-add-status"><span class="spinner" aria-hidden="true"></span> Indexing the page…</div>`;
    try {
      const data = await api.addWebpage({ url, text });
      form.reset();
      await offerSuggestion(data.source, { host: statusHost, onOrganised });
    } catch (error) {
      renderNotice(statusHost, 'error', `<strong>Import failed.</strong> ${escapeHtml(errorMessage(error))}`);
    }
  });
}

/* -------------------------------------------------------- suggestion --- */

/** Active session titles, used for the suggestion text and the move dropdown. */
async function loadSessionTitles() {
  try {
    const data = await api.listSessions();
    return data.sessions || [];
  } catch {
    return [];
  }
}

/**
 * Ask the backend for an organisation suggestion for a freshly imported
 * source and render it as a recommendation the student can accept, override
 * or dismiss. A failed suggestion never blocks: the upload already happened.
 */
export async function offerSuggestion(source, { host, onOrganised = () => {} }) {
  const sourceId = typeof source === 'string' ? source : source.id;
  const sourceTitle = typeof source === 'string' ? '' : (source.title || '');

  let data;
  try {
    data = await api.suggestOrganization(sourceId);
  } catch (error) {
    if (error.code === 'NIM_ERROR' || error.code === 'NIM_TIMEOUT') {
      renderNotice(host, 'info',
        `<strong>Added ${escapeHtml(sourceTitle)}.</strong> Left in Unsorted — the organiser is unavailable right now. You can file it manually any time.`);
      return;
    }
    renderNotice(host, 'info',
      `<strong>Added ${escapeHtml(sourceTitle)}.</strong> The organisation check failed (${escapeHtml(errorMessage(error))}). It is in Unsorted.`);
    return;
  }

  const sessions = await loadSessionTitles();
  renderSuggestion(host, { sourceId, sourceTitle, data, sessions, onOrganised });
}

function moveOptions(sessions) {
  return sessions
    .map((session) => `<option value="${escapeHtml(session.id)}">${escapeHtml(session.title)}</option>`)
    .join('');
}

function renderSuggestion(host, { sourceId, sourceTitle, data, sessions, onOrganised }) {
  const { applicable, suggestion } = data;
  if (!suggestion) {
    renderNotice(host, 'info', `<strong>Added ${escapeHtml(sourceTitle)}.</strong> Left in Unsorted — organise it manually below or from the Library.`);
    return;
  }

  const target = suggestion.matchSessionId
    ? (sessions.find((session) => session.id === suggestion.matchSessionId) || {}).title || 'a session you have'
    : null;
  const proposal = target
    ? `Suggested session: <strong>${escapeHtml(target)}</strong>`
    : `New session: <strong>${escapeHtml(suggestion.newSession.title)}</strong> · ${escapeHtml(suggestion.newSession.category)}`;
  const acceptLabel = target ? `Move to «${escapeHtml(target)}»` : `Create «${escapeHtml(suggestion.newSession.title)}»`;
  const confidence = suggestion.confidence === 'high'
    ? '<span class="badge badge-blue">High confidence</span>'
    : '<span class="badge badge-amber">Low confidence</span>';
  const manualNote = applicable === false
    ? '<p class="sug-note">You organise this file manually, so the suggestion is shown for reference only.</p>'
    : '';

  host.innerHTML = `
    <div class="sug-card">
      <div class="sug-head">
        <span class="sug-icon">${icon('spark', { size: 15 })}</span>
        <div class="stack stack-1">
          <p class="sug-title">Added ${escapeHtml(sourceTitle)} — file it?</p>
          <p class="sug-meta">${confidence} <span>${escapeHtml(suggestion.reason)}</span></p>
        </div>
      </div>
      <p class="sug-proposal">${proposal}</p>
      ${manualNote}
      <div class="sug-actions">
        ${applicable === false ? '' : `<button type="button" class="btn btn-primary btn-sm" data-sug-accept>${acceptLabel}</button>`}
        <span class="sug-move">
          <label class="sr-only" for="sug-session">Choose a different session</label>
          <select class="select" id="sug-session"><option value="">Choose another session…</option>${moveOptions(sessions)}</select>
          <button type="button" class="btn btn-secondary btn-sm" data-sug-move>Move</button>
        </span>
        <button type="button" class="btn btn-quiet btn-sm" data-sug-dismiss>Keep in Unsorted</button>
      </div>
    </div>`;

  wireSuggestionCard(host, { sourceId, sourceTitle, suggestion, sessions, onOrganised });
}

function wireSuggestionCard(host, { sourceId, sourceTitle, suggestion, sessions, onOrganised }) {
  const card = host.querySelector('.sug-card');
  if (!card) return;

  const finish = (promise, doneText) => {
    promise.then(
      (data) => {
        renderNotice(host, 'info', `<strong>${escapeHtml(doneText)}</strong> You can move it again any time from the Library.`);
        onOrganised(data.source || { id: sourceId });
      },
      (error) => renderNotice(host, 'error', `<strong>Could not file ${escapeHtml(sourceTitle)}.</strong> ${escapeHtml(errorMessage(error))}`),
    );
  };

  card.querySelector('[data-sug-accept]')?.addEventListener('click', (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.innerHTML = '<span class="spinner" aria-hidden="true"></span> Filing…';
    finish(api.acceptSuggestion(sourceId).then((data) => ({ source: data.source })),
      suggestion.newSession ? `Created and filed under «${suggestion.newSession.title}».` : 'Filed under the suggested session.');
  });

  card.querySelector('[data-sug-move]')?.addEventListener('click', () => {
    const select = card.querySelector('#sug-session');
    const sessionId = select.value;
    if (!sessionId) { select.focus(); return; }
    const title = (sessions.find((session) => session.id === sessionId) || {}).title || 'that session';
    finish(api.updateSource(sourceId, { sessionId }), `Moved to «${title}».`);
  });

  card.querySelector('[data-sug-dismiss]')?.addEventListener('click', () => {
    renderNotice(host, 'info', `<strong>Kept in Unsorted.</strong> ${escapeHtml(sourceTitle)} stays unfiled until you move it.`);
  });
}
