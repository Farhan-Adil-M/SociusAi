// Study page: material selector + tutor conversation.
// Sources are loaded once, the scope is translated into the contract's
// `sourceIds` filter, and each question is rendered as an exchange block with
// its citations. Loading, empty and error states are all handled per block.

import { mountShell, mountHealthBanner } from '../components/shell.js';
import {
  offerSuggestion, checkUploadFile, checkWebpageInput, findDuplicateSource,
  showDuplicateHint, setUploadLimitHint,
} from '../components/material-import.js';
import { api } from '../api.js';
import {
  icon, escapeHtml, renderCitations, wireCitations,
  showEmpty, showError, errorMessage,
} from '../ui.js';

mountShell('study');
mountHealthBanner(document.querySelector('[data-health]'));

const transcript = document.querySelector('[data-transcript]');
const composer = document.querySelector('[data-composer]');
const input = document.querySelector('#question');
const sendButton = document.querySelector('[data-send]');
const sendLabel = document.querySelector('[data-send-label]');
const countLabel = document.querySelector('[data-count]');
const liveRegion = document.querySelector('[data-live]');
const sourcesHost = document.querySelector('[data-sources]');

wireCitations(transcript);

/* Upload cap honesty: the hint is filled with the backend's real
   MAX_UPLOAD_MB in material-import.js' setUploadLimitHint — it comes inside
   the health payload (checks.limits.maxUploadMb). getHealth() is cached by
   shell.js for the banner and status pill, so this adds no extra network
   call. Before it resolves the hint has no number. */
setUploadLimitHint(document.querySelector('[data-upload-hint]'));

/* The two repeated onboarding notes share one copy each (3 call sites) —
   they contain a Profile link, so they are HTML strings, not plain text. */
const ONBOARD_DONE_NOTE = 'Setup already finished. Manage it on the <a href="profile.html">Profile</a> page.';
const ONBOARD_ACTIVE_NOTE = 'Teaching you your way — tweak it in the <a href="profile.html">Profile</a> page.';

let sources = [];
let sending = false;

/* ------------------------------------------------------------ suggestions */

const params = new URLSearchParams(window.location.search);
const presetTopic = (params.get('topic') || '').trim();

/* Session scope: ?session=ses_… — the tutor then only searches that
   session's material (the backend enforces it; we pass the id through). */
const presetSessionId = (params.get('session') || '').trim();
let sessionContext = null; // { id, title, … } once loaded

async function loadSessionContext() {
  if (!presetSessionId) return;
  try {
    const data = await api.getSession(presetSessionId);
    sessionContext = data.session;
  } catch {
    sessionContext = null; // fall back to all material; ask() surfaces errors
  }
}

function suggestions() {
  const list = [
    'Summarise the key ideas in my material',
    'What should I revise first?',
  ];
  if (presetTopic) list.unshift(`What should I know about ${presetTopic}?`);
  else if (sources[0]) list.unshift(`Explain the main idea in ${sources[0].title}`);
  return list.slice(0, 3);
}

/* ------------------------------------------------------------ source scope */

function selectedSourceIds() {
  const all = sourcesHost.querySelector('[data-all]');
  if (!all || all.checked) return [];
  return [...sourcesHost.querySelectorAll('[data-source]:checked')].map((box) => box.value);
}

function renderSources() {
  if (sources.length === 0) {
    showEmpty(sourcesHost, {
      iconName: 'inbox',
      title: sessionContext ? `«${sessionContext.title}» has no material yet` : 'No material yet',
      text: sessionContext
        ? 'Add a PDF, PowerPoint or web page below, or from the session page. The tutor searches this session only.'
        : 'Upload a PDF or PowerPoint, or paste a web page, to give the tutor something to search.',
    });
    return;
  }

  const rows = sources.map((source) => `
    <label class="src-option">
      <input type="checkbox" data-source value="${escapeHtml(source.id)}" disabled>
      <span class="src-body">
        <span class="src-title">${escapeHtml(source.title)}</span>
        <span class="src-meta">${escapeHtml(source.sizeLabel || '')} · ${escapeHtml(source.chunkCount ? `${source.chunkCount} passages` : '')}</span>
      </span>
    </label>`);

  sourcesHost.innerHTML = `
    <label class="src-option">
      <input type="checkbox" data-all checked>
      <span class="src-body">
        <span class="src-title src-all">${sessionContext ? 'All material in this session' : 'All material'}</span>
        <span class="src-meta">${sessionContext ? `Everything filed under «${escapeHtml(sessionContext.title)}»` : 'Search everything you have added'}</span>
      </span>
    </label>
    ${rows.join('')}`;
}

function onScopeChange(event) {
  const all = sourcesHost.querySelector('[data-all]');
  const specific = [...sourcesHost.querySelectorAll('[data-source]')];

  if (event.target.matches('[data-all]')) {
    if (all.checked) specific.forEach((box) => { box.checked = false; box.disabled = true; });
    else {
      specific.forEach((box) => { box.disabled = false; });
      if (specific[0]) specific[0].checked = true;
    }
    return;
  }

  if (event.target.matches('[data-source]')) {
    all.checked = false;
    specific.forEach((box) => { box.disabled = false; });
    if (specific.every((box) => !box.checked)) all.checked = true;
  }
}

async function loadSources() {
  try {
    const data = await api.listSources(sessionContext ? { sessionId: sessionContext.id } : {});
    sources = data.sources || [];
    renderSources();
    renderIntro();
    updateComposer();
  } catch (error) {
    showError(sourcesHost, error, { title: 'Could not load your material', onRetry: loadSources });
  }
}

/* ------------------------------------------------------------- transcript */

function renderIntro() {
  const options = suggestions()
    .map((text) => `<button type="button" data-suggest="${escapeHtml(text)}">${icon('spark', { size: 14 })} ${escapeHtml(text)}</button>`)
    .join('');

  transcript.innerHTML = `
    <div class="study-intro">
      <h3>Study session</h3>
      ${
        sources.length === 0
          ? '<p>The tutor answers only from material you have added. Use <strong>Add material</strong> on the left, then ask your first question here.</p>'
          : sessionContext
            ? `<p>You are searching <strong>${sources.length === 1 ? '1 item' : `${sources.length} items`}</strong> in <a href="session.html?id=${encodeURIComponent(sessionContext.id)}">«${escapeHtml(sessionContext.title)}»</a>. Answers cite the exact file, page or slide so you can verify them.</p>`
            : `<p>You are searching <strong>${sources.length === 1 ? '1 item' : `${sources.length} items`}</strong>. Answers are written from the retrieved passages, and each one cites the exact file, page or slide so you can verify it.</p>`
      }
      <div class="study-suggest">${options}</div>
    </div>`;
}

transcript.addEventListener('click', (event) => {
  const button = event.target.closest('[data-suggest]');
  if (!button) return;
  input.value = button.dataset.suggest;
  input.dispatchEvent(new Event('input'));
  input.focus();
});

function scrollToEnd() {
  transcript.scrollTop = transcript.scrollHeight;
}

function append(html) {
  const holder = document.createElement('div');
  holder.innerHTML = html.trim();
  const node = holder.firstElementChild;
  transcript.appendChild(node);
  scrollToEnd();
  return node;
}

let answerCount = 0; // keeps citation detail-panel ids unique per answer block

// The style chips shown under every answer send the same question again as a
// NEW exchange with that one-off approach (v1.4 `approach` enum).
const STYLE_CHIPS = ['step-by-step', 'examples-first', 'concise'];

function styleRowHtml(uid) {
  const chips = STYLE_CHIPS.map((approach) => `
    <button type="button" class="exchange-style-chip" data-style-chip data-approach="${approach}">${approach}</button>`).join('');

  return `
    <div class="exchange-style">
      <button type="button" class="exchange-style-btn" data-explain
              title="Ask the tutor again to explain this a different way">
        ${icon('refresh', { size: 12 })} Explain differently
      </button>
      <button type="button" class="exchange-style-btn" data-style-toggle
              aria-expanded="false" aria-controls="style-${uid}"
              title="Ask again with a specific teaching style">
        ${icon('spark', { size: 12 })} Style ${icon('chevronDown', { size: 10 })}
      </button>
      <span class="exchange-style-chips" id="style-${uid}" hidden>${chips}</span>
    </div>`;
}

function answerHtml(data, question = '') {
  answerCount += 1;
  const paragraphs = String(data.answer || '')
    .split(/\n+/)
    .filter(Boolean)
    .map((text) => `<p>${escapeHtml(text)}</p>`)
    .join('');

  const abstain = data.needsContent
    ? `<div class="banner banner-info" style="margin-bottom: var(--s3);">${icon('info', { size: 16 })}
        <span><strong>Nothing relevant found.</strong> The tutor would not guess. Add material on this topic, or ask about something your files cover.</span>
      </div>`
    : '';

  const citations = Array.isArray(data.citations) && data.citations.length > 0
    ? `<div class="exchange-citations">
         <p class="exchange-citations-label">Source passages — select one to read the excerpt</p>
         ${renderCitations(data.citations, `a${answerCount}`)}
       </div>`
    : (data.needsContent ? '' : '<p class="exchange-citations-label" style="margin-top: var(--s3);">No passages were retrieved for this answer.</p>');

  // approachUsed only appears when personalisation was active (see contract v1.4)
  const approachUsed = data.approachUsed
    ? `<p class="exchange-approach">Approach: ${escapeHtml(data.approachUsed)}</p>`
    : '';

  return `
    <article class="exchange exchange--answer" data-q="${escapeHtml(question)}">
      <p class="exchange-who">Tutor</p>
      <div class="exchange-a-body">${paragraphs}</div>
      ${abstain}
      ${citations}
      ${approachUsed}
      ${styleRowHtml(`a${answerCount}`)}
    </article>`;
}

/* ---------------------------------------------------------------- asking */

function updateComposer() {
  const length = input.value.trim().length;
  countLabel.textContent = `${input.value.length} / 300`;
  const waitingForMaterial = Boolean(sessionContext) && sources.length === 0;
  sendButton.disabled = sending || length < 3 || waitingForMaterial;
  input.placeholder = waitingForMaterial
    ? `Add material to «${sessionContext.title}» first…`
    : 'Ask a question about your material…';
}

function setSending(value) {
  sending = value;
  sendLabel.textContent = value ? 'Thinking…' : 'Send';
  sendButton.disabled = value || input.value.trim().length < 3;
}

/** `approach` (optional) is a one-off style request for THIS answer only. */
async function ask(question, { approach } = {}) {
  const asked = question.trim();
  // Small chip naming the requested style, so the compared answers are labelled.
  const styleChip = approach
    ? ` <span class="q-approach-chip">(as: ${escapeHtml(approach)})</span>`
    : '';

  const questionBlock = append(`
    <article class="exchange exchange--question">
      <p class="exchange-who">You</p>
      <p>${escapeHtml(asked)}${styleChip}</p>
    </article>`);

  const pending = append(`
    <div class="exchange-pending" data-pending>
      <span class="spinner" aria-hidden="true"></span>
      <span>Searching your material…</span>
    </div>`);

  setSending(true);
  input.value = '';
  updateComposer();

  try {
    const data = await api.askTutor({
      question: asked,
      sourceIds: selectedSourceIds(),
      sessionId: sessionContext ? sessionContext.id : null,
      approach,
    });
    pending.outerHTML = answerHtml(data, asked);
    liveRegion.textContent = 'The tutor answered.';
  } catch (error) {
    if (error.code === 'SESSION_EMPTY') {
      pending.outerHTML = `
        <div class="study-add-status" style="display:block; padding:0; background:none;">
          <div class="banner banner-info">${icon('info', { size: 16 })}
            <span><strong>Nothing to search yet.</strong> ${escapeHtml(sessionContext ? `«${sessionContext.title}»` : 'This session')} has no material. Add a file or web page first — then questions here are answered from it.</span>
          </div>
          <div style="margin-top: var(--s3);">
            <a class="btn btn-primary btn-sm" href="session.html?id=${encodeURIComponent(presetSessionId)}">Add material</a>
          </div>
        </div>`;
      liveRegion.textContent = 'This session has no material yet.';
      setSending(false);
      return;
    }
    const message = errorMessage(error);
    // Failed style sends are retried WITH their approach (data-retry-approach);
    // plain question retries stay unchanged.
    const approachAttr = approach ? ` data-retry-approach="${escapeHtml(approach)}"` : '';
    pending.outerHTML = `
      <div class="exchange-pending" style="display:block; padding:0; background: none;">
        <div class="banner banner-error">${icon('alert', { size: 16 })}
          <span><strong>The tutor could not answer.</strong> ${escapeHtml(message)}</span>
        </div>
        <div style="margin-top: var(--s3);">
          <button type="button" class="btn btn-secondary btn-sm" data-retry="${escapeHtml(asked)}"${approachAttr}>Ask again</button>
        </div>
      </div>`;
    liveRegion.textContent = `Error: ${message}`;
  } finally {
    setSending(false);
    transcript.scrollTop = Math.max(0, questionBlock.offsetTop - 12);
  }
}

transcript.addEventListener('click', (event) => {
  const retry = event.target.closest('[data-retry]');
  if (!retry) return;
  const question = retry.dataset.retry;
  const approach = retry.dataset.retryApproach || undefined;
  retry.closest('.exchange-pending')?.remove();
  ask(question, { approach });
});

/* Style row under each answer: "Explain differently" plus the Style chips.
   Every action re-asks the SAME question as a NEW exchange — older answers
   stay above for comparison. Inert while an answer is being sent. */
transcript.addEventListener('click', (event) => {
  if (sending) return;

  const explain = event.target.closest('[data-explain]');
  if (explain) {
    const exchange = explain.closest('.exchange');
    if (exchange && exchange.dataset.q) ask(exchange.dataset.q, { approach: 'different' });
    return;
  }

  const chip = event.target.closest('[data-style-chip]');
  if (chip) {
    const exchange = chip.closest('.exchange');
    if (exchange && exchange.dataset.q) ask(exchange.dataset.q, { approach: chip.dataset.approach });
    return;
  }

  const toggle = event.target.closest('[data-style-toggle]');
  if (toggle) {
    const chips = document.getElementById(toggle.getAttribute('aria-controls'));
    if (!chips) return;
    chips.hidden = !chips.hidden;
    toggle.setAttribute('aria-expanded', String(!chips.hidden));
  }
});

composer.addEventListener('submit', (event) => {
  event.preventDefault();
  const question = input.value.trim();
  if (question.length < 3 || question.length > 300 || sending) return;
  ask(question);
});

input.addEventListener('input', updateComposer);
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

/* --------------------------------------------------------- add material */

const addToggle = document.querySelector('[data-add-toggle]');
const addPanel = document.querySelector('#add-panel');
const addStatus = document.querySelector('[data-add-status]');
const fileInput = document.querySelector('#file-input');
const webpageForm = document.querySelector('[data-webpage-form]');

addToggle.addEventListener('click', () => {
  const open = addPanel.hidden;
  addPanel.hidden = !open;
  addToggle.setAttribute('aria-expanded', String(open));
  addToggle.textContent = open ? 'Hide material tools' : 'Add material';
});

function showAddStatus(kind, message) {
  addStatus.innerHTML = `<div class="banner banner-${kind}" style="font-size: var(--fs-xs); padding: var(--s2) var(--s3);">${escapeHtml(message)}</div>`;
}

/* Informational "you already added this" hint, shared with the session page's
   import panel (single copy of the renderer in material-import.js). It is
   exact-match only and NEVER blocks: two versions of the same notes must
   still both import. */
const dupHost = document.createElement('div');
dupHost.setAttribute('data-dup-hint', '');
dupHost.setAttribute('aria-live', 'polite');
addStatus.insertAdjacentElement('beforebegin', dupHost);

fileInput.addEventListener('change', async () => {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;
  const problem = checkUploadFile(file);
  if (problem) { showAddStatus('error', problem); fileInput.value = ''; return; }
  showDuplicateHint(dupHost, findDuplicateSource(sources, { fileName: file.name }));
  addStatus.innerHTML = `<div class="study-add-status"><span class="spinner" aria-hidden="true"></span> Extracting and indexing ${escapeHtml(file.name)}…</div>`;
  try {
    const data = await api.uploadSource(file);
    fileInput.value = '';
    showDuplicateHint(dupHost, null);
    await afterImport(data.source);
  } catch (error) {
    showAddStatus('error', errorMessage(error));
    fileInput.value = '';
  }
});

/**
 * The upload already succeeded, so organisation is never blocking:
 * in a session, file it there; otherwise offer the AI suggestion.
 */
async function afterImport(source) {
  if (sessionContext) {
    try {
      await api.updateSource(source.id, { sessionId: sessionContext.id });
      showAddStatus('info', `Added ${source.title} to «${sessionContext.title}».`);
    } catch (error) {
      showAddStatus('error', `Added ${source.title}, but filing it into this session failed: ${errorMessage(error)}`);
    }
  } else {
    await offerSuggestion(source, { host: addStatus, onOrganised: loadSources });
  }
  await loadSources();
}

webpageForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const url = document.querySelector('#webpage-url').value.trim();
  const text = document.querySelector('#webpage-text').value.trim();

  const problem = checkWebpageInput(url, text);
  if (problem) { showAddStatus('error', problem); return; }
  showDuplicateHint(dupHost, findDuplicateSource(sources, { url }));

  addStatus.innerHTML = `<div class="study-add-status"><span class="spinner" aria-hidden="true"></span> Indexing the page…</div>`;
  try {
    const data = await api.addWebpage({ url, text });
    webpageForm.reset();
    showDuplicateHint(dupHost, null);
    await afterImport(data.source);
  } catch (error) {
    showAddStatus('error', errorMessage(error));
  }
});

/* ------------------------------------------------------ onboarding (v1.4) */

const onboardPanel = document.getElementById('onboarding-panel');

let offerDismissed = false; // "Not now" → offer stays gone for THIS page load only
let onboardOpen = false;
let onboardDone = false;
let onboardSending = false;
let onboardLastSent; // undefined = opening turn not sent yet; null = opening turn; string = last user reply
let profileState = 'new';

const onboardChat = () => onboardPanel.querySelector('[data-onboard-chat]');

function setOnboardBusy(value) {
  onboardSending = value;
  const input = onboardPanel.querySelector('[data-onboard-input]');
  const send = onboardPanel.querySelector('[data-onboard-send]');
  const skip = onboardPanel.querySelector('[data-onboard-skip]');
  if (input) input.disabled = value || onboardDone;
  if (send) send.disabled = value || onboardDone || !(input && input.value.trim());
  if (skip) skip.disabled = value;
}

function onboardScroll() {
  const chat = onboardChat();
  if (chat) chat.scrollTop = chat.scrollHeight;
}

function onboardBubble(kind, text) {
  const chat = onboardChat();
  if (!text || !chat) return;
  const holder = document.createElement('div');
  holder.innerHTML = `
    <article class="exchange exchange--${kind}">
      <p class="exchange-who">${kind === 'answer' ? 'Tutor' : 'You'}</p>
      <p class="${kind === 'answer' ? '' : 'onboard-bubble-q'}">${escapeHtml(text)}</p>
    </article>`.trim();
  const node = holder.firstElementChild;
  chat.appendChild(node);
  onboardScroll();
}

function onboardPending() {
  const chat = onboardChat();
  if (!chat) return;
  const holder = document.createElement('div');
  holder.innerHTML = `
    <div class="exchange-pending">
      <span class="spinner" aria-hidden="true"></span>
      <span>${onboardLastSent === undefined || onboardLastSent === null ? 'Setting up…' : 'Thinking…'}</span>
    </div>`.trim();
  chat.appendChild(holder.firstElementChild);
  onboardScroll();
}

function showOnboardError(message) {
  const chat = onboardChat();
  if (!chat) return;
  const holder = document.createElement('div');
  holder.innerHTML = `
    <div class="onboard-error">
      <div class="banner banner-error">${icon('alert', { size: 16 })}
        <span><strong>Setup hit a snag.</strong> ${escapeHtml(message)}</span>
      </div>
      <button type="button" class="btn btn-secondary btn-sm" data-onboard-retry>Try again</button>
    </div>`.trim();
  chat.appendChild(holder.firstElementChild);
  onboardScroll();
}

function renderOnboardShell(title) {
  onboardPanel.hidden = false;
  onboardOpen = true;
  onboardDone = false;
  onboardPanel.innerHTML = `
    <div class="onboard-head">
      <h3 class="onboard-title">${icon('spark', { size: 14 })} ${escapeHtml(title)}</h3>
    </div>
    <div class="onboard-chat" data-onboard-chat role="log" aria-live="polite"></div>
    <form class="onboard-composer" data-onboard-form novalidate>
      <label class="sr-only" for="onboard-input">Your reply</label>
      <input class="input" id="onboard-input" data-onboard-input maxlength="800" autocomplete="off" placeholder="Type your answer…">
      <button class="btn btn-primary btn-sm" type="submit" data-onboard-send disabled>Send</button>
      <button class="btn btn-secondary btn-sm" type="button" data-onboard-skip>Skip setup</button>
    </form>`;

  const input = onboardPanel.querySelector('[data-onboard-input]');
  const send = onboardPanel.querySelector('[data-onboard-send]');
  input.addEventListener('input', () => {
    send.disabled = onboardSending || onboardDone || input.value.trim().length === 0;
  });
  input.focus();
}

function showOnboardNote(html) {
  onboardOpen = false;
  onboardPanel.hidden = false;
  onboardPanel.innerHTML = `<p class="onboard-note">${html}</p>`;
}

function hideOnboarding() {
  onboardOpen = false;
  onboardPanel.hidden = true;
  onboardPanel.innerHTML = '';
}

function renderOffer() {
  onboardPanel.hidden = false;
  onboardPanel.innerHTML = `
    <div class="onboard-card">
      <span>Introduce yourself in ~2 minutes and the tutor will teach in your style — examples, step-by-step or straight to the point.</span>
      <span class="onboard-actions">
        <button type="button" class="btn btn-primary btn-sm" data-onboard-start>${icon('spark', { size: 12 })} Start</button>
        <button type="button" class="btn btn-secondary btn-sm" data-onboard-later>Not now</button>
      </span>
    </div>`;
}

async function openOnboarding(mode) {
  if (onboardOpen) return;
  renderOnboardShell(mode === 'resume' ? 'Finish your intro' : 'Introduce yourself');
  await sendOnboardTurn(null);
}

/**
 * One onboarding turn: user reply (or null to open the interview), then the
 * tutor's next question. `echoUser` skips re-rendering the user bubble on retry.
 */
async function sendOnboardTurn(message, { echoUser = true } = {}) {
  const chat = onboardChat();
  if (!chat || onboardSending) return;

  if (message !== null) {
    onboardLastSent = message; // kept for retry, even if this turn fails
    if (echoUser) onboardBubble('question', message);
  }

  onboardPending();
  setOnboardBusy(true);
  try {
    const data = await api.sendOnboardingMessage(message);
    chat.querySelector('.exchange-pending')?.remove();
    onboardBubble('answer', data.reply);

    if (data.done) {
      onboardDone = true;
      onboardLastSent = undefined; // nothing left to retry
      chat.appendChild(Object.assign(document.createElement('div'), {
        className: 'onboard-error',
        innerHTML: `<button type="button" class="btn btn-primary btn-sm" data-onboard-continue>${icon('arrowRight', { size: 12 })} Continue to studying</button>`,
      }));
      onboardScroll();
      setOnboardBusy(false);
      return;
    }
  } catch (error) {
    chat.querySelector('.exchange-pending')?.remove();
    if (error.code === 'ONBOARDING_COMPLETE') {
      showOnboardNote(ONBOARD_DONE_NOTE);
      return;
    }
    // 502/504/NIM and friends: banner inside the panel with a Retry action.
    showOnboardError(errorMessage(error));
    setOnboardBusy(false);
    return;
  } finally {
    if (onboardSending) setOnboardBusy(false);
  }
}

function retryOnboard() {
  if (onboardSending) return;
  // Opening turn never landed → start the interview again; otherwise re-send
  // the last user reply (its bubble is already in the transcript).
  if (onboardLastSent === undefined) return sendOnboardTurn(null);
  return sendOnboardTurn(onboardLastSent, { echoUser: false });
}

async function skipOnboardingFlow() {
  if (onboardSending) return;
  setOnboardBusy(true);
  try {
    await api.skipOnboarding();
    showOnboardNote('Intro skipped — edit preferences anytime on the <a href="profile.html">Profile</a> page.');
  } catch (error) {
    setOnboardBusy(false);
    if (error.code === 'ONBOARDING_COMPLETE') {
      showOnboardNote(ONBOARD_DONE_NOTE);
      return;
    }
    showOnboardError(errorMessage(error));
    return;
  }
  setOnboardBusy(false);
}

onboardPanel.addEventListener('submit', (event) => {
  if (!event.target.matches('[data-onboard-form]')) return;
  event.preventDefault();
  if (onboardSending || onboardDone) return;
  const text = onboardPanel.querySelector('[data-onboard-input]').value.trim();
  if (text.length < 1 || text.length > 800) return;
  const input = onboardPanel.querySelector('[data-onboard-input]');
  input.value = '';
  sendOnboardTurn(text);
});

onboardPanel.addEventListener('click', (event) => {
  if (event.target.closest('[data-onboard-retry]')) {
    event.target.closest('.onboard-error')?.remove();
    retryOnboard();
    return;
  }
  if (event.target.closest('[data-onboard-start]')) { openOnboarding('new'); return; }
  if (event.target.closest('[data-onboard-continue]')) {
    showOnboardNote(ONBOARD_ACTIVE_NOTE);
    return;
  }
  if (event.target.closest('[data-onboard-skip]')) { skipOnboardingFlow(); return; }
  if (event.target.closest('[data-onboard-later]')) {
    offerDismissed = true; // re-offer on the next visit is intended
    hideOnboarding();
  }
});

async function initOnboarding() {
  let profile = null;
  try {
    profile = (await api.getProfile()).profile;
  } catch {
    return; // no profile, no nudges — tutor works as before
  }
  profileState = profile.state;
  const urlOpen = params.get('onboarding') === '1';

  if (profileState === 'in_progress') {
    openOnboarding('resume'); // server kept the transcript
  } else if (profileState === 'completed') {
    if (urlOpen) {
      showOnboardNote('Your profile is already set up — edit it on the <a href="profile.html">Profile</a> page.');
    } else {
      showOnboardNote(ONBOARD_ACTIVE_NOTE);
    }
  } else if (profileState === 'skipped') {
    if (urlOpen) {
      showOnboardNote('Your profile is already set up — edit it on the <a href="profile.html">Profile</a> page.');
    }
  } else if (urlOpen) {
    openOnboarding('new');
  } else if (!offerDismissed) {
    renderOffer();
  }
}

/* ------------------------------------------------------------------ init */

sourcesHost.addEventListener('change', onScopeChange);

renderIntro();
loadSessionContext().then(loadSources);

if (presetTopic) {
  input.value = `What should I know about ${presetTopic}?`;
}
updateComposer();
initOnboarding(); // v1.4 offer / setup panel — independent of material loading
