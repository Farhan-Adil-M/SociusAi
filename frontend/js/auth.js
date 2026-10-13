// auth.js — the only module that knows how Socius AI signs people in.
//
// Configuration is discovered from the backend at run time: /api/health gains
// `checks.auth = { mode: 'supabase' | 'prototype', supabaseUrl, supabaseAnonKey }`
// when Supabase auth is configured. No Supabase URL or key is bundled into the
// frontend — the browser only ever receives the PUBLIC (anon) config.
//
// - mode 'supabase': @supabase/supabase-js is lazy-loaded ONCE from the esm.sh
//   CDN the first time it is needed. NOTE: this mode requires the browser to
//   reach https://esm.sh (and Supabase). Prototype mode never loads it. The
//   session is stored by supabase-js in localStorage (its `sb-…-auth-token`
//   key) and is restored on every page load via auth.getSession(); refresh is
//   handled by the library (we force one refresh after an UNAUTHENTICATED 401).
// - mode 'prototype' (dev-without-Supabase, or the server being unreachable):
//   the historic visual-only login — a display name kept in localStorage as
//   `socius_user`, no tokens, no network auth. Documented limitation, retained
//   on purpose so the app still runs with no auth backend.

const SUPABASE_JS_CDN = 'https://esm.sh/@supabase/supabase-js@2';
const USER_KEY = 'socius_user';
const NOTICE_KEY = 'socius_auth_notice'; // message login.html shows once

let client = null; // shared supabase-js browser client (created lazily)
let session = null; // cached copy of the active session (kept by listener)
let mode = 'prototype';
let bootPromise = null;
// Last /api/health outcome, shared with shell.js so the page makes exactly one
// health request that doubles as config discovery.
let health = {
  ok: false,
  error: { code: 'NETWORK_ERROR', message: 'The Socius AI server could not be reached.' },
};

async function inMockMode() {
  try {
    const { isMockMode } = await import('./api.js');
    return isMockMode();
  } catch {
    return false;
  }
}

/** One raw /api/health read (plain fetch — must not recurse through api.js). */
async function readHealth() {
  const response = await fetch('/api/health', {
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
  });
  const text = await response.text().catch(() => '');
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  if (!response.ok || !data || !data.checks) {
    const envelope = data && data.error ? data.error : {};
    health = {
      ok: false,
      error: { code: envelope.code || 'INTERNAL', message: envelope.message || 'The server did not return a usable status response.' },
    };
    return null;
  }
  health = { ok: true, data };
  const auth = data.checks.auth || {};
  return auth.mode === 'supabase' && auth.supabaseUrl && auth.supabaseAnonKey ? auth : null;
}

/** Resolve the mode and (in Supabase mode) restore the saved session. */
async function boot() {
  if (await inMockMode()) return { mode: 'prototype' }; // mock pages need no auth
  try {
    const auth = await readHealth();
    mode = 'prototype';
    if (auth) {
      try {
        // Lazy CDN load — only ever happens when the server reported Supabase.
        const mod = await import(SUPABASE_JS_CDN);
        client = mod.createClient(auth.supabaseUrl, auth.supabaseAnonKey);
        const { data } = await client.auth.getSession();
        session = (data && data.session) || null;
        client.auth.onAuthStateChange((_event, next) => { session = next || null; });
        mode = 'supabase';
      } catch {
        // CDN unreachable or client init failed: fall back to the no-auth
        // prototype UI instead of rendering a broken app. Health stays truthful.
      }
    }
    return { mode, health };
  } catch {
    mode = 'prototype'; // server unreachable — visual-only login, as before
    return { mode, health };
  }
}

/**
 * Boot authentication exactly once. Resolves with { mode, health } and NEVER
 * rejects, so callers can rely on a usable app no matter what failed.
 */
export function authReady() {
  if (!bootPromise) bootPromise = boot();
  return bootPromise;
}

/** 'supabase' once the client is live; 'prototype' otherwise. */
export function getAuthMode() {
  return mode;
}

/** The shared supabase-js client, or null in prototype/mock mode. */
export function getSupabaseClient() {
  return client;
}

/** Health snapshot for shell.js (it renders from this instead of refetching). */
export function getHealthStatus() {
  return health;
}

/** Access token for api.js, or null when signed out / in prototype mode. */
export function accessToken() {
  return (session && session.access_token) || null;
}

/**
 * Display name used across the UI: the Supabase account's name metadata or the
 * email local-part when signed in; otherwise (prototype mode) the name the
 * visitor typed on the login page.
 */
export function getUserName() {
  if (client && session && session.user) {
    const meta = session.user.user_metadata || {};
    const named = meta.display_name || meta.full_name || meta.name || '';
    if (typeof named === 'string' && named.trim()) return named.trim();
    const email = session.user.email || '';
    return email ? email.split('@')[0] : '';
  }
  try { return localStorage.getItem(USER_KEY) || ''; } catch { return ''; }
}

/** Force a token refresh; resolves to a fresh token or null when not possible. */
export async function refreshAccessToken() {
  if (!client || !session) return null;
  try {
    const { data, error } = await client.auth.refreshSession();
    if (error || !data || !data.session) return null;
    session = data.session;
    return session.access_token;
  } catch {
    return null;
  }
}

/**
 * 401 recovery for api.js: stash the message for the login page, clear all
 * locally known state and route the user back to sign in.
 */
export function redirectToLoginWithNotice(message) {
  try {
    sessionStorage.setItem(NOTICE_KEY, message);
    localStorage.removeItem(USER_KEY);
  } catch { /* storage blocked — still redirect */ }
  session = null;
  window.location.href = 'login.html';
}

/**
 * Sign out: clear the Supabase session when one exists, always clear the
 * prototype name, then go to the login page.
 */
export async function signOut() {
  try { if (client) await client.auth.signOut(); } catch { /* clear locally anyway */ }
  session = null;
  try { localStorage.removeItem(USER_KEY); } catch { /* storage blocked */ }
  window.location.href = 'login.html';
}

/** Read (and clear) the "session expired" notice left for the login page. */
export function takeAuthNotice() {
  try {
    const message = sessionStorage.getItem(NOTICE_KEY) || '';
    sessionStorage.removeItem(NOTICE_KEY);
    return message;
  } catch {
    return '';
  }
}
