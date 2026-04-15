// Search mode view controller.
//
// Phase 1 of the search-experience redesign: renders full-text search results
// into a dedicated right-hand pane (#searchResultPane) instead of hijacking the
// sidebar session list. The pane has a result list on the left and a context
// preview on the right. Entering / exiting search mode preserves the
// previously-selected session so that Esc / empty query returns the user to
// whatever they were looking at before.
import { createEl, setHighlight } from './dom.js';
import { sanitizeSnippet } from './searchUtils.js';
const PREVIEW_WINDOW = 3;
export function createSearchView(deps) {
    const { byId, byIdOptional, t, invoke, getSessions, projectDisplayName, openSession, onRequestExit, } = deps;
    let active = false;
    let rows = [];
    let activeIdx = -1;
    let previewSeq = 0;
    let lastPreviewSessionId = null;
    let lastPreviewMessageIndex = -1;
    let currentQuery = '';
    function isActive() {
        return active;
    }
    function enter() {
        if (active)
            return;
        active = true;
        const detailPane = byIdOptional('detailPane');
        const searchPane = byId('searchResultPane');
        // Stash detail's prior display so exit() can restore it without re-render.
        if (detailPane) {
            detailPane.dataset.preSearchDisplay = detailPane.style.display || 'grid';
            detailPane.style.display = 'none';
        }
        searchPane.style.display = 'grid';
        renderEmptyPreview();
    }
    function exit() {
        if (!active)
            return;
        active = false;
        const detailPane = byIdOptional('detailPane');
        const searchPane = byId('searchResultPane');
        searchPane.style.display = 'none';
        if (detailPane) {
            const prior = detailPane.dataset.preSearchDisplay || 'grid';
            detailPane.style.display = prior;
            delete detailPane.dataset.preSearchDisplay;
        }
        rows = [];
        activeIdx = -1;
        lastPreviewSessionId = null;
        lastPreviewMessageIndex = -1;
    }
    function renderEmptyPreview() {
        const pane = byId('searchPreviewPane');
        pane.replaceChildren();
        const empty = createEl('div', {
            className: 'search-preview-empty',
            textContent: t('searchPreviewEmpty'),
        });
        pane.appendChild(empty);
    }
    function updateSummary(results, mode, indexReady, query) {
        const summary = byId('searchResultSummary');
        summary.replaceChildren();
        const queryLabel = createEl('span', {});
        queryLabel.style.cssText = 'color:var(--text);font-weight:500;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        queryLabel.textContent = query ? `\u201C${query}\u201D` : '';
        const sep = createEl('span', { textContent: '\u00B7' });
        sep.style.cssText = 'color:var(--text-faint);';
        let countText;
        if (!indexReady) {
            countText = t('searchIndexing');
        }
        else if (results.length === 0) {
            countText = mode === 'similar' ? t('similarNoResults') : t('searchNoResults');
        }
        else {
            countText = t('searchResultsSummary').replace('{n}', String(results.length));
        }
        const countEl = createEl('span', { textContent: countText });
        countEl.style.cssText = 'color:var(--text-secondary);';
        if (query) {
            summary.append(queryLabel, sep, countEl);
        }
        else {
            summary.append(countEl);
        }
    }
    function groupResults(results) {
        const order = [];
        const map = {};
        for (const hit of results) {
            if (!map[hit.sessionId]) {
                map[hit.sessionId] = { sessionId: hit.sessionId, project: hit.project, hits: [] };
                order.push(hit.sessionId);
            }
            map[hit.sessionId].hits.push(hit);
        }
        return order.map((id) => map[id]);
    }
    function renderResults(results, mode, indexReady, query) {
        currentQuery = query;
        updateSummary(results, mode, indexReady, query);
        const list = byId('searchResultList');
        list.replaceChildren();
        rows = [];
        activeIdx = -1;
        if (results.length === 0) {
            const msg = createEl('div', {
                className: 'text-xs',
                textContent: indexReady
                    ? (mode === 'similar' ? t('similarNoResults') : t('searchNoResults'))
                    : t('searchIndexing'),
            });
            msg.style.cssText = 'color:var(--text-faint);padding:24px 16px;text-align:center;';
            list.appendChild(msg);
            renderEmptyPreview();
            return;
        }
        const titleMap = new Map();
        getSessions().forEach((s) => titleMap.set(s.sessionId, s.firstDisplay));
        const grouped = groupResults(results);
        for (const group of grouped) {
            const header = createEl('div', { className: 'search-result-session-header' });
            const title = titleMap.get(group.sessionId) || group.sessionId.slice(0, 8);
            const titleEl = createEl('span', { className: 'srsh-title', textContent: title });
            titleEl.title = `${projectDisplayName(group.project)} · ${group.sessionId}`;
            const countEl = createEl('span', {
                className: 'srsh-count',
                textContent: `${group.hits.length}${t('hits')}`,
            });
            header.append(titleEl, countEl);
            list.appendChild(header);
            for (const hit of group.hits) {
                const row = buildResultRow(hit);
                list.appendChild(row);
                rows.push({ el: row, hit });
            }
        }
        setActiveIndex(0, { scroll: false });
    }
    function buildResultRow(hit) {
        const row = createEl('div', {
            className: `search-result-row ${hit.msgType === 'user' ? 'user' : 'assistant'}`,
        });
        const role = createEl('div', {
            className: 'srr-role',
            textContent: hit.msgType === 'user' ? 'USER' : 'AI',
        });
        const main = createEl('div', { className: 'srr-main' });
        const snippet = createEl('div', { className: 'srr-snippet' });
        snippet.innerHTML = sanitizeSnippet(hit.snippet);
        main.append(snippet);
        const meta = createEl('div', { className: 'srr-meta' });
        if (typeof hit.timestamp === 'number' && hit.timestamp > 0) {
            const dt = new Date(hit.timestamp);
            meta.textContent = dt.toLocaleDateString();
            meta.title = dt.toLocaleString();
        }
        row.append(role, main, meta);
        row.addEventListener('mouseenter', () => {
            // Hover-preview to the row even if it's not the keyboard-active one;
            // this matches macOS Mail search UX where the cursor and hover are
            // independent highlights.
            void loadPreviewFor(hit);
        });
        row.addEventListener('click', () => {
            const idx = rows.findIndex((r) => r.el === row);
            if (idx >= 0)
                setActiveIndex(idx, { scroll: false });
        });
        row.addEventListener('dblclick', () => {
            void openSession(hit.sessionId, hit.messageIndex);
        });
        return row;
    }
    function setActiveIndex(idx, opts = {}) {
        if (rows.length === 0) {
            activeIdx = -1;
            return;
        }
        const next = Math.max(0, Math.min(idx, rows.length - 1));
        if (activeIdx >= 0 && activeIdx < rows.length) {
            rows[activeIdx].el.classList.remove('active');
            setHighlight(rows[activeIdx].el, false);
        }
        activeIdx = next;
        const row = rows[activeIdx];
        row.el.classList.add('active');
        setHighlight(row.el, true);
        if (opts.scroll) {
            row.el.scrollIntoView({ block: 'nearest' });
        }
        void loadPreviewFor(row.hit);
    }
    async function loadPreviewFor(hit) {
        if (hit.sessionId === lastPreviewSessionId && hit.messageIndex === lastPreviewMessageIndex)
            return;
        lastPreviewSessionId = hit.sessionId;
        lastPreviewMessageIndex = hit.messageIndex;
        const seq = ++previewSeq;
        const pane = byId('searchPreviewPane');
        pane.replaceChildren();
        const loading = createEl('div', { className: 'search-preview-empty', textContent: t('loadingContext') });
        pane.appendChild(loading);
        let res = null;
        try {
            res = await invoke('get_session_messages_around', {
                sessionId: hit.sessionId,
                messageIndex: hit.messageIndex,
                window: PREVIEW_WINDOW,
            });
        }
        catch (err) {
            console.warn('[search-view] preview fetch failed', err);
        }
        if (seq !== previewSeq)
            return;
        if (!res) {
            pane.replaceChildren();
            const errEl = createEl('div', { className: 'search-preview-empty', textContent: t('toastError') });
            pane.appendChild(errEl);
            return;
        }
        renderPreview(pane, hit, res);
    }
    function renderPreview(pane, hit, res) {
        pane.replaceChildren();
        const header = createEl('div', { className: 'search-preview-header' });
        const title = createEl('span', {
            className: 'sph-title',
            textContent: `${projectDisplayName(res.project)} \u00B7 ${getSessions().find((s) => s.sessionId === res.sessionId)?.firstDisplay || res.sessionId.slice(0, 8)}`,
        });
        const openBtn = createEl('button', {
            className: 'sph-open',
            textContent: t('searchOpenSession'),
            onClick: () => {
                void openSession(hit.sessionId, hit.messageIndex);
            },
        });
        header.append(title, openBtn);
        pane.appendChild(header);
        const body = createEl('div', { className: 'search-preview-body' });
        pane.appendChild(body);
        const before = res.startIndex;
        if (before > 0) {
            const hint = createEl('div', {
                className: 'search-preview-hint',
                textContent: t('searchPreviewMoreBefore').replace('{n}', String(before)),
            });
            body.appendChild(hint);
        }
        res.messages.forEach((msg, i) => {
            const isFocus = i === res.focusOffset;
            const role = (msg.type || 'system').toLowerCase();
            const msgEl = createEl('div', {
                className: `search-preview-msg ${role}${isFocus ? ' focus' : ''}`,
            });
            const roleEl = createEl('div', {
                className: 'spm-role',
                textContent: role,
            });
            const textEl = createEl('div', {});
            const content = (msg.content || '').trim();
            if (isFocus && currentQuery) {
                textEl.innerHTML = highlightQuery(content, currentQuery);
            }
            else {
                textEl.textContent = content;
            }
            msgEl.append(roleEl, textEl);
            body.appendChild(msgEl);
        });
        const afterRemaining = res.total - (res.startIndex + res.messages.length);
        if (afterRemaining > 0) {
            const hint = createEl('div', {
                className: 'search-preview-hint',
                textContent: t('searchPreviewMoreAfter').replace('{n}', String(afterRemaining)),
            });
            body.appendChild(hint);
        }
    }
    function highlightQuery(content, query) {
        const tokens = query.split(/\s+/).filter((s) => s.length >= 2);
        // Escape content first, then inject <mark> around matches. Using textContent
        // on a helper element avoids dealing with HTML entity encoding manually.
        const helper = document.createElement('div');
        helper.textContent = content;
        let html = helper.innerHTML;
        for (const token of tokens) {
            const pat = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            try {
                const re = new RegExp(`(${pat})`, 'gi');
                html = html.replace(re, '<mark>$1</mark>');
            }
            catch {
                // ignore invalid regex
            }
        }
        return html;
    }
    function moveActive(delta) {
        if (rows.length === 0)
            return;
        const next = activeIdx < 0 ? 0 : activeIdx + delta;
        setActiveIndex(next, { scroll: true });
    }
    function confirmActive() {
        if (activeIdx < 0 || activeIdx >= rows.length)
            return;
        const hit = rows[activeIdx].hit;
        void openSession(hit.sessionId, hit.messageIndex);
    }
    function handleKeyDown(e) {
        if (!active)
            return false;
        // When the user is typing in the global search input, Up/Down should still
        // navigate the result list so they can flow from query -> result without
        // leaving the keyboard.
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            moveActive(1);
            return true;
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            moveActive(-1);
            return true;
        }
        if (e.key === 'Enter') {
            // Don't swallow Enter unless we actually have something to open.
            if (rows.length === 0)
                return false;
            e.preventDefault();
            confirmActive();
            return true;
        }
        if (e.key === 'Escape') {
            // Let the shortcut layer clear the input; we just signal that exit is
            // desired so app.ts can restore the previous view state.
            onRequestExit();
            return false;
        }
        return false;
    }
    return {
        isActive,
        enter,
        exit,
        renderResults,
        handleKeyDown,
    };
}
