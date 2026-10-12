// Login page behaviour: password visibility toggle, honest client-side
// validation, and a local-only "sign in" that stores a display name in this
// browser. There is no authentication backend — the notice on the page says so.

import { icon } from '../ui.js';

const form = document.querySelector('.auth-form');
const emailInput = document.querySelector('#email');
const passwordInput = document.querySelector('#password');
const toggle = document.querySelector('[data-toggle-password]');

toggle.innerHTML = icon('eye', { size: 17 });

toggle.addEventListener('click', () => {
  const showing = passwordInput.type === 'text';
  passwordInput.type = showing ? 'password' : 'text';
  toggle.setAttribute('aria-pressed', String(!showing));
  toggle.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
  toggle.innerHTML = icon(showing ? 'eye' : 'eyeOff', { size: 17 });
  passwordInput.focus();
});

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

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const emailOk = validateEmail();
  const passwordOk = validatePassword();

  if (!emailOk || !passwordOk) {
    (emailOk ? passwordInput : emailInput).focus();
    return;
  }

  // Local-only: the email prefix becomes the greeting on the dashboard.
  const displayName = emailInput.value.trim().split('@')[0];
  try { localStorage.setItem('socius_user', displayName); } catch { /* storage blocked: still continue */ }
  window.location.href = 'dashboard.html';
});
