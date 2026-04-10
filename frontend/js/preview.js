import { createEl } from './dom.js';
import { invoke } from './tauri.js';
let previewCache = {};
let previewEl = null;
let previewTimer = null;
let previewSessionId = null;
let previewAnchorRect = null;
const PREVIEW_CACHE_MAX = 200;
// Activation state: first hover needs 500ms, then instant until idle 1s outside list
let previewActivated = false;
let deactivateTimer = null;
function trimPreviewCache() {
    const keys = Object.keys(previewCache);
    const overflow = keys.length - PREVIEW_CACHE_MAX;
    if (overflow <= 0)
        return;
    for (let i = 0; i < overflow; i++) {
        delete previewCache[keys[i]];
    }
}
function clearTimer() {
    if (previewTimer !== null) {
        clearTimeout(previewTimer);
        previewTimer = null;
    }
}
function clearDeactivateTimer() {
    if (deactivateTimer !== null) {
        clearTimeout(deactivateTimer);
        deactivateTimer = null;
    }
}
function positionPreview() {
    if (!previewAnchorRect || !previewEl)
        return;
    const listPane = document.getElementById('sessionListPane');
    if (!listPane)
        return;
    const listRight = listPane.getBoundingClientRect().right;
    // Position to the right of the left column
    previewEl.style.left = (listRight + 8) + 'px';
    previewEl.style.right = 'auto';
    previewEl.style.top = '0px';
    previewEl.style.visibility = 'hidden';
    const actualH = previewEl.offsetHeight;
    previewEl.style.visibility = '';
    const anchorMid = previewAnchorRect.top + previewAnchorRect.height / 2;
    const finalY = Math.max(10, Math.min(anchorMid - actualH / 2, window.innerHeight - actualH - 10));
    previewEl.style.top = finalY + 'px';
    const arrowTop = Math.max(20, Math.min(anchorMid - finalY, actualH - 20));
    previewEl.style.setProperty('--arrow-top', arrowTop + 'px');
}
function renderPreview(detail) {
    if (!previewEl)
        return;
    previewEl.classList.remove('hidden');
    const inner = document.createElement('div');
    inner.className = 'session-preview-inner';
    const msgs = detail.messages.filter((m) => m.content && m.content !== '[Tool Result]' && !m.content.startsWith('[Tool:'));
    const recent = msgs.slice(-20);
    recent.forEach((m) => {
        const isUser = m.type === 'user';
        const div = document.createElement('div');
        div.className = 'preview-msg ' + (isUser ? 'preview-user' : 'preview-assistant');
        div.textContent = m.content.slice(0, 120) + (m.content.length > 120 ? '...' : '');
        inner.appendChild(div);
    });
    previewEl.replaceChildren(inner);
    positionPreview();
    inner.scrollTop = inner.scrollHeight;
}
function showPreview(sessionId, anchorRect) {
    if (!previewEl)
        return;
    if (previewSessionId === sessionId && !previewEl.classList.contains('hidden'))
        return;
    if (!anchorRect || (anchorRect.right === 0 && anchorRect.top === 0))
        return;
    previewSessionId = sessionId;
    previewAnchorRect = anchorRect;
    if (previewCache[sessionId]) {
        renderPreview(previewCache[sessionId]);
        return;
    }
    previewEl.classList.remove('hidden');
    const loadingInner = createEl('div', { className: 'session-preview-inner' });
    loadingInner.appendChild(createEl('span', { className: 'text-xs', textContent: '...' }));
    previewEl.replaceChildren(loadingInner);
    positionPreview();
    invoke('get_session_detail', { sessionId }).then((detail) => {
        if (!detail)
            return;
        previewCache[sessionId] = detail;
        trimPreviewCache();
        if (previewSessionId === sessionId)
            renderPreview(detail);
    });
}
export function hidePreview() {
    previewSessionId = null;
    if (previewEl)
        previewEl.classList.add('hidden');
}
export function getPreviewDetailCached(sessionId) {
    return previewCache[sessionId] ?? null;
}
export function setPreviewDetailCached(sessionId, detail) {
    if (!detail)
        return;
    previewCache[sessionId] = detail;
    trimPreviewCache();
}
export function invalidatePreviewCache(sessionIds) {
    for (const id of sessionIds) {
        delete previewCache[id];
    }
}
export function schedulePreviewShow(sessionId, anchorRect) {
    clearTimer();
    clearDeactivateTimer();
    const delay = previewActivated ? 0 : 500;
    previewTimer = setTimeout(() => {
        previewActivated = true;
        showPreview(sessionId, anchorRect);
    }, delay);
}
export function schedulePreviewHide() {
    clearTimer();
    previewTimer = setTimeout(hidePreview, 200);
    // Start deactivation timer: if no session hovered for 1s, reset to initial state
    clearDeactivateTimer();
    deactivateTimer = setTimeout(() => {
        previewActivated = false;
    }, 1000);
}
export function initPreview() {
    previewEl = document.createElement('div');
    previewEl.className = 'session-preview hidden';
    previewEl.addEventListener('mouseenter', () => {
        clearTimer();
        clearDeactivateTimer();
    });
    previewEl.addEventListener('mouseleave', () => {
        previewTimer = setTimeout(hidePreview, 200);
        clearDeactivateTimer();
        deactivateTimer = setTimeout(() => {
            previewActivated = false;
        }, 1000);
    });
    document.body.appendChild(previewEl);
}
