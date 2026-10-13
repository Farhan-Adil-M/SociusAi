// Dashboard: pulls the learner rollup and the source list once each, then
// renders the six workspace blocks. Every block handles its own loading, empty
// and error state so one failed request never blanks the whole page.

import { mountShell, currentUser, mountHealthBanner } from '../components/shell.js';
import { authReady } from '../auth.js';
import { api } from '../api.js';
import {
  icon, escapeHtml, showError, showEmpty,
  formatDate, formatRelative, sourceIcon, typeLabel,
} from '../ui.js';

mountShell('dashboard');

/* ------------------------------------------------------------ page chrome */

document.querySelectorAll('[data-icon]').forEach((node) => {
  node.innerHTML = icon(node.dataset.icon, { size: node.classList.contains('dash-jump-arrow') ? 16 : 18 });
});

const today = new Date();
document.querySelector('[data-today]').textContent = today.toLocaleDateString(undefined, {
  weekday: 'long', month: 'long', day: 'numeric',
});

const greetingEl = document.querySelector('[data-welcome]');
const hour = today.getHours();
const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

/** The name can resolve after this first render (Supabase session restore). */
function renderGreeting() {
  const name = currentUser();
  greetingEl.textContent = name ? `${greeting}, ${name}.` : 'Welcome back.';
}
renderGreeting();
authReady().then(renderGreeting);

/* ------------------------------------------------------- health banner */

mountHealthBanner(document.querySelector('[data-health]'));

/* ------------------------------------------------------------ summaries */

function renderSummary(progress, sources) {
  const node = document.querySelector('[data-summary]');
  const topics = progress?.topics || [];
  const revision = topics.filter((topic) => topic.needsRevision).length;
  const parts = [];
  if (topics.length === 0) {
    parts.push('No quiz attempts yet — take one to start tracking mastery.');
  } else if (revision > 0) {
    parts.push(`${revision} ${revision === 1 ? 'topic needs' : 'topics need'} revision.`);
  } else {
    parts.push('Nothing needs revision right now.');
  }
  parts.push(sources.length === 0
    ? 'Add material on the Study page to ask questions.'
    : `${sources.length} ${sources.length === 1 ? 'material is' : 'materials are'} ready to study.`);
  node.textContent = parts.join(' ');
}

/* -------------------------------------------------------- continue block */

function renderContinue(progress) {
  const host = document.querySelector('[data-continue]');
  const next = progress?.suggestedNext;
  const topics = progress?.topics || [];

  if (!next || !next.topic) {
    host.classList.add('is-empty');
    host.innerHTML = `
      <div class="dash-empty-inline">
        <span class="state-icon">${icon('target', { size: 20 })}</span>
        <div>
          <strong>Nothing to continue yet.</strong>
          <p>Finish one quiz and this becomes your next step, chosen from your lowest mastery.</p>
        </div>
        <a class="btn btn-primary" href="quiz.html">Start a quiz</a>
      </div>`;
    return;
  }

  const match = topics.find((topic) => topic.topic.toLowerCase() === next.topic.toLowerCase());
  const mastery = match ? match.masteryPercent : null;
  const encoded = encodeURIComponent(next.topic);
  const line = mastery === null
    ? `You have not been quizzed on this yet. The first quiz will start at ${escapeHtml(next.difficulty)} level.`
    : `Mastery sits at ${mastery}%, so the next quiz will run at ${escapeHtml(next.difficulty)} level.`;

  host.innerHTML = `
    <div class="dash-continue-inner">
      <div>
        <p class="dash-kicker">Continue studying</p>
        <h2 id="continue-title">${escapeHtml(next.topic)}</h2>
        <p>${line}</p>
      </div>
      <div class="dash-continue-actions">
        <a class="btn btn-primary" href="quiz.html?topic=${encoded}">Quiz me on this</a>
        <a class="btn btn-secondary" href="study.html?topic=${encoded}">Study it</a>
        <a class="btn btn-secondary" href="flashcards.html?topic=${encoded}">Make flashcards</a>
      </div>
    </div>`;
}

/* ------------------------------------------------------------- mastery */

function renderMastery(progress, materialCount = 0) {
  const host = document.querySelector('[data-mastery]');
  const meta = document.querySelector('[data-mastery-meta]');
  const topics = progress?.topics || [];
  const overall = progress?.overall || { quizzesTaken: 0, questionsAnswered: 0, accuracyPercent: 0 };

  if (topics.length === 0) {
    meta.textContent = '';
    showEmpty(host, {
      iconName: 'trend',
      title: 'No mastery data yet',
      text: 'Mastery is correct answers divided by attempts, per topic. It appears after your first graded quiz.',
      actions: '<a class="btn btn-primary btn-sm" href="quiz.html">Take the first quiz</a>',
    });
    return;
  }

  const average = Math.round(topics.reduce((sum, topic) => sum + topic.masteryPercent, 0) / topics.length);
  meta.textContent = `${topics.length} ${topics.length === 1 ? 'topic' : 'topics'} tracked`;

  // With one topic "overall accuracy" and "average mastery" are the same number —
  // show the material count instead of a duplicated stat.
  const materialsTile = `<div class="stat"><span class="stat-value">${materialCount}</span><span class="stat-label">Materials ready</span></div>`;
  const averageTile = `<div class="stat"><span class="stat-value">${average}%</span><span class="stat-label">Average mastery</span></div>`;

  const stats = `
    <div class="stat-grid">
      <div class="stat"><span class="stat-value">${overall.accuracyPercent}%</span><span class="stat-label">Overall accuracy</span></div>
      ${topics.length > 1 ? averageTile : materialsTile}
      <div class="stat"><span class="stat-value">${overall.quizzesTaken}</span><span class="stat-label">Quizzes taken</span></div>
      <div class="stat"><span class="stat-value">${overall.questionsAnswered}</span><span class="stat-label">Questions answered</span></div>
    </div>`;

  const meters = topics
    .slice()
    .sort((a, b) => a.masteryPercent - b.masteryPercent)
    .map((topic) => `
      <div class="topic-meter">
        <div class="meter-label">
          <strong>${escapeHtml(topic.topic)}</strong>
          <span>${topic.masteryPercent}% mastery · ${topic.correct}/${topic.total} correct</span>
        </div>
        <div class="progress" role="img" aria-label="${escapeHtml(topic.topic)} mastery ${topic.masteryPercent} percent">
          <div class="progress-bar${topic.needsRevision ? ' is-pink' : ''}" style="width: ${topic.masteryPercent}%"></div>
        </div>
        <div class="topic-meta">
          <span class="badge">next: ${escapeHtml(topic.difficulty)}</span>
          ${topic.needsRevision ? '<span class="badge badge-pink">needs revision</span>' : '<span class="badge badge-green">on track</span>'}
          <span>${topic.lastPracticedAt ? `practised ${formatRelative(topic.lastPracticedAt)}` : 'not practised yet'}</span>
        </div>
      </div>`)
    .join('');

  host.innerHTML = `${stats}<hr class="hairline" style="margin: var(--s5) 0;"><div class="mastery-list" style="margin-top: 0;">${meters}</div>`;
}

/* ----------------------------------------------------------- revision */

function renderRevision(progress) {
  const host = document.querySelector('[data-revision]');
  const topics = (progress?.topics || []).filter((topic) => topic.needsRevision);

  if (topics.length === 0) {
    showEmpty(host, {
      iconName: 'checkCircle',
      title: 'Nothing needs revision',
      text: 'A topic joins this list after 3 or more answered questions with mastery below 60%.',
      actions: '<a class="btn btn-secondary btn-sm" href="quiz.html">Practise anyway</a>',
    });
    return;
  }

  host.innerHTML = `<div class="row-list">${topics.map((topic) => `
    <div class="revision-item">
      <span class="revision-score">${topic.masteryPercent}%</span>
      <span class="revision-body">
        <span class="revision-topic">${escapeHtml(topic.topic)}</span>
        <span class="revision-meta">${topic.correct}/${topic.total} correct · next quiz: ${escapeHtml(topic.difficulty)}</span>
      </span>
      <a class="btn btn-secondary btn-sm" href="quiz.html?topic=${encodeURIComponent(topic.topic)}">Quiz me</a>
    </div>`).join('')}</div>`;
}

/* ------------------------------------------------------------ activity */

// Reuses the icons those concepts already have elsewhere: `folder` marks
// sessions on the Library page, `archive` marks filing/organising actions.
const ACTIVITY_ICONS = {
  quiz: 'clipboard', upload: 'upload', question: 'message',
  session: 'folder', organize: 'archive',
};

function renderActivity(progress) {
  const host = document.querySelector('[data-activity]');
  const activity = progress?.recentActivity || [];

  if (activity.length === 0) {
    showEmpty(host, {
      iconName: 'clock',
      title: 'No activity yet',
      text: 'Quizzes, uploads and tutor questions show up here as you work through your material.',
      actions: '<a class="btn btn-primary btn-sm" href="study.html">Start studying</a>',
    });
    return;
  }

  host.innerHTML = `<div class="row-list">${activity.map((entry) => `
    <div class="row-item">
      <span class="row-icon">${icon(ACTIVITY_ICONS[entry.type] || 'clock', { size: 15 })}</span>
      <span class="row-main">
        <span class="row-title">${escapeHtml(entry.topic || entry.detail || entry.type)}</span>
        <span class="row-meta">${entry.topic ? escapeHtml(entry.detail || '') : ''}${entry.topic && entry.detail ? ' · ' : ''}${formatRelative(entry.at)}</span>
      </span>
    </div>`).join('')}</div>`;
}

/* ------------------------------------------------------------ materials */

function renderMaterials(sources) {
  const host = document.querySelector('[data-materials]');

  if (sources.length === 0) {
    showEmpty(host, {
      iconName: 'inbox',
      title: 'No material yet',
      text: 'Upload a PDF or PowerPoint, or paste a web page, on the Study page. Everything you ask gets answered from it.',
      actions: '<a class="btn btn-primary btn-sm" href="study.html">Add material</a>',
    });
    return;
  }

  host.innerHTML = `<div class="row-list">${sources.slice(0, 6).map((source) => `
    <div class="row-item">
      <span class="row-icon">${sourceIcon(source.type, { size: 15 })}</span>
      <span class="row-main">
        <span class="row-title" title="${escapeHtml(source.title)}">${escapeHtml(source.title)}</span>
        <span class="row-meta">${escapeHtml(typeLabel(source.type))} · ${escapeHtml(source.sizeLabel || '')} · ${formatDate(source.createdAt)}</span>
      </span>
    </div>`).join('')}</div>`;
}

/* ------------------------------------------------- personalisation nudge */

/** One small nudge card while the profile is new or was skipped (v1.4). */
function renderProfileNudge(profile) {
  if (!profile || (profile.state !== 'new' && profile.state !== 'skipped')) return;
  const anchor = document.querySelector('.dash-continue');
  if (!anchor) return;
  const skipped = profile.state === 'skipped';
  anchor.insertAdjacentHTML('beforebegin', `
    <a class="banner banner-info" href="profile.html">
      ${icon('heart', { size: 16 })}
      <span><strong>Personalise your learning →</strong> ${
        skipped
          ? 'You skipped the intro, but you can fill in your profile any time.'
          : 'Tell Socius your interests and how to teach you — it adapts explanations and quizzes.'
      }</span>
    </a>`);
}

/* ------------------------------------------------------------------ load */

async function load() {
  const [progressResult, sourcesResult, profileResult] = await Promise.allSettled([
    api.getProgress(),
    api.listSources(),
    api.getProfile(),
  ]);

  const sources = sourcesResult.status === 'fulfilled' ? sourcesResult.value.sources : [];
  if (sourcesResult.status === 'fulfilled') renderMaterials(sources);
  else showError(document.querySelector('[data-materials]'), sourcesResult.reason, { title: 'Could not load your material', onRetry: load });

  if (progressResult.status === 'fulfilled') {
    const progress = progressResult.value;
    renderSummary(progress, sources);
    renderContinue(progress);
    renderMastery(progress, sources.length);
    renderRevision(progress);
    renderActivity(progress);
    // Nudge only when the page itself loaded fine, never when offline/error.
    if (profileResult.status === 'fulfilled') renderProfileNudge(profileResult.value.profile);
    return;
  }

  const error = progressResult.reason;
  document.querySelector('[data-summary]').textContent = 'Your progress could not be loaded.';
  renderContinue(null);
  showError(document.querySelector('[data-mastery]'), error, { title: 'Could not load your progress', onRetry: load });
  showEmpty(document.querySelector('[data-revision]'), { iconName: 'clock', title: 'Unavailable', text: 'Progress is needed to build the revision queue.' });
  showEmpty(document.querySelector('[data-activity]'), { iconName: 'clock', title: 'Unavailable', text: 'Progress is needed to list recent activity.' });
}

load();
