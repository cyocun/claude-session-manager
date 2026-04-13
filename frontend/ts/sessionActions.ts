import type { SessionSummary } from './types.js';

type SelectedIdsAccessor = () => Set<string>;

export type SessionActionsDeps = {
  byId: (id: string) => any;
  t: (key: string) => string;
  getLang: () => string;
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<any>;
  fetchSessions: (includeArchived?: boolean) => Promise<void>;
  getShowArchived: () => boolean;
  getSelectedIds: SelectedIdsAccessor;
  clearSelectedIds: () => void;
  getSessions: () => SessionSummary[];
};

export function createSessionActions(deps: SessionActionsDeps) {
  const {
    byId,
    t,
    getLang,
    invoke,
    fetchSessions,
    getShowArchived,
    getSelectedIds,
    clearSelectedIds,
    getSessions,
  } = deps;

  let toastTimer: ReturnType<typeof setTimeout> | null = null;

  function showToast(msg: string, action?: { label: string; onClick: () => void | Promise<void> }): void {
    const el = byId('toast') as HTMLElement;
    el.replaceChildren();
    const label = document.createElement('span');
    label.textContent = msg;
    el.appendChild(label);
    if (action) {
      const btn = document.createElement('button');
      btn.className = 'toast-action';
      btn.type = 'button';
      btn.textContent = action.label;
      btn.addEventListener('click', () => {
        if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
        el.classList.add('hidden');
        void action.onClick();
      });
      el.appendChild(btn);
    }
    el.classList.remove('hidden');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.add('hidden');
      toastTimer = null;
    }, action ? 4000 : 2000);
  }

  async function resumeInTerminal(sessionId: string): Promise<void> {
    const data = await invoke('resume_session', { sessionId });
    if (!data?.ok) {
      showToast(t('toastError') + (data?.error || ''));
    } else if (data.method === 'activated' || data.method === 'activated-app') {
      showToast(t('activatedWindow'));
    } else {
      showToast(data.method + t('toastResumed'));
    }
    scheduleRefresh();
  }

  function scheduleRefresh(): void {
    setTimeout(() => fetchSessions(getShowArchived()), 2000);
  }

  async function copyResume(sessionId: string): Promise<void> {
    const data = await invoke('get_resume_command', { sessionId });
    if (!data?.command) {
      showToast(t('toastError'));
      return;
    }
    try {
      await invoke('copy_to_clipboard', { text: data.command });
      showToast(t('toastCopied'));
    } catch (e) {
      showToast(t('toastError') + (e instanceof Error ? e.message : String(e)));
    }
  }

  function makeUndoAction(sessionIds: string[], restoredMessage: string) {
    return {
      label: t('undo'),
      onClick: async () => {
        await invoke('archive_sessions', { sessionIds, archive: false });
        showToast(restoredMessage);
        await fetchSessions(getShowArchived());
      },
    };
  }

  async function archiveSingle(sessionId: string): Promise<void> {
    await invoke('archive_sessions', { sessionIds: [sessionId], archive: true });
    showToast(t('toastArchived'), makeUndoAction([sessionId], t('toastRestored')));
    await fetchSessions(getShowArchived());
  }

  async function archiveSelected(): Promise<void> {
    const selectedIds = getSelectedIds();
    if (selectedIds.size === 0) return;
    const ids = [...selectedIds];
    await invoke('archive_sessions', { sessionIds: ids, archive: true });
    showToast(ids.length + t('toastArchivedN'), makeUndoAction(ids, ids.length + t('toastRestoredN')));
    clearSelectedIds();
    byId('archiveSelectedBtn').classList.add('invisible');
    await fetchSessions(getShowArchived());
  }

  async function archiveProject(projectPath: string): Promise<void> {
    const projectSessions = getSessions().filter((s) => s.project === projectPath).map((s) => s.sessionId);
    if (projectSessions.length === 0) return;
    await invoke('archive_sessions', { sessionIds: projectSessions, archive: true });
    showToast(projectSessions.length + t('toastArchivedN'), makeUndoAction(projectSessions, projectSessions.length + t('toastRestoredN')));
    await fetchSessions(getShowArchived());
  }

  return {
    showToast,
    resumeInTerminal,
    copyResume,
    archiveSingle,
    archiveSelected,
    archiveProject,
  };
}
