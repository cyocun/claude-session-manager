import { invokeStrict, isTauri } from './tauri.js';

interface UpdateInfo {
  version: string;
  current_version: string;
  notes: string | null;
  date: string | null;
}

type ToastFn = (msg: string) => void;

let promptOpen = false;
let toastFn: ToastFn | null = null;

async function runCheck(): Promise<UpdateInfo | null> {
  return await invokeStrict<UpdateInfo | null>('check_for_update');
}

async function promptAndInstall(info: UpdateInfo): Promise<void> {
  if (promptOpen) return;
  promptOpen = true;
  try {
    const notes = info.notes ? `\n\n${info.notes.trim()}` : '';
    const ok = window.confirm(
      `新しいバージョン ${info.version} が利用可能です（現在 ${info.current_version}）。${notes}\n\n今すぐアップデートして再起動しますか?`,
    );
    if (ok) {
      await invokeStrict('install_update_and_restart');
    }
  } finally {
    promptOpen = false;
  }
}

async function checkAuto(): Promise<void> {
  if (!isTauri || promptOpen) return;
  try {
    const info = await runCheck();
    if (info) await promptAndInstall(info);
  } catch (e) {
    console.warn('[updater] auto check failed:', e);
  }
}

async function checkManual(): Promise<void> {
  if (!isTauri) return;
  toastFn?.('アップデートを確認中…');
  try {
    const info = await runCheck();
    if (info) {
      await promptAndInstall(info);
    } else {
      toastFn?.('最新バージョンです');
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[updater] manual check failed:', e);
    toastFn?.(`アップデート確認に失敗: ${msg}`);
  }
}

export function initUpdater(opts: { showToast: ToastFn }): void {
  if (!isTauri) return;
  toastFn = opts.showToast;
  setTimeout(() => { void checkAuto(); }, 5000);
  setInterval(() => { void checkAuto(); }, 6 * 60 * 60 * 1000);
  const tauriEvent = (window as any).__TAURI__?.event;
  tauriEvent?.listen('menu-check-updates', () => { void checkManual(); });
}
