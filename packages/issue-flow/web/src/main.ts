import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';
import { ensureProjectPrefix, loadCapabilities } from './lib/api';
import EmptyProjects from './lib/EmptyProjects.svelte';
import { applyTheme, loadSavedTheme } from './lib/utils';

/**
 * PORT of `frontend/src/main.ts` @ d8c9d5f (21 lines), with one step added.
 *
 * The bootstrap order matters. Capabilities are loaded **first**: every gated
 * surface asks `canCall(...)` while it is being constructed, and a component
 * that mounts before the answer arrives renders as if nothing were available.
 * Then the project prefix is resolved, so the per-project client has a valid
 * `/<prefix>` base before the dashboard makes its first call — mounting first
 * would produce a screen whose every request 404s.
 *
 * The theme is applied here as well as by the inline script in `index.html`.
 * The inline one exists so the first paint is already correct; this one keeps
 * the two in sync when the stored value was absent.
 */
async function start(): Promise<void> {
  const target = document.getElementById('app');
  if (target === null) return;

  applyTheme(loadSavedTheme());
  await loadCapabilities();

  const status = await ensureProjectPrefix();
  if (status === 'redirecting') return;
  if (status === 'no-projects') {
    mount(EmptyProjects, { target });
    return;
  }
  mount(App, { target });
}

void start();
