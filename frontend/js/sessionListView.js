export function hasSessionIdentityOrderChanged(prev, next, sevenDaysMs, now = Date.now()) {
    if (prev.length !== next.length)
        return true;
    for (let i = 0; i < prev.length; i++) {
        const a = prev[i];
        const b = next[i];
        if (a.sessionId !== b.sessionId || a.project !== b.project)
            return true;
        const wasRecent = now - a.lastTimestamp < sevenDaysMs;
        const isRecent = now - b.lastTimestamp < sevenDaysMs;
        if (wasRecent !== isRecent)
            return true;
    }
    return false;
}
function updateMetaBadge(metaDiv, selector, className, text) {
    let el = metaDiv.querySelector(selector);
    if (!text) {
        el?.remove();
        return;
    }
    if (!el) {
        el = document.createElement('span');
        el.className = className;
        el.style.color = 'var(--text-faint)';
        metaDiv.appendChild(el);
    }
    el.textContent = text;
}
function ensureUpdatedDot(item, shouldShow) {
    const row = item.querySelector('.session-row');
    if (!row)
        return;
    const existing = row.querySelector('.session-updated-dot');
    if (shouldShow) {
        if (!existing) {
            const dot = document.createElement('span');
            dot.className = 'session-updated-dot flex-shrink-0 mt-1.5';
            dot.style.cssText = 'width:7px;height:7px;border-radius:50%;background:var(--updated-dot);';
            row.insertBefore(dot, row.children[1] || null);
        }
        row.style.gridTemplateColumns = 'auto auto 1fr';
    }
    else {
        existing?.remove();
        row.style.gridTemplateColumns = 'auto 1fr';
    }
}
export function patchSessionListItems(deps) {
    const { root, sessions, selectedIds, selectedSession, archivedLabel, msgSuffix, formatTimeAgo, formatDateTitle, isUpdatedSession } = deps;
    const items = Array.from(root.querySelectorAll('.session-item'));
    if (items.length !== sessions.length)
        return false;
    for (let i = 0; i < sessions.length; i++) {
        const session = sessions[i];
        const item = items[i];
        if (item.dataset.id !== session.sessionId)
            return false;
        const first = item.querySelector('.session-first');
        if (first)
            first.textContent = session.firstDisplay;
        const last = item.querySelector('.session-last');
        const hasLast = Boolean(session.lastDisplay && session.lastDisplay !== session.firstDisplay);
        if (hasLast) {
            if (last)
                last.textContent = session.lastDisplay || '';
            else {
                const textDiv = item.querySelector('.session-text');
                if (textDiv) {
                    const el = document.createElement('p');
                    el.className = 'session-last text-xs leading-snug truncate mt-0.5';
                    el.style.color = 'var(--text-muted)';
                    el.textContent = session.lastDisplay || '';
                    textDiv.insertBefore(el, textDiv.querySelector('.session-meta'));
                }
            }
        }
        else {
            last?.remove();
        }
        const metaTime = item.querySelector('.session-meta-time');
        if (metaTime)
            metaTime.textContent = formatTimeAgo(session.lastTimestamp);
        const metaCount = item.querySelector('.session-meta-count');
        if (metaCount)
            metaCount.textContent = `${session.messageCount}${msgSuffix}`;
        const metaDiv = item.querySelector('.session-meta');
        if (metaDiv) {
            updateMetaBadge(metaDiv, '.session-meta-archived', 'session-meta-archived text-[10px] flex-shrink-0', session.archived ? archivedLabel : '');
        }
        const checkbox = item.querySelector('.session-check');
        if (checkbox)
            checkbox.checked = selectedIds.has(session.sessionId);
        const updated = isUpdatedSession(session);
        ensureUpdatedDot(item, updated);
        const defaultBg = updated ? 'var(--updated-bg)' : 'transparent';
        item.dataset.defaultBg = defaultBg;
        const isActive = selectedSession === session.sessionId;
        if (isActive) {
            item.style.borderColor = 'var(--item-active-border)';
            item.style.background = 'var(--item-active)';
        }
        else {
            item.style.borderColor = 'transparent';
            item.style.background = defaultBg;
        }
        item.style.opacity = session.archived ? '0.4' : '';
        item.title = formatDateTitle(session.lastTimestamp);
        item.classList.toggle('session-item-active', isActive);
    }
    return true;
}
