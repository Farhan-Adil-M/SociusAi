// Study page: material selector + tutor conversation.
// Sources are loaded once, the scope is translated into the contract's
// `sourceIds` filter, and each question is rendered as an exchange block with
// its citations. Loading, empty and error states are all handled per block.

import { mountShell, mountHealthBanner } from '../components/shell.js';
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

let sources = [];
let sending = false;

/* ------------------------------------------------------------ suggestions */

const params = new URLSearchParams(window.location.search);
const presetTopic = (params.get('topic') || '').trim();

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
      title: 'No material yet',
      text: 'Upload a PDF or PowerPoint, or paste a web page, to give the tutor something to search.',
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
        <span class="src-title src-all">All material</span>
        <span class="src-meta">Search everything you have added</span>
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
    const data = await api.listSources();
    sources = data.sources || [];
    renderSources();
    renderIntro();
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

function answerHtml(data) {
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

  return `
    <article class="exchange exchange--answer">
      <p class="exchange-who">Tutor</p>
      <div class="exchange-a-body">${paragraphs}</div>
      ${abstain}
      ${citations}
    </article>`;
}

/* ---------------------------------------------------------------- asking */

function updateComposer() {
  const length = input.value.trim().length;
  countLabel.textContent = `${input.value.length} / 300`;
  sendButton.disabled = sending || length < 3;
}

function setSending(value) {
  sending = value;
  sendLabel.textContent = value ? 'Thinking…' : 'Send';
  sendButton.disabled = value || input.value.trim().length < 3;
}

async function ask(question) {
  const questionBlock = append(`
    <article class="exchange exchange--question">
      <p class="exchange-who">You</p>
      <p>${escapeHtml(question)}</p>
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
    const data = await api.askTutor({ question, sourceIds: selectedSourceIds() });
    pending.outerHTML = answerHtml(data);
    liveRegion.textContent = 'The tutor answered.';
  } catch (error) {
    const message = errorMessage(error);
    pending.outerHTML = `
      <div class="exchange-pending" style="display:block; padding:0; background: none;">
        <div class="banner banner-error">${icon('alert', { size: 16 })}
          <span><strong>The tutor could not answer.</strong> ${escapeHtml(message)}</span>
        </div>
        <div style="margin-top: var(--s3);">
          <button type="button" class="btn btn-secondary btn-sm" data-retry="${escapeHtml(question)}">Ask again</button>
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
  retry.closest('.exchange-pending')?.remove();
  ask(question);
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

fileInput.addEventListener('change', async () => {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;
  if (!/\.(pdf|pptx)$/i.test(file.name)) {
    showAddStatus('error', 'Unsupported file — use a .pdf or .pptx.');
    fileInput.value = '';
    return;
  }
  addStatus.innerHTML = `<div class="study-add-status"><span class="spinner" aria-hidden="true"></span> Extracting and indexing ${escapeHtml(file.name)}…</div>`;
  try {
    const data = await api.uploadSource(file);
    showAddStatus('info', `Added ${data.source.title} — ${data.source.sizeLabel}.`);
    fileInput.value = '';
    await loadSources();
  } catch (error) {
    showAddStatus('error', errorMessage(error));
    fileInput.value = '';
  }
});

webpageForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const url = document.querySelector('#webpage-url').value.trim();
  const text = document.querySelector('#webpage-text').value.trim();

  if (!/^https?:\/\/\S+\.\S+/.test(url)) { showAddStatus('error', 'Enter a full web address, starting with http:// or https://.'); return; }
  if (text.length < 50) { showAddStatus('error', `Paste at least 50 characters of page text (currently ${text.length}).`); return; }
  if (text.length > 200000) { showAddStatus('error', 'That text is too long — 200,000 characters maximum.'); return; }

  addStatus.innerHTML = `<div class="study-add-status"><span class="spinner" aria-hidden="true"></span> Indexing the page…</div>`;
  try {
    const data = await api.addWebpage({ url, text });
    showAddStatus('info', `Added ${data.source.title}.`);
    webpageForm.reset();
    await loadSources();
  } catch (error) {
    showAddStatus('error', errorMessage(error));
  }
});

/* ------------------------------------------------------------------ init */

sourcesHost.addEventListener('change', onScopeChange);

renderIntro();
loadSources();

if (presetTopic) {
  input.value = `What should I know about ${presetTopic}?`;
}
updateComposer();
