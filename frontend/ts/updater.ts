import { invokeStrict, isTauri } from './tauri.js';
import { createEl } from './dom.js';

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

function showUpdateModal(info: UpdateInfo): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const overlay = createEl('div', { className: 'update-modal-overlay' });
    const modal = createEl('div', { className: 'update-modal' });
    const title = createEl('div', {
      className: 'update-modal-title',
      textContent: `新しいバージョン ${info.version} が利用可能です`,
    });
    const subtitle = createEl('div', {
      className: 'update-modal-subtitle',
      textContent: `現在のバージョン: ${info.current_version}`,
    });
    modal.appendChild(title);
    modal.appendChild(subtitle);
    if (info.notes && info.notes.trim().length > 0) {
      const notes = createEl('pre', {
        className: 'update-modal-notes',
        textContent: info.notes.trim(),
      });
      modal.appendChild(notes);
    }
    const body = createEl('div', {
      className: 'update-modal-body',
      textContent: '今すぐアップデートして再起動しますか?',
    });
    modal.appendChild(body);
    const actions = createEl('div', { className: 'update-modal-actions' });
    const laterBtn = createEl('button', { className: 'mac-btn', textContent: '後で' });
    const updateBtn = createEl('button', { className: 'mac-btn mac-btn-primary', textContent: 'アップデート' });
    const settle = (answer: boolean) => {
      overlay.remove();
      resolve(answer);
    };
    laterBtn.addEventListener('click', () => settle(false));
    updateBtn.addEventListener('click', () => settle(true));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) settle(false);
    });
    actions.appendChild(laterBtn);
    actions.appendChild(updateBtn);
    modal.appendChild(actions);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    setTimeout(() => updateBtn.focus(), 0);
  });
}

async function promptAndInstall(info: UpdateInfo): Promise<void> {
  if (promptOpen) return;
  promptOpen = true;
  try {
    const ok = await showUpdateModal(info);
    if (ok) {
      toastFn?.('アップデートをダウンロード中…');
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
