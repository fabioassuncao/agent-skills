import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';
import { ensureProjectPrefix, loadCapabilities } from './lib/api';
import EmptyProjects from './lib/EmptyProjects.svelte';
import { applyTheme, loadSavedTheme } from './lib/utils';

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
