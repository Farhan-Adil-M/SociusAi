// components/shell.js — the navigation, system-status indicator and footer
// shared by the four application pages. Each page calls mountShell('dashboard')
// (or study / flashcards / quiz) once, so the chrome can never drift between
// pages.

import { api, isMockMode } from '../api.js';
import { authReady, getHealthStatus, getUserName, signOut } from '../auth.js';
import { icon, escapeHtml, errorMessage } from '../ui.js';

const NAV_ITEMS = [
  { key: 'dashboard', href: 'dashboard.html', label: 'Dashboard' },
  { key: 'library', href: 'library.html', label: 'Library' },
  { key: 'study', href: 'study.html', label: 'Study' },
  { key: 'flashcards', href: 'flashcards.html', label: 'Flashcards' },
  { key: 'quiz', href: 'quiz.html', label: 'Quiz' },
  { key: 'profile', href: 'profile.html', label: 'Profile' },
];

/**
 * Who is signed in (kept synchronous for callers; see auth.getUserName for the
 * two modes): in Supabase mode the account's name metadata or email local-part,
 * in prototype mode the name typed on the login page. '' when signed out.
 */
export function currentUser() {
  return getUserName();
}

let healthPromise = null;

/** One shared health request per page load (the contract asks for exactly one). */
export function getHealth() {
  if (!healthPromise) {
    // Mock mode answers from fixtures. Otherwise auth.boot()'s cached
    // /api/health read (config discovery) is reused — no second request.
    healthPromise = isMockMode()
      ? api.getHealth().then(
          (data) => ({ ok: true, data }),
          (error) => ({ ok: false, error }),
        )
      : authReady().then(() => getHealthStatus());
  }
  return healthPromise;
}

function navLinks(active) {
  return NAV_ITEMS.map((item) => {
    const current = item.key === active ? ' aria-current="page"' : '';
    return `<a href="${item.href}"${current}>${item.label}</a>`;
  }).join('');
}

function accountArea() {
  const name = currentUser();
  if (!name) {
    return `<a class="btn btn-secondary btn-sm" href="login.html">Sign in</a>`;
  }
  const initial = escapeHtml(name.trim().charAt(0) || 'S');
  return `
    <span class="account-chip" title="Signed in as ${escapeHtml(name)}">
      <span class="account-avatar" aria-hidden="true">${initial}</span>
      <span class="account-name">${escapeHtml(name)}</span>
    </span>
    <button type="button" class="btn btn-quiet btn-sm" data-sign-out>
      ${icon('logout', { size: 14 })} Sign out
    </button>`;
}

function headerHtml(active) {
  const demo = isMockMode()
    ? '<span class="badge badge-demo" title="This page is showing canned fixture data, not live AI output.">Demo data</span>'
    : '';
  return `
    <div class="topbar-inner">
      <a class="brand" href="dashboard.html">
        <span class="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 16 16" shape-rendering="crispEdges" fill="none">
            <rect x="1" y="3" width="6" height="10" fill="#0E1024"/>
            <rect x="9" y="3" width="6" height="10" fill="#0E1024"/>
            <rect x="7" y="3" width="2" height="10" fill="#0E1024"/>
            <rect x="2" y="4" width="4" height="8" fill="#FFFFFF"/>
            <rect x="10" y="4" width="4" height="8" fill="#FFFFFF"/>
            <rect x="3" y="4" width="1" height="5" fill="#FF3E9A"/>
          </svg>
        </span>
        Socius AI
      </a>
      <button type="button" class="nav-toggle" aria-expanded="false" aria-controls="topnav" aria-label="Open menu">
        ${icon('menu', { size: 18 })}
      </button>
      <nav class="topnav" id="topnav" aria-label="Main">${navLinks(active)}</nav>
      <div class="topbar-right">
        ${demo}
        <span class="sys-status" data-sys-status>
          <span class="status-dot" aria-hidden="true"></span>
          <span class="sys-status-label">Checking services…</span>
        </span>
        <span data-account>${accountArea()}</span>
      </div>
    </div>`;
}

const FOOTER_HTML = `
  <div class="shell-footer-inner">
    <span>Socius AI — an AI study companion.</span>
    <span class="spacer"></span>
    <a href="index.html">Home</a>
    <a href="study.html">Study</a>
    <a href="quiz.html">Quiz</a>
    <a href="login.html">Account</a>
  </div>`;

/**
 * Fill `host` with a banner when the backend reports a problem (or is
 * unreachable). Nothing is rendered when everything is healthy.
 */
export function mountHealthBanner(host) {
  if (!host) return;
  getHealth().then((health) => {
    if (!health.ok) {
      host.innerHTML = `
        <div class="banner banner-error">${icon('alert', { size: 16 })}
          <span><strong>The server is not responding.</strong> ${escapeHtml(errorMessage(health.error))} Features below will not work until it is back.</span>
        </div>`;
      return;
    }
    const { status, checks } = health.data;
    if (status === 'ok') return;
    const broken = Object.entries(checks || {})
      .filter(([, value]) => value && value.ok === false)
      .map(([key, value]) => `${key}${value.message ? `: ${value.message}` : ''}`);
    host.innerHTML = `
      <div class="banner banner-warn">${icon('alert', { size: 16 })}
        <span><strong>Running in degraded mode.</strong> Unavailable — ${escapeHtml(broken.join(', ') || 'unknown service')}. Features that rely on it will show an error.</span>
      </div>`;
  });
}

function renderStatus(root, health) {
  const wrap = root.querySelector('[data-sys-status]');
  if (!wrap) return;
  const dot = wrap.querySelector('.status-dot');
  const label = wrap.querySelector('.sys-status-label');
  if (!health.ok) {
    dot.classList.add('is-down');
    label.textContent = 'Server offline';
    wrap.title = 'The Socius AI server could not be reached.';
    return;
  }
  const { status, checks } = health.data;
  if (status === 'ok') {
    label.textContent = 'All systems normal';
    wrap.title = 'SQLite, ChromaDB and the AI provider are all reachable.';
    return;
  }
  dot.classList.add('is-warn');
  const broken = Object.entries(checks || {})
    .filter(([, value]) => value && value.ok === false)
    .map(([key]) => key);
  label.textContent = 'Degraded';
  wrap.title = `Unavailable: ${broken.join(', ') || 'unknown'}. Features that need it will show an error.`;
}

/** Attach (re-attach) the sign-out handler after the account area re-renders. */
function wireSignOut(header) {
  header.querySelector('[data-sign-out]')?.addEventListener('click', () => {
    // auth.signOut clears the prototype name (and the Supabase session when one
    // exists), then both modes route back to login.html.
    signOut();
  });
}

/**
 * Inject the shared header/footer, wire the mobile menu and sign-out, and
 * resolve the system status once for the page.
 */
export function mountShell(active) {
  const header = document.querySelector('[data-shell="header"]');
  const footer = document.querySelector('[data-shell="footer"]');

  if (header) {
    header.innerHTML = headerHtml(active);
    const toggle = header.querySelector('.nav-toggle');
    const nav = header.querySelector('#topnav');
    toggle.addEventListener('click', () => {
      const open = nav.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
      toggle.innerHTML = icon(open ? 'close' : 'menu', { size: 18 });
    });
    nav.addEventListener('click', (event) => {
      if (event.target.closest('a')) {
        nav.classList.remove('is-open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
    wireSignOut(header);
    // In Supabase mode the account chip depends on the restored session, which
    // finishes after this first render — refresh the account corner once ready.
    authReady().then(() => {
      if (!document.body.contains(header)) return;
      if (getUserName()) {
        const slot = header.querySelector('[data-account]');
        if (slot) slot.innerHTML = accountArea();
      }
      wireSignOut(header);
    });
    getHealth().then((health) => renderStatus(header, health));
  }

  if (footer) footer.innerHTML = FOOTER_HTML;
}
