import { homeyApi, mountConnectionForm } from './browser.js';

export async function render(container, context = {}) {
  const { section, signal } = context;
  container.replaceChildren();
  if (section !== 'household') return;
  try {
    const status = await homeyApi('/status', { signal });
    if (signal?.aborted) return;
    const reload = async () => {
      const next = await homeyApi('/status', { signal, csrf: status.csrfToken });
      if (signal?.aborted) return;
      mountConnectionForm(container, {
        status: next,
        signal,
        onSaved: reload,
      });
    };
    mountConnectionForm(container, { status, signal, onSaved: reload });
  } catch (err) {
    if (signal?.aborted) return;
    const note = document.createElement('p');
    note.className = 'form-hint form-hint--danger';
    note.textContent = err.message;
    container.replaceChildren(note);
  }
}
