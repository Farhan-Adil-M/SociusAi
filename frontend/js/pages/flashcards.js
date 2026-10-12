// Flashcards: generate a deck for a topic, then work through it one card at a
// time. Session state (position, revealed flag, verdicts) lives here; the DOM is
// rebuilt on navigation and updated in place when the card flips, so the
// animation is not interrupted.

import { mountShell, mountHealthBanner } from '../components/shell.js';
import { populateScopeSelect } from '../components/scope-select.js';
import { api } from '../api.js';
import {
  icon, escapeHtml, renderCitations, wireCitations, errorMessage,
} from '../ui.js';

mountShell('flashcards');
mountHealthBanner(document.querySelector('[data-health]'));

const stage = document.querySelector('[data-stage]');
const live = document.querySelector('[data-live]');
const setupStatus = document.querySelector('[data-setup-status]');
const form = document.querySelector('[data-generate-form]');
const topicInput = document.querySelector('#fc-topic');
const topicError = document.querySelector('#fc-topic-error');
const countSelect = document.querySelector('#fc-count');
const scopeSelect = document.querySelector('[data-scope]');
const generateButton = document.querySelector('[data-generate]');

const stageIcon = document.querySelector('[data-stage-icon]');
if (stageIcon) stageIcon.innerHTML = icon('layers', { size: 20 });

wireCitations(stage);

const state = {
  topic: '',
  queue: [],        // cards left in this session
  index: 0,
  revealed: false,
  verdicts: new Map(), // cardId → 'know' | 'review'
  finished: false,
};

/* --------------------------------------------------------------- sources */

populateScopeSelect(scopeSelect, document.querySelector('[data-scope-note]'));

/* ------------------------------------------------------------ generation */

function setTopicError(message) {
  topicError.textContent = message || '';
  topicError.hidden = !message;
  if (message) topicInput.setAttribute('aria-invalid', 'true');
  else topicInput.removeAttribute('aria-invalid');
}

function setSetupStatus(kind, message) {
  setupStatus.innerHTML = message
    ? `<div class="banner banner-${kind}">${escapeHtml(message)}</div>`
    : '';
}

function setGenerating(value) {
  generateButton.disabled = value;
  generateButton.innerHTML = value
    ? '<span class="spinner" aria-hidden="true"></span> Generating cards…'
    : 'Generate deck';
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const topic = topicInput.value.trim();

  if (topic.length < 2) { setTopicError('Enter a topic — at least 2 characters.'); topicInput.focus(); return; }
  if (topic.length > 80) { setTopicError('Keep the topic under 80 characters.'); topicInput.focus(); return; }
  setTopicError('');
  setSetupStatus('', '');

  const count = Number(countSelect.value);
  const sourceIds = scopeSelect.value ? [scopeSelect.value] : [];

  setGenerating(true);
  try {
    const data = await api.generateFlashcards({ topic, count, sourceIds });
    state.topic = data.topic;
    state.queue = data.cards;
    state.index = 0;
    state.revealed = false;
    state.verdicts = new Map();
    state.finished = false;
    render();
    live.textContent = `Deck ready: ${data.cards.length} cards.`;
    stage.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    setSetupStatus('error', errorMessage(error));
  } finally {
    setGenerating(false);
  }
});

/* ------------------------------------------------------------- rendering */

function placeholder() {
  stage.innerHTML = `
    <div class="panel"><div class="panel-body">
      <div class="state">
        <span class="state-icon">${icon('layers', { size: 20 })}</span>
        <span class="state-title">No deck yet</span>
        <p class="state-text">Enter a topic below and Socius AI writes question-and-answer cards from your own material.</p>
      </div>
    </div></div>`;
}

function renderSummary() {
  const values = [...state.verdicts.values()];
  const know = values.filter((value) => value === 'know').length;
  const review = values.filter((value) => value === 'review').length;
  const unmarked = state.queue.length - know - review;

  stage.innerHTML = `
    <div class="fc-session">
      <div class="fc-summary">
        <span class="state-icon">${icon('checkCircle', { size: 20 })}</span>
        <h2>Deck complete</h2>
        <p class="muted">${escapeHtml(state.topic)} — ${state.queue.length} cards worked through.</p>
        <div class="fc-counts">
          <div class="fc-count is-know"><strong>${know}</strong><span>Know it</span></div>
          <div class="fc-count is-review"><strong>${review}</strong><span>Review again</span></div>
          ${unmarked > 0 ? `<div class="fc-count"><strong>${unmarked}</strong><span>Not marked</span></div>` : ''}
        </div>
        <div class="fc-summary-actions">
          ${review > 0 ? '<button type="button" class="btn btn-primary" data-review-flagged>Review the ' + review + ' flagged card' + (review === 1 ? '' : 's') + '</button>' : ''}
          <button type="button" class="btn btn-secondary" data-new-deck>Start a new deck</button>
          <a class="btn btn-secondary" href="dashboard.html">Back to dashboard</a>
        </div>
      </div>
    </div>`;
}

function render() {
  if (!state.queue.length) { placeholder(); return; }
  if (state.finished) { renderSummary(); return; }

  const card = state.queue[state.index];
  const total = state.queue.length;
  const know = [...state.verdicts.values()].filter((value) => value === 'know').length;
  const review = [...state.verdicts.values()].filter((value) => value === 'review').length;
  const isLast = state.index === total - 1;
  const citations = Array.isArray(card.citations) && card.citations.length
    ? `<div class="exchange-citations">
         <p class="exchange-citations-label">Source passages</p>
         ${renderCitations(card.citations)}
       </div>`
    : '';

  stage.innerHTML = `
    <div class="fc-session">
      <div class="fc-session-head">
        <div>
          <p class="fc-session-title">${escapeHtml(state.topic)}</p>
          <div class="fc-session-meta">
            <span class="badge badge-blue">${total} cards</span>
            <span>${know} know it · ${review} to review</span>
          </div>
        </div>
        <p class="fc-position">Card ${state.index + 1} of ${total}</p>
      </div>

      <div class="fc-session-progress">
        <div class="progress" role="img" aria-label="Card ${state.index + 1} of ${total}">
          <div class="progress-bar" style="width: ${Math.round(((state.index + 1) / total) * 100)}%"></div>
        </div>
      </div>

      <div class="fc-card-area">
        <div class="fc-card" data-card>
          <div class="fc-card-inner">
            <div class="fc-face fc-face--front">
              <p class="fc-face-label">
                <span>Question</span>
                <span class="badge">${state.index + 1} / ${total}</span>
              </p>
              <p class="fc-question">${escapeHtml(card.front)}</p>
              <p class="fc-face-hint">${icon('spark', { size: 13 })} Select the card or press “Reveal answer”</p>
            </div>
            <div class="fc-face fc-face--back" data-back aria-hidden="true">
              <p class="fc-face-label"><span>Answer</span></p>
              <div class="fc-answer">${escapeHtml(card.back)}</div>
              ${citations}
            </div>
          </div>
        </div>
      </div>

      <div class="fc-controls">
        <button type="button" class="btn btn-secondary btn-prev" data-prev ${state.index === 0 ? 'disabled' : ''}>
          ${icon('chevronLeft', { size: 15 })} Previous
        </button>
        <div class="fc-controls-center">
          <button type="button" class="btn btn-primary" data-reveal>Reveal answer</button>
        </div>
        <button type="button" class="btn btn-secondary btn-next" data-next>
          ${isLast ? 'Finish session' : `Next ${icon('chevronRight', { size: 15 })}`}
        </button>
      </div>

      <div class="fc-verdict">
        <button type="button" class="btn btn-secondary" data-know disabled>${icon('check', { size: 15 })} Know it</button>
        <button type="button" class="btn btn-secondary" data-review disabled>${icon('refresh', { size: 15 })} Review again</button>
        <p class="fc-verdict-hint" data-verdict-hint>Reveal the answer to mark this card.</p>
      </div>
    </div>`;
}

/* ------------------------------------------------------------ interaction */

function toggleReveal() {
  if (!state.queue.length || state.finished) return;
  state.revealed = !state.revealed;

  const card = stage.querySelector('[data-card]');
  const back = stage.querySelector('[data-back]');
  const revealButton = stage.querySelector('[data-reveal]');
  const knowButton = stage.querySelector('[data-know]');
  const reviewButton = stage.querySelector('[data-review]');
  const hint = stage.querySelector('[data-verdict-hint]');

  card.classList.toggle('is-flipped', state.revealed);
  if (back) back.setAttribute('aria-hidden', String(!state.revealed));
  if (revealButton) revealButton.textContent = state.revealed ? 'Hide answer' : 'Reveal answer';
  if (knowButton) knowButton.disabled = !state.revealed;
  if (reviewButton) reviewButton.disabled = !state.revealed;
  if (hint) hint.textContent = state.revealed
    ? 'Marking saves your answer and moves to the next card.'
    : 'Reveal the answer to mark this card.';

  live.textContent = state.revealed ? 'Answer revealed.' : 'Answer hidden.';
}

function goTo(index) {
  if (index < 0 || index >= state.queue.length) return;
  state.index = index;
  state.revealed = false;
  render();
  live.textContent = `Card ${state.index + 1} of ${state.queue.length}.`;
}

function mark(verdict) {
  const card = state.queue[state.index];
  state.verdicts.set(card.id, verdict);
  if (state.index >= state.queue.length - 1) {
    state.finished = true;
    render();
    live.textContent = 'Deck complete.';
    return;
  }
  goTo(state.index + 1);
}

stage.addEventListener('click', (event) => {
  const target = event.target;

  if (target.closest('[data-reveal]')) { toggleReveal(); return; }
  if (target.closest('[data-prev]')) { goTo(state.index - 1); return; }
  if (target.closest('[data-next]')) {
    if (state.index >= state.queue.length - 1) { state.finished = true; render(); }
    else goTo(state.index + 1);
    return;
  }
  if (target.closest('[data-know]')) { mark('know'); return; }
  if (target.closest('[data-review]')) { mark('review'); return; }

  if (target.closest('[data-review-flagged]')) {
    state.queue = state.queue.filter((card) => state.verdicts.get(card.id) === 'review');
    state.verdicts = new Map();
    state.index = 0;
    state.revealed = false;
    state.finished = false;
    render();
    return;
  }

  if (target.closest('[data-new-deck]')) {
    state.queue = [];
    state.finished = false;
    state.verdicts = new Map();
    state.index = 0;
    render();
    topicInput.focus();
    return;
  }

  // Clicking the card itself flips it (unless a control inside it was used).
  if (target.closest('[data-card]') && !target.closest('button, a')) toggleReveal();
});

/* ------------------------------------------------------------------ init */

const search = new URLSearchParams(window.location.search);
const presetTopic = (search.get('topic') || '').trim();
if (presetTopic) topicInput.value = presetTopic;

render();
