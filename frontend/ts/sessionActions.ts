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

  function showToast(msg: string): void {
    const el = byId('toast') as HTMLElement;
    el.textContent = msg;
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 2000);
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

  async function archiveSingle(sessionId: string): Promise<void> {
    await invoke('archive_sessions', { sessionIds: [sessionId], archive: true });
    showToast(t('toastArchived'));
    await fetchSessions(getShowArchived());
  }

  async function archiveSelected(): Promise<void> {
    const selectedIds = getSelectedIds();
    if (selectedIds.size === 0) return;
    const count = selectedIds.size;
    await invoke('archive_sessions', { sessionIds: [...selectedIds], archive: true });
    showToast(count + t('toastArchivedN'));
    clearSelectedIds();
    byId('archiveSelectedBtn').classList.add('invisible');
    await fetchSessions(getShowArchived());
  }

  async function archiveProject(projectPath: string): Promise<void> {
    const projectSessions = getSessions().filter((s) => s.project === projectPath).map((s) => s.sessionId);
    if (projectSessions.length === 0) return;
    await invoke('archive_sessions', { sessionIds: projectSessions, archive: true });
    showToast(projectSessions.length + t('toastArchivedN'));
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
