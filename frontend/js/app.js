import { detectLang, translate } from './i18n.js';
import { createEl } from './dom.js';
import { getThemePref, applyTheme, watchSystemTheme } from './theme.js';
import { invoke, isTauri } from './tauri.js';
import { copyText, isRemoteHost, shortPath, timeAgo } from './utils.js';
import { getPreviewDetailCached, hidePreview, initPreview, schedulePreviewHide, schedulePreviewShow, setPreviewDetailCached, } from './preview.js';
import { createChatSearchController } from './chatSearch.js';
import { createFullTextSearchController } from './fullTextSearch.js';
import { renderToolBlocks } from './toolRenderer.js';
import { createSessionActions } from './sessionActions.js';
import { initKeyboardNavigation, initResizeHandle } from './layoutControls.js';
const tauriWindow = window.__TAURI__;
const byId = (id) => document.getElementById(id);
let lang = detectLang();
function t(key) { return translate(lang, key); }
function applyI18n() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const node = el;
        el.textContent = t(node.dataset.i18n || '');
    });
    document.querySelectorAll('[data-i18n-option]').forEach(el => {
        const node = el;
        el.textContent = t(node.dataset.i18nOption || '');
    });
    byId('search').placeholder = t('searchPlaceholder');
    const cs = byId('chatSearch');
    if (cs)
        cs.placeholder = t('chatSearchPlaceholder');
    byId('newSessionBtn').title = lang === 'ja' ? '新規セッション' : 'New Session';
}
// --- Theme ---
let themePref = getThemePref();
watchSystemTheme(() => {
    if (themePref === 'system')
        applyTheme(themePref);
});
// --- Markdown ---
const md = window.markdownit({
    html: false, breaks: true, linkify: true,
    highlight: function (str, codeLang) {
        if (codeLang && hljs.getLanguage(codeLang)) {
            try {
                return hljs.highlight(str, { language: codeLang }).value;
            }
            catch { }
        }
        try {
            return hljs.highlightAuto(str).value;
        }
        catch { }
        return '';
    }
});
function renderMarkdown(text) { return DOMPurify.sanitize(md.render(text)); }
// --- State ---
let sessions = [];
let projects = [];
let selectedProject = null;
let selectedSession = null;
let selectedIds = new Set();
let serverSettings = {};
let projectNameMap = {}; // path -> display name
// Stores projects the user has explicitly toggled open/closed
let toggledProjects = new Set(JSON.parse(localStorage.getItem('csm-toggled') || '[]'));
// Stores projects where "show older" has been clicked
let showAllSessions = new Set();
let openedAt = Date.now();
let knownTimestamps = {}; // sessionId -> lastTimestamp at first load
let isFirstLoad = true;
let allMessagesRendered = true;
let renderAbort = null;
// Search controllers are pure modules; app.ts wires them to current state/getters.
const chatSearch = createChatSearchController({
    byId,
    t,
    isAllMessagesRendered: () => allMessagesRendered,
});
const fullTextSearch = createFullTextSearchController({
    byId,
    t,
    getLang: () => lang,
    getSessions: () => sessions,
    getSelectedProject: () => selectedProject,
    projectDisplayName,
    invoke,
    renderSessions,
    showDetail,
    setSelectedSession: (sessionId) => { selectedSession = sessionId; },
    chatSearch,
});
const actions = createSessionActions({
    byId,
    t,
    getLang: () => lang,
    invoke,
    copyText,
    fetchSessions,
    getShowArchived: () => byId('showArchived').checked,
    getSelectedIds: () => selectedIds,
    clearSelectedIds: () => { selectedIds.clear(); },
    getSessions: () => sessions,
});
async function fetchSessions(includeArchived = false) {
    sessions = await invoke('list_sessions', { includeArchived }) || [];
    if (isFirstLoad) {
        sessions.forEach(s => { knownTimestamps[s.sessionId] = s.lastTimestamp; });
        isFirstLoad = false;
    }
    renderSessions();
}
function isUpdatedSession(s) {
    if (!(s.sessionId in knownTimestamps))
        return true; // new session
    return s.lastTimestamp > knownTimestamps[s.sessionId]; // timestamp changed
}
async function fetchProjects() {
    projects = await invoke('list_projects') || [];
    projectNameMap = {};
    projects.forEach(p => { if (p.name)
        projectNameMap[p.path] = p.name; });
    renderProjects();
}
async function fetchDetail(sessionId) {
    return await invoke('get_session_detail', { sessionId });
}
async function fetchSettings() {
    serverSettings = await invoke('get_settings') || {};
}
function projectDisplayName(path) {
    return projectNameMap[path] || shortPath(path).split('/').pop() || shortPath(path);
}
function isRemote() {
    return isRemoteHost(location.hostname);
}
// --- Rendering ---
function renderProjects() {
    // Projects are now only used for display name mapping, no sidebar rendering
    projectNameMap = {};
    projects.forEach(p => { if (p.name)
        projectNameMap[p.path] = p.name; });
}
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
function isRecentProject(g) {
    return (Date.now() - g.sessions[0].lastTimestamp) < SEVEN_DAYS;
}
function isProjectOpen(g) {
    // User explicitly toggled -> respect that
    if (toggledProjects.has(g.path)) {
        // toggled means: flip the default
        // default open = recent, default closed = old
        return !isRecentProject(g);
    }
    // Default: open if recent
    return isRecentProject(g);
}
function saveToggled() {
    localStorage.setItem('csm-toggled', JSON.stringify([...toggledProjects]));
}
function renderSessionItem(s) {
    const cb = createEl('input', {
        type: 'checkbox',
        className: 'session-check mac-check mt-1 flex-shrink-0',
        'data-id': s.sessionId,
        onChange: (e) => {
            const target = e.target;
            if (target?.checked)
                selectedIds.add(s.sessionId);
            else
                selectedIds.delete(s.sessionId);
            const ab = byId('archiveSelectedBtn');
            ab.classList.toggle('invisible', selectedIds.size === 0);
            ab.classList.toggle('visible', selectedIds.size > 0);
        }
    });
    if (selectedIds.has(s.sessionId))
        cb.checked = true;
    const firstMsg = createEl('p', { className: 'text-sm leading-snug truncate', textContent: s.firstDisplay });
    firstMsg.style.color = 'var(--text)';
    const lastMsg = (s.lastDisplay && s.lastDisplay !== s.firstDisplay)
        ? createEl('p', { className: 'text-xs leading-snug truncate mt-0.5', textContent: s.lastDisplay })
        : null;
    if (lastMsg)
        lastMsg.style.color = 'var(--text-muted)';
    const dot = () => { const sp = createEl('span', { className: 'text-[10px] flex-shrink-0', textContent: '·' }); sp.style.color = 'var(--text-dot)'; return sp; };
    const meta = (txt) => { const sp = createEl('span', { className: 'text-[10px] flex-shrink-0', textContent: txt }); sp.style.color = 'var(--text-faint)'; return sp; };
    const metaParts = [meta(timeAgo(s.lastTimestamp, lang, t)), dot(), meta(s.messageCount + t('msg'))];
    if (s.archived) {
        const sp = createEl('span', { className: 'text-[10px] flex-shrink-0', textContent: t('archived') });
        sp.style.color = 'var(--text-faint)';
        metaParts.push(sp);
    }
    const updated = isUpdatedSession(s);
    const metaDiv = createEl('div', { className: 'mt-1 overflow-hidden' }, metaParts);
    metaDiv.style.cssText = 'display:grid;grid-auto-flow:column;grid-auto-columns:max-content;align-items:center;gap:8px;';
    const textDiv = createEl('div', { className: 'min-w-0 overflow-hidden' }, [firstMsg, lastMsg, metaDiv].filter(Boolean));
    const rowChildren = [cb];
    if (updated) {
        const updDot = createEl('span', { className: 'flex-shrink-0 mt-1.5' });
        updDot.style.cssText = 'width:7px;height:7px;border-radius:50%;background:var(--updated-dot);';
        rowChildren.push(updDot);
    }
    rowChildren.push(textDiv);
    const row = createEl('div', { className: 'overflow-hidden' }, rowChildren);
    row.style.cssText = 'display:grid;grid-template-columns:' + (updated ? 'auto auto 1fr' : 'auto 1fr') + ';align-items:start;gap:8px;';
    const isActive = selectedSession === s.sessionId;
    const defaultBg = updated ? 'var(--updated-bg)' : 'transparent';
    const item = createEl('div', {
        className: 'session-item p-3 rounded cursor-default transition border overflow-hidden',
        'data-id': s.sessionId,
        onClick: (e) => {
            const target = e.target;
            if (target?.tagName === 'INPUT')
                return;
            hidePreview();
            // Deselect previous
            const prev = document.querySelector('.session-item-active');
            if (prev) {
                prev.classList.remove('session-item-active');
                prev.style.borderColor = 'transparent';
                prev.style.background = '';
            }
            selectedSession = s.sessionId;
            knownTimestamps[s.sessionId] = s.lastTimestamp;
            // Select current
            item.classList.add('session-item-active');
            item.style.borderColor = 'var(--item-active-border)';
            item.style.background = 'var(--item-active)';
            showDetail(s.sessionId);
        }
    }, [row]);
    if (isActive)
        item.classList.add('session-item-active');
    item.style.borderColor = isActive ? 'var(--item-active-border)' : 'transparent';
    item.style.background = isActive ? 'var(--item-active)' : defaultBg;
    if (s.archived)
        item.style.opacity = '0.4';
    // Tooltip with date
    const dateStr = s.lastTimestamp ? new Date(s.lastTimestamp).toLocaleString(lang === 'ja' ? 'ja-JP' : 'en-US') : '';
    item.title = dateStr;
    item.addEventListener('mouseenter', () => {
        if (!isActive)
            item.style.background = 'var(--item-hover)';
        if (!isActive) {
            schedulePreviewShow(s.sessionId, item.getBoundingClientRect());
        }
    });
    item.addEventListener('mouseleave', () => {
        if (!isActive)
            item.style.background = defaultBg;
        schedulePreviewHide();
    });
    return item;
}
function renderSessions() {
    const search = byId('search').value.toLowerCase();
    let filtered = sessions;
    if (selectedProject)
        filtered = filtered.filter(s => s.project === selectedProject);
    if (search)
        filtered = filtered.filter(s => (s.firstDisplay || '').toLowerCase().includes(search) ||
            (s.lastDisplay || '').toLowerCase().includes(search) ||
            s.project.toLowerCase().includes(search) ||
            (projectNameMap[s.project] || '').toLowerCase().includes(search));
    byId('sessionListTitle').textContent =
        filtered.length + ' ' + t('sessions') + (selectedProject ? ' — ' + projectDisplayName(selectedProject) : '');
    const archBtn = byId('archiveSelectedBtn');
    archBtn.classList.toggle('invisible', selectedIds.size === 0);
    archBtn.classList.toggle('visible', selectedIds.size > 0);
    const el = byId('sessionList');
    el.replaceChildren();
    // When a specific project is selected, render flat list
    if (selectedProject) {
        filtered.forEach(s => el.appendChild(renderSessionItem(s)));
        return;
    }
    // Group by project
    const groups = [];
    const groupMap = {};
    filtered.forEach(s => {
        if (!groupMap[s.project]) {
            groupMap[s.project] = { path: s.project, sessions: [] };
            groups.push(groupMap[s.project]);
        }
        groupMap[s.project].sessions.push(s);
    });
    groups.forEach(g => {
        const open = isProjectOpen(g);
        const group = createEl('div', { className: 'project-group' });
        // Group header
        const chevron = createEl('span', { className: 'project-group-chevron' + (open ? ' open' : ''), textContent: '\u25B6' });
        const name = createEl('span', { className: 'text-xs font-medium flex-1 truncate', textContent: projectDisplayName(g.path) });
        name.style.color = 'var(--text-secondary)';
        const count = createEl('span', { className: 'text-[10px] flex-shrink-0', textContent: g.sessions.length + '' });
        count.style.color = 'var(--text-muted)';
        const icon = createEl('span', { className: 'project-group-icon' });
        icon.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4.5A1.5 1.5 0 013.5 3H6l1.5 2h5A1.5 1.5 0 0114 6.5v5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5z"/></svg>';
        const header = createEl('div', { className: 'project-group-header' }, [chevron, icon, name, count]);
        if (projectNameMap[g.path])
            header.title = shortPath(g.path);
        // Split sessions into recent (7 days) and older
        const now = Date.now();
        const recentSessions = g.sessions.filter(s => (now - s.lastTimestamp) < SEVEN_DAYS);
        const olderSessions = g.sessions.filter(s => (now - s.lastTimestamp) >= SEVEN_DAYS);
        const sessionsDiv = createEl('div', { className: 'project-group-sessions' + (open ? ' open' : '') });
        recentSessions.forEach(s => sessionsDiv.appendChild(renderSessionItem(s)));
        if (olderSessions.length > 0) {
            if (showAllSessions.has(g.path)) {
                olderSessions.forEach(s => sessionsDiv.appendChild(renderSessionItem(s)));
            }
            else {
                const showOlderBtn = createEl('button', {
                    className: 'show-older-pill',
                    textContent: (lang === 'ja' ? '古いセッションを表示' : 'Show older') + ' (' + olderSessions.length + ')',
                    onClick: (e) => {
                        e.stopPropagation();
                        showAllSessions.add(g.path);
                        renderSessions();
                    }
                });
                sessionsDiv.appendChild(showOlderBtn);
            }
        }
        if (recentSessions.length === 0 && !showAllSessions.has(g.path)) {
            const hint = createEl('p', { className: 'text-[11px] px-3 py-1.5', textContent: lang === 'ja' ? '最近のセッションなし' : 'No recent sessions' });
            hint.style.color = 'var(--text-faint)';
            sessionsDiv.insertBefore(hint, sessionsDiv.firstChild);
        }
        header.addEventListener('click', (e) => {
            if (e.metaKey || e.ctrlKey) {
                const allChevrons = document.querySelectorAll('.project-group-chevron');
                const allSessions = document.querySelectorAll('.project-group-sessions');
                const shouldOpen = !chevron.classList.contains('open');
                allChevrons.forEach(c => c.classList.toggle('open', shouldOpen));
                allSessions.forEach(s => s.classList.toggle('open', shouldOpen));
                toggledProjects.clear();
                if (!shouldOpen) {
                    groups.forEach(gg => { if (isRecentProject(gg))
                        toggledProjects.add(gg.path); });
                }
                else {
                    groups.forEach(gg => { if (!isRecentProject(gg))
                        toggledProjects.add(gg.path); });
                }
                saveToggled();
                return;
            }
            if (toggledProjects.has(g.path))
                toggledProjects.delete(g.path);
            else
                toggledProjects.add(g.path);
            saveToggled();
            chevron.classList.toggle('open');
            sessionsDiv.classList.toggle('open');
        });
        group.appendChild(header);
        group.appendChild(sessionsDiv);
        el.appendChild(group);
    });
}
async function showDetail(sessionId) {
    const pane = byId('detailPane');
    const headerEl = byId('detailHeader');
    const messagesEl = byId('detailMessages');
    // Switch to 3-column layout & enforce wider min width
    document.body.style.gridTemplateColumns = '300px 1px 1fr';
    if (isTauri) {
        tauriWindow.window.getCurrentWindow().setMinSize(new tauriWindow.window.LogicalSize(700, 500));
    }
    byId('resizeHandle').style.display = '';
    pane.style.display = 'grid';
    // Abort any in-progress chunk rendering from previous session
    if (renderAbort)
        renderAbort.aborted = true;
    // Switch from grid centering (empty state) to block for scrollable content
    messagesEl.style.display = 'block';
    messagesEl.replaceChildren();
    messagesEl.scrollTop = 0;
    chatSearch.reset();
    hidePreview();
    const cached = getPreviewDetailCached(sessionId);
    const detail = cached || await fetchDetail(sessionId);
    setPreviewDetailCached(sessionId, detail);
    const sessionSummary = sessions.find(s => s.sessionId === sessionId);
    const projectName = projectDisplayName(detail.project);
    const sessionTitle = sessionSummary ? sessionSummary.firstDisplay : '';
    const pathLine = createEl('span', { className: 'text-xs' });
    pathLine.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;';
    const projSpan = createEl('span', { className: 'font-medium', textContent: projectName });
    projSpan.style.color = 'var(--text-secondary)';
    pathLine.appendChild(projSpan);
    if (sessionTitle) {
        const sep = createEl('span', { textContent: ' — ' });
        sep.style.color = 'var(--text-faint)';
        pathLine.appendChild(sep);
        const titleSpan = createEl('span', { textContent: sessionTitle });
        titleSpan.style.color = 'var(--text-muted)';
        pathLine.appendChild(titleSpan);
    }
    pathLine.title = shortPath(detail.project) + ' · ' + sessionId;
    const mkBtn = (text, isPrimary, onClick) => {
        const btn = createEl('button', {
            className: 'mac-btn flex-shrink-0' + (isPrimary ? ' mac-btn-primary' : ''),
            textContent: text, onClick
        });
        return btn;
    };
    // Chat search — macOS-style with count and nav inside the field
    const chatSearchInput = createEl('input', {
        type: 'text', id: 'chatSearch',
        className: 'mac-input',
    });
    chatSearchInput.style.cssText = 'width:100%;height:28px;padding:4px 60px 4px 8px;box-sizing:border-box;';
    chatSearchInput.placeholder = t('chatSearchPlaceholder');
    const chatCount = createEl('span', { id: 'chatSearchCount', className: 'text-[10px]' });
    chatCount.style.cssText = 'color:var(--text-faint);white-space:nowrap;';
    const prevBtn = createEl('button', { id: 'chatSearchPrev', className: 'hidden', textContent: '\u25B2' });
    prevBtn.style.cssText = 'font-size:9px;color:var(--text-muted);padding:0 2px;line-height:1;cursor:default;background:none;border:none;pointer-events:auto;';
    const nextBtn = createEl('button', { id: 'chatSearchNext', className: 'hidden', textContent: '\u25BC' });
    nextBtn.style.cssText = 'font-size:9px;color:var(--text-muted);padding:0 2px;line-height:1;cursor:default;background:none;border:none;pointer-events:auto;';
    const searchOverlay = createEl('div', {}, [chatCount, prevBtn, nextBtn]);
    searchOverlay.style.cssText = 'display:grid;grid-auto-flow:column;grid-auto-columns:max-content;align-items:center;gap:2px;position:absolute;right:6px;top:50%;transform:translateY(-50%);pointer-events:auto;';
    const searchGroup = createEl('div', {}, [chatSearchInput, searchOverlay]);
    searchGroup.style.cssText = 'display:grid;position:relative;width:200px;justify-self:end;';
    const headerRow = createEl('div', { className: 'min-w-0' }, [
        pathLine, searchGroup,
    ]);
    headerRow.style.cssText = 'display:grid;grid-template-columns:minmax(0,1fr) 200px;align-items:center;gap:12px;';
    const headerRow2 = createEl('div', {});
    headerRow2.style.height = '22px';
    headerEl.replaceChildren(headerRow, headerRow2);
    // Re-bind chat search events
    let chatSearchTimer;
    chatSearchInput.addEventListener('input', () => { clearTimeout(chatSearchTimer); chatSearchTimer = setTimeout(() => chatSearch.doSearch(), 200); });
    nextBtn.addEventListener('click', () => chatSearch.next());
    prevBtn.addEventListener('click', () => chatSearch.prev());
    chatSearchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.shiftKey ? chatSearch.prev() : chatSearch.next();
            e.preventDefault();
        }
        if (e.key === 'Escape') {
            const target = e.target;
            if (target) {
                target.value = '';
                chatSearch.doSearch();
                target.blur();
            }
        }
    });
    // Footer buttons
    const footerEl = byId('detailFooter');
    const updatedSessionSummary = sessions.find(s => s.sessionId === sessionId);
    const sessionUpdated = updatedSessionSummary ? isUpdatedSession(updatedSessionSummary) : false;
    const resumeOpenBtn = mkBtn(isRemote() ? t('resumeCopy') : 'Resume (' + (serverSettings.terminalApp || 'Terminal') + ')', sessionUpdated, () => isRemote() ? actions.copyResume(sessionId) : actions.resumeInTerminal(sessionId));
    const resumeCopyBtn = mkBtn(t('copyCmd'), false, () => actions.copyResume(sessionId));
    const archiveBtn = mkBtn(t('archive'), false, () => actions.archiveSingle(sessionId));
    footerEl.replaceChildren(resumeOpenBtn, resumeCopyBtn, archiveBtn);
    // Chat messages are rendered in two phases:
    // 1) latest chunk immediately for responsiveness
    // 2) older chunk in idle time, inserted once to avoid layout thrash
    messagesEl.replaceChildren();
    const chatContainer = createEl('div', {});
    chatContainer.style.cssText = 'display:grid;gap:12px;';
    // Build a global result map across all messages
    const globalResultMap = {};
    detail.messages.forEach((m) => {
        if (m.tools) {
            m.tools.filter((tool) => tool.name === '_result').forEach((tool) => { globalResultMap[tool.id] = tool; });
        }
    });
    // Prepare message descriptors (lightweight) without rendering.
    // Keep all original indices so Tantivy's message_index always maps correctly.
    const msgDescs = [];
    detail.messages.forEach((m, origIdx) => {
        const hasText = Boolean(m.content &&
            m.content !== '[Tool Result]' &&
            !m.content.startsWith('[Tool:'));
        const hasTools = Boolean(m.tools && m.tools.length > 0);
        msgDescs.push({ msg: m, hasText, hasTools, origIdx });
    });
    // Render a single message descriptor into DOM elements
    function renderMsgDesc(desc) {
        const { msg: m, hasText, hasTools } = desc;
        const isUser = m.type === 'user';
        const els = [];
        if (hasTools) {
            const toolEls = renderToolBlocks(m.tools || [], globalResultMap, createEl);
            if (toolEls.length > 0) {
                if (hasText) {
                    const bubbleInner = createEl('div', { className: 'md-content text-sm leading-relaxed break-words' });
                    bubbleInner.innerHTML = renderMarkdown(m.content || '');
                    const bubble = createEl('div', { className: (isUser ? 'bubble-user' : 'bubble-assistant') + ' px-4 py-2.5' }, [bubbleInner]);
                    bubble.style.justifySelf = isUser ? 'end' : 'start';
                    els.push(bubble);
                }
                toolEls.forEach(te => els.push(te));
                return els;
            }
        }
        if (!hasText)
            return els;
        const bubbleInner = createEl('div', { className: 'md-content text-sm leading-relaxed break-words' });
        bubbleInner.innerHTML = renderMarkdown(m.content || '');
        const bubble = createEl('div', { className: (isUser ? 'bubble-user' : 'bubble-assistant') + ' px-4 py-2.5' }, [bubbleInner]);
        bubble.style.justifySelf = isUser ? 'end' : 'start';
        els.push(bubble);
        return els;
    }
    function appendRenderedMsgDesc(desc, parentEl) {
        const els = renderMsgDesc(desc);
        if (els.length === 0) {
            // Keep a stable anchor even for visually empty messages so message_index lookup stays stable.
            const anchor = createEl('div', {});
            anchor.style.cssText = 'height:0;overflow:hidden;';
            anchor.setAttribute('data-msg-idx', String(desc.origIdx));
            parentEl.appendChild(anchor);
            return;
        }
        els.forEach(el => {
            el.setAttribute('data-msg-idx', String(desc.origIdx));
            parentEl.appendChild(el);
        });
    }
    // Render last 100 immediately, rest in background then insert in one batch
    const immediateCount = Math.min(100, msgDescs.length);
    const deferredCount = msgDescs.length - immediateCount;
    // Placeholder for deferred block (single element to replace later)
    const deferredPlaceholder = deferredCount > 0 ? createEl('div') : null;
    if (deferredPlaceholder)
        chatContainer.appendChild(deferredPlaceholder);
    // Immediate messages (bottom N)
    for (let i = deferredCount; i < msgDescs.length; i++) {
        appendRenderedMsgDesc(msgDescs[i], chatContainer);
    }
    messagesEl.appendChild(chatContainer);
    const spacer = createEl('div', {});
    spacer.style.height = '24px';
    messagesEl.appendChild(spacer);
    requestAnimationFrame(() => { messagesEl.scrollTop = messagesEl.scrollHeight; });
    // Background rendering into DocumentFragment, then one-shot insert
    const ctrl = { aborted: false };
    renderAbort = ctrl;
    allMessagesRendered = (deferredCount === 0);
    function flushDeferred() {
        if (allMessagesRendered)
            return;
        if (!deferredPlaceholder)
            return;
        const frag = document.createDocumentFragment();
        for (let i = 0; i < deferredCount; i++) {
            appendRenderedMsgDesc(msgDescs[i], frag);
        }
        const prevScrollTop = messagesEl.scrollTop;
        const prevScrollHeight = messagesEl.scrollHeight;
        deferredPlaceholder.replaceWith(frag);
        messagesEl.scrollTop = prevScrollTop + (messagesEl.scrollHeight - prevScrollHeight);
        allMessagesRendered = true;
    }
    // Expose flush for search/scroll
    window._flushRender = flushDeferred;
    if (deferredCount > 0) {
        // Render offscreen in idle chunks, then batch-insert
        let chunkIdx = 0;
        const deferredFrag = document.createDocumentFragment();
        function buildChunk(deadline) {
            if (ctrl.aborted)
                return;
            const end = Math.min(chunkIdx + 10, deferredCount);
            while (chunkIdx < end) {
                appendRenderedMsgDesc(msgDescs[chunkIdx], deferredFrag);
                chunkIdx++;
                if (deadline && deadline.timeRemaining && deadline.timeRemaining() < 2)
                    break;
            }
            if (chunkIdx < deferredCount) {
                if (typeof requestIdleCallback === 'function')
                    requestIdleCallback(buildChunk, { timeout: 100 });
                else
                    setTimeout(() => buildChunk(null), 16);
            }
            else {
                // All built — single DOM insert
                if (!ctrl.aborted && deferredPlaceholder && deferredPlaceholder.parentNode) {
                    const prevScrollTop = messagesEl.scrollTop;
                    const prevScrollHeight = messagesEl.scrollHeight;
                    deferredPlaceholder.replaceWith(deferredFrag);
                    messagesEl.scrollTop = prevScrollTop + (messagesEl.scrollHeight - prevScrollHeight);
                    allMessagesRendered = true;
                }
            }
        }
        if (typeof requestIdleCallback === 'function')
            requestIdleCallback(buildChunk, { timeout: 100 });
        else
            setTimeout(() => buildChunk(null), 16);
    }
}
initResizeHandle(byId);
// --- Init ---
byId('search').addEventListener('input', () => {
    fullTextSearch.onSearchInput();
});
byId('searchModeBtn').addEventListener('click', () => fullTextSearch.toggleMode());
byId('archiveSelectedBtn').addEventListener('click', () => actions.archiveSelected());
byId('newSessionBtn').addEventListener('click', async () => {
    const result = await invoke('start_new_session');
    if (result && !result.ok)
        actions.showToast(t('toastError') + (result.error || ''));
});
// Native menu events are emitted by Tauri and reflected into in-app state.
if (isTauri && tauriWindow.event) {
    const { listen } = tauriWindow.event;
    listen('menu-theme', (e) => {
        themePref = e.payload;
        localStorage.setItem('csm-theme', themePref);
        applyTheme(themePref);
    });
    listen('menu-terminal', (e) => {
        serverSettings.terminalApp = e.payload;
        invoke('update_settings', { terminalApp: e.payload });
    });
    listen('menu-lang', (e) => {
        lang = e.payload;
        localStorage.setItem('csm-lang', lang);
        applyI18n();
        renderSessions();
    });
    listen('search-index-ready', () => {
        fullTextSearch.setIndexReady(true);
        const indicator = byId('searchIndexIndicator');
        if (indicator)
            indicator.remove();
    });
    listen('menu-show-archived', (e) => {
        byId('showArchived').checked = e.payload;
        fetchSessions(e.payload);
    });
    listen('menu-zoom', (e) => {
        if (e.payload === 'in') {
            zoomLevel = Math.min(200, zoomLevel + 10);
        }
        else if (e.payload === 'out') {
            zoomLevel = Math.max(60, zoomLevel - 10);
        }
        else {
            zoomLevel = 100;
        }
        localStorage.setItem('csm-zoom', String(zoomLevel));
        applyZoom();
    });
}
// --- Zoom ---
let zoomLevel = parseFloat(localStorage.getItem('csm-zoom') || '100');
function applyZoom() {
    byId('detailPane').style.zoom = (zoomLevel / 100);
}
initKeyboardNavigation({
    byId,
    getSelectedSession: () => selectedSession,
});
applyTheme(themePref);
applyI18n();
initPreview();
applyZoom();
Promise.all([fetchSessions(), fetchProjects(), fetchSettings()]).then(() => {
    // Sync menu state with saved preferences
    invoke('sync_menu_state', {
        theme: themePref,
        terminal: serverSettings.terminalApp || 'Terminal',
        lang: lang,
        showArchived: false,
    });
});
// Auto-refresh every 30s to detect updated sessions
setInterval(async () => {
    const oldSessions = sessions.slice();
    // Fetch new data but don't re-render if in fulltext search mode
    sessions = await invoke('list_sessions', { includeArchived: byId('showArchived').checked }) || [];
    if (isFirstLoad) {
        sessions.forEach(s => { knownTimestamps[s.sessionId] = s.lastTimestamp; });
        isFirstLoad = false;
    }
    if (fullTextSearch.getMode() !== 'fulltext')
        renderSessions();
    // Incremental search index update for changed sessions
    const updatedIds = sessions
        .filter(s => {
        const old = oldSessions.find(o => o.sessionId === s.sessionId);
        return !old || old.lastTimestamp !== s.lastTimestamp;
    })
        .map(s => s.sessionId);
    if (updatedIds.length > 0) {
        invoke('update_search_index', { sessionIds: updatedIds });
    }
}, 30000);
