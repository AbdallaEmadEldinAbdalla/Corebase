'use client';

/**
 * Copy, with the failure case handled.
 *
 * `navigator.clipboard` is unavailable on plain HTTP that is not localhost, and
 * throws when permission is denied. The fallback is the old `execCommand` route,
 * because "Copy" that silently does nothing is worse than no button — the user
 * pastes the wrong thing somewhere else and blames the paste.
 */
export async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch { /* fall through */ }
  try {
    const el = document.createElement('textarea');
    el.value = value;
    el.setAttribute('readonly', '');
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}
