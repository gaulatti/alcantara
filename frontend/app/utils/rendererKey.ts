/**
 * The renderer key an on-air page was opened with (gaulatti/alcantara#884): `#key=` in its URL, kept for the session so
 * a reload without the fragment still has it. A fragment never reaches the server or its logs.
 */
const RENDERER_KEY_STORAGE = 'alcantara-renderer-key';

export function pageRendererKey(): string {
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const key = fragment.get('key') || window.sessionStorage.getItem(RENDERER_KEY_STORAGE) || '';
  if (key) window.sessionStorage.setItem(RENDERER_KEY_STORAGE, key);
  return key;
}

/**
 * Says, without drawing anything on the picture, that the API refused the page's renderer key: after a rotation the
 * page needs reopening with the new `#key=`. The page's root carries `data-renderer-key="changed"` (or "other-program"
 * for a key of another program), the console says why, and a `renderer-key-refused` event fires for whatever holds the
 * page. Nothing is said for any other answer.
 */
export function noteRendererKeyAnswer(status: number): void {
  if (status !== 401 && status !== 403) return;
  const state = status === 401 ? 'changed' : 'other-program';
  if (document.documentElement.dataset.rendererKey === state) return;
  document.documentElement.dataset.rendererKey = state;
  console.error(
    status === 401
      ? '[renderer-key] renderer key changed, reload: reopen this page with the new #key='
      : '[renderer-key] this renderer key is for another program: reopen this page with its own #key=',
  );
  window.dispatchEvent(new CustomEvent('renderer-key-refused', { detail: { state } }));
}
