import { invokeStrict, isTauri } from './tauri.js';
let promptOpen = false;
let toastFn = null;
async function runCheck() {
    return await invokeStrict('check_for_update');
}
async function promptAndInstall(info) {
    if (promptOpen)
        return;
    promptOpen = true;
    try {
        const notes = info.notes ? `\n\n${info.notes.trim()}` : '';
        const ok = window.confirm(`新しいバージョン ${info.version} が利用可能です（現在 ${info.current_version}）。${notes}\n\n今すぐアップデートして再起動しますか?`);
        if (ok) {
            await invokeStrict('install_update_and_restart');
        }
    }
    finally {
        promptOpen = false;
    }
}
async function checkAuto() {
    if (!isTauri || promptOpen)
        return;
    try {
        const info = await runCheck();
        if (info)
            await promptAndInstall(info);
    }
    catch (e) {
        console.warn('[updater] auto check failed:', e);
    }
}
async function checkManual() {
    if (!isTauri)
        return;
    toastFn?.('アップデートを確認中…');
    try {
        const info = await runCheck();
        if (info) {
            await promptAndInstall(info);
        }
        else {
            toastFn?.('最新バージョンです');
        }
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[updater] manual check failed:', e);
        toastFn?.(`アップデート確認に失敗: ${msg}`);
    }
}
export function initUpdater(opts) {
    if (!isTauri)
        return;
    toastFn = opts.showToast;
    setTimeout(() => { void checkAuto(); }, 5000);
    setInterval(() => { void checkAuto(); }, 6 * 60 * 60 * 1000);
    const tauriEvent = window.__TAURI__?.event;
    tauriEvent?.listen('menu-check-updates', () => { void checkManual(); });
}
