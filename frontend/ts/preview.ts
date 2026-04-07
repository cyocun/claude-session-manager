import { createEl } from './dom.js';
import { invoke } from './tauri.js';

let previewCache: Record<string, any> = {};
let previewEl: HTMLDivElement | null = null;
let previewTimer: ReturnType<typeof setTimeout> | null = null;
let previewSessionId: string | null = null;
let previewAnchorRect: DOMRect | null = null;

function clearTimer(): void {
  if (previewTimer !== null) {
    clearTimeout(previewTimer);
    previewTimer = null;
  }
}

function positionPreview(): void {
  if (!previewAnchorRect || !previewEl) return;
  const listPane = document.getElementById('sessionListPane') as HTMLElement | null;
  if (!listPane) return;

  const x = listPane.getBoundingClientRect().right + 12;
  previewEl.style.right = '10px';
  previewEl.style.left = 'auto';
  previewEl.style.top = '0px';
  previewEl.style.visibility = 'hidden';
  const actualH = previewEl.offsetHeight;
  previewEl.style.visibility = '';
  const anchorMid = previewAnchorRect.top + previewAnchorRect.height / 2;
  const finalY = Math.max(10, Math.min(anchorMid - actualH / 2, window.innerHeight - actualH - 10));
  previewEl.style.top = finalY + 'px';
  const arrowTop = Math.max(20, Math.min(anchorMid - finalY, actualH - 20));
  previewEl.style.setProperty('--arrow-top', arrowTop + 'px');
  void x;
}

function renderPreview(detail: any): void {
  if (!previewEl) return;
  previewEl.classList.remove('hidden');
  const inner = document.createElement('div');
  inner.className = 'session-preview-inner';

  const msgs = detail.messages.filter((m: any) =>
    m.content && m.content !== '[Tool Result]' && !m.content.startsWith('[Tool:')
  );
  const recent = msgs.slice(-20);

  recent.forEach((m: any) => {
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

function showPreview(sessionId: string, anchorRect: DOMRect): void {
  if (!previewEl) return;
  if (previewSessionId === sessionId && !previewEl.classList.contains('hidden')) return;
  if (!anchorRect || (anchorRect.right === 0 && anchorRect.top === 0)) return;
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
    previewCache[sessionId] = detail;
    if (previewSessionId === sessionId) renderPreview(detail);
  });
}

export function hidePreview(): void {
  previewSessionId = null;
  if (previewEl) previewEl.classList.add('hidden');
}

export function getPreviewDetailCached(sessionId: string): any | null {
  return previewCache[sessionId] ?? null;
}

export function setPreviewDetailCached(sessionId: string, detail: any): void {
  previewCache[sessionId] = detail;
}

export function schedulePreviewShow(sessionId: string, anchorRect: DOMRect): void {
  clearTimer();
  previewTimer = setTimeout(() => {
    showPreview(sessionId, anchorRect);
  }, 150);
}

export function schedulePreviewHide(): void {
  clearTimer();
  previewTimer = setTimeout(hidePreview, 200);
}

export function initPreview(): void {
  previewEl = document.createElement('div');
  previewEl.className = 'session-preview hidden';
  previewEl.addEventListener('mouseenter', () => clearTimer());
  previewEl.addEventListener('mouseleave', () => {
    previewTimer = setTimeout(hidePreview, 200);
  });
  document.body.appendChild(previewEl);
}
