// Login page behaviour. Two modes, decided by the server (js/auth.js reads the
// auth config from /api/health — no keys live in this page's bundle):
//
// - Supabase mode: real email + password sign-in and sign-up through the shared
//   supabase-js client (lazy-loaded from the CDN by auth.js). Common auth
//   failures get friendly copy; on success we route to dashboard.html, exactly
//   like the prototype did.
// - Prototype mode (dev without Supabase, or the server being unreachable):
//   the historic visual-only flow — nothing is verified or sent anywhere; the
//   email local-part is stored locally as the greeting name. The warning
//   banner on the page labels this clearly.

import { icon } from '../ui.js';
import { authReady, getSupabaseClient, takeAuthNotice } from '../auth.js';

const form = document.querySelector('.auth-form');
const emailInput = document.querySelector('#email');
const passwordInput = document.querySelector('#password');
const toggle = document.querySelector('[data-toggle-password]');
const submitBtn = document.querySelector('[data-submit]');
const prototypeBanner = document.querySelector('[data-proto-banner]');
const prototypeFoot = document.querySelector('[data-proto-foot]');
const signupFoot = document.querySelector('[data-signup-foot]');
const noticeBanner = document.querySelector('[data-auth-notice]');
const noticeText = document.querySelector('[data-notice-text]');
const infoBanner = document.querySelector('[data-auth-info]');
const infoText = document.querySelector('[data-info-text]');
const authSub = document.querySelector('[data-auth-sub]');

let authMode = 'prototype'; // resolved by authReady() below
let signupMode = false; // false = sign in, true = create account
let busy = false;

toggle.innerHTML = icon('eye', { size: 17 });

toggle.addEventListener('click', () => {
  const showing = passwordInput.type === 'text';
  passwordInput.type = showing ? 'password' : 'text';
  toggle.setAttribute('aria-pressed', String(!showing));
  toggle.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
  toggle.innerHTML = icon(showing ? 'eye' : 'eyeOff', { size: 17 });
  passwordInput.focus();
});

/* --------------------------------------------------------------- notices */

function showNotice(kind, message) {
  const isInfo = kind === 'info';
  noticeBanner.hidden = isInfo;
  infoBanner.hidden = !isInfo;
  (isInfo ? infoText : noticeText).textContent = message;
}

function hideNotices() {
  noticeBanner.hidden = true;
  infoBanner.hidden = true;
  noticeText.textContent = '';
  infoText.textContent = '';
}

/** Message left for us by api.js after an UNAUTHENTICATED 401 (redirection). */
function showExpiryNotice(message) {
  if (message) showNotice('error', message);
}

/* ------------------------------------------------------ mode-dependent UI */

function submitLabel() {
  if (busy) return signupMode && authMode === 'supabase' ? 'Creating account…' : 'Signing in…';
  if (authMode !== 'supabase') return 'Sign in to the demo';
  return signupMode ? 'Create account' : 'Sign in';
}

function setBusy(next) {
  busy = next;
  submitBtn.disabled = next;
  submitBtn.textContent = submitLabel();
}

function renderSignupFoot() {
  signupFoot.innerHTML = signupMode
    ? 'Already have an account? <a href="#" data-signup-toggle>Sign in instead</a>.'
    : 'New to Socius AI? <a href="#" data-signup-toggle>Create an account</a>.';
  signupFoot.querySelector('[data-signup-toggle]').addEventListener('click', (event) => {
    event.preventDefault();
    setSignupMode(!signupMode);
  });
}

function setSignupMode(next) {
  signupMode = next;
  passwordInput.setAttribute('autocomplete', signupMode ? 'new-password' : 'current-password');
  renderSignupFoot();
  hideNotices();
  submitBtn.textContent = submitLabel();
}

/**
 * Switch the page to the real (Supabase) flow: hide the prototype caveats,
 * relabel the buttons and expose the create-account link.
 */
function useSupabaseMode() {
  authMode = 'supabase';
  const registerBtn = document.querySelector('[data-register]');
  if (registerBtn) registerBtn.hidden = false; // real accounts only
  prototypeBanner.hidden = true;
  prototypeFoot.hidden = true;
  authSub.textContent = 'Sign in with your Socius AI account email and password.';
  if (signupFoot) { signupFoot.hidden = false; setSignupMode(false); }
  submitBtn.textContent = submitLabel();
}

/* ------------------------------------------------------------- validation */

function setError(input, message) {
  const error = document.getElementById(`${input.id}-error`);
  if (!error) return;
  if (message) {
    error.textContent = message;
    error.hidden = false;
    input.setAttribute('aria-invalid', 'true');
  } else {
    error.textContent = '';
    error.hidden = true;
    input.removeAttribute('aria-invalid');
  }
}

function validateEmail() {
  const value = emailInput.value.trim();
  if (!value) { setError(emailInput, 'Enter your email address.'); return false; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    setError(emailInput, 'That does not look like an email address — try name@example.com.');
    return false;
  }
  setError(emailInput, '');
  return true;
}

function validatePassword() {
  const value = passwordInput.value;
  if (!value) { setError(passwordInput, 'Enter a password.'); return false; }
  if (value.length < 6) { setError(passwordInput, 'Use at least 6 characters.'); return false; }
  setError(passwordInput, '');
  return true;
}

emailInput.addEventListener('blur', validateEmail);
passwordInput.addEventListener('blur', validatePassword);
emailInput.addEventListener('input', () => { if (emailInput.getAttribute('aria-invalid')) validateEmail(); });
passwordInput.addEventListener('input', () => { if (passwordInput.getAttribute('aria-invalid')) validatePassword(); });

/* ------------------------------------------------------------ the real flow */

/** Supabase error text → something a student can act on. */
function describeAuthError(error) {
  const raw = String((error && (error.message || error.description || error.code)) || '').toLowerCase();
  if (!raw || raw.includes('failed to fetch')) {
    return 'Could not reach the sign-in service — check your connection and try again.';
  }
  if (raw.includes('invalid login credentials')) return 'That email and password combination is not correct. Check them and try again.';
  if (raw.includes('not confirmed')) return 'This email has not been confirmed yet — click the link in the email we sent you, then sign in.';
  if (raw.includes('rate limit') || raw.includes('too many')) return 'Too many attempts — wait a minute and try again.';
  if (raw.includes('already registered')) return 'An account with this email already exists — sign in with its password.';
  return (error && error.message) || 'Sign-in failed — please try again.';
}

async function realSubmit(isSignup, email, password) {
  const client = getSupabaseClient();
  if (!client) {
    showNotice('error', 'The sign-in client failed to load — reload the page and try again.');
    return;
  }
  setBusy(true);
  hideNotices();
  try {
    if (isSignup) {
      const { data, error } = await client.auth.signUp({ email, password });
      if (error) throw error;
      if (data.session) {
        // Email confirmation is off — the user is signed in right away.
        window.location.href = 'dashboard.html';
        return;
      }
      showNotice('info', 'Account created. We sent a confirmation email — open the link in it, then sign in here.');
      setSignupMode(false);
      return;
    }
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    if (data && data.session) window.location.href = 'dashboard.html';
  } catch (error) {
    showNotice('error', describeAuthError(error));
  } finally {
    setBusy(false);
  }
}

/* --------------------------------------------------------------- dispatch */

form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (busy) return;
  const emailOk = validateEmail();
  const passwordOk = validatePassword();

  if (!emailOk || !passwordOk) {
    (emailOk ? passwordInput : emailInput).focus();
    return;
  }

  const email = emailInput.value.trim();
  const password = passwordInput.value;

  if (authMode === 'supabase') {
    realSubmit(signupMode, email, password);
    return;
  }

  // Prototype flow (unchanged behaviour): the email prefix becomes the greeting.
  const displayName = email.split('@')[0];
  try { localStorage.setItem('socius_user', displayName); } catch { /* storage blocked: still continue */ }
  window.location.href = 'dashboard.html';
});

/* -------------------------------------------------------------------- boot */

(async function bootLoginPage() {
  const outcome = await authReady();

  if (outcome.mode === 'supabase' && getSupabaseClient()) {
    useSupabaseMode();
    // Already signed in (client-side restore) → straight to the dashboard.
    const { data } = await getSupabaseClient().auth.getSession();
    if (data && data.session) {
      window.location.href = 'dashboard.html';
      return;
    }
  }

  // A message left by api.js after an UNAUTHENTICATED 401 ("session expired").
  const notice = takeAuthNotice();
  showExpiryNotice(notice);

  setBusy(false);
})();

// Create-account option (supabase mode): an explicit button that switches the
// same form into signup mode (the prototype mode never shows it).
const registerBtn = document.querySelector('[data-register]');
if (registerBtn) {
  registerBtn.addEventListener('click', (event) => {
    event.preventDefault();
    if (authMode !== 'supabase') return; // only exists for real accounts
    setSignupMode(true);
    emailInput.focus();
  });
}
