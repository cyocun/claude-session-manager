import { invoke, isTauri } from './tauri.js';

interface UpdateInfo {
  version: string;
  current_version: string;
  notes: string | null;
  date: string | null;
}

let promptOpen = false;

async function checkAndPrompt(): Promise<void> {
  if (!isTauri || promptOpen) return;
  let info: UpdateInfo | null;
  try {
    info = await invoke('check_for_update') as UpdateInfo | null;
  } catch {
    return;
  }
  if (!info) return;
  promptOpen = true;
  try {
    const notes = info.notes ? `\n\n${info.notes.trim()}` : '';
    const ok = window.confirm(
      `新しいバージョン ${info.version} が利用可能です（現在 ${info.current_version}）。${notes}\n\n今すぐアップデートして再起動しますか?`,
    );
    if (ok) {
      await invoke('install_update_and_restart');
    }
  } finally {
    promptOpen = false;
  }
}

export function initUpdater(): void {
  if (!isTauri) return;
  // Let the UI settle before showing a blocking dialog
  setTimeout(() => { void checkAndPrompt(); }, 5000);
  // Re-check every 6 hours for long-running sessions
  setInterval(() => { void checkAndPrompt(); }, 6 * 60 * 60 * 1000);
}
