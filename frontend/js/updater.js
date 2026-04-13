import { invoke, isTauri } from './tauri.js';
let promptOpen = false;
async function checkAndPrompt() {
    if (!isTauri || promptOpen)
        return;
    let info;
    try {
        info = await invoke('check_for_update');
    }
    catch {
        return;
    }
    if (!info)
        return;
    promptOpen = true;
    try {
        const notes = info.notes ? `\n\n${info.notes.trim()}` : '';
        const ok = window.confirm(`新しいバージョン ${info.version} が利用可能です（現在 ${info.current_version}）。${notes}\n\n今すぐアップデートして再起動しますか?`);
        if (ok) {
            await invoke('install_update_and_restart');
        }
    }
    finally {
        promptOpen = false;
    }
}
export function initUpdater() {
    if (!isTauri)
        return;
    // Let the UI settle before showing a blocking dialog
    setTimeout(() => { void checkAndPrompt(); }, 5000);
    // Re-check every 6 hours for long-running sessions
    setInterval(() => { void checkAndPrompt(); }, 6 * 60 * 60 * 1000);
}
