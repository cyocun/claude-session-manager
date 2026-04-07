export function createSessionActions(deps) {
    const { byId, t, getLang, invoke, copyText, fetchSessions, getShowArchived, getSelectedIds, clearSelectedIds, getSessions, } = deps;
    function showToast(msg) {
        const el = byId('toast');
        el.textContent = msg;
        el.classList.remove('hidden');
        setTimeout(() => el.classList.add('hidden'), 2000);
    }
    async function resumeInTerminal(sessionId) {
        const data = await invoke('resume_session', { sessionId });
        if (!data?.ok) {
            showToast(t('toastError') + (data?.error || ''));
        }
        else if (data.method === 'activated' || data.method === 'activated-app') {
            showToast(getLang() === 'ja' ? '実行中のウィンドウをアクティブにしました' : 'Activated existing window');
        }
        else {
            showToast(data.method + t('toastResumed'));
        }
    }
    async function copyResume(sessionId) {
        const data = await invoke('get_resume_command', { sessionId });
        await copyText(data.command);
        showToast(t('toastCopied'));
    }
    async function archiveSingle(sessionId) {
        await invoke('archive_sessions', { sessionIds: [sessionId], archive: true });
        showToast(t('toastArchived'));
        await fetchSessions(getShowArchived());
    }
    async function archiveSelected() {
        const selectedIds = getSelectedIds();
        if (selectedIds.size === 0)
            return;
        const count = selectedIds.size;
        await invoke('archive_sessions', { sessionIds: [...selectedIds], archive: true });
        showToast(count + t('toastArchivedN'));
        clearSelectedIds();
        byId('archiveSelectedBtn').classList.add('invisible');
        await fetchSessions(getShowArchived());
    }
    async function archiveProject(projectPath) {
        const projectSessions = getSessions().filter((s) => s.project === projectPath).map((s) => s.sessionId);
        if (projectSessions.length === 0)
            return;
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
