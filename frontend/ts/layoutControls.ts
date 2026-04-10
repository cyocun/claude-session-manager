import { setHighlight } from './dom.js';

export function initResizeHandle(byId: (id: string) => any): void {
  const handle = byId('resizeHandle') as HTMLElement;
  let dragging = false;

  handle.addEventListener('mousedown', (e: MouseEvent) => {
    e.preventDefault();
    dragging = true;
    handle.classList.add('active');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e: MouseEvent) => {
    if (!dragging) return;
    const clamped = Math.max(200, Math.min(500, e.clientX));
    document.body.style.gridTemplateColumns = `${clamped}px 1px 1fr`;
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('active');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
}

export type KeyboardNavDeps = {
  byId: (id: string) => any;
  getSelectedSession: () => string | null;
};

export function initKeyboardNavigation(deps: KeyboardNavDeps): void {
  const { byId, getSelectedSession } = deps;
  let focusPane: 'left' | 'right' = 'left';
  let focusedBubbleIdx = -1;

  function clearBubbleFocus(): void {
    const prev = document.querySelector('.bubble-focused');
    if (prev) {
      prev.classList.remove('bubble-focused');
      setHighlight(prev as HTMLElement, false);
    }
    focusedBubbleIdx = -1;
  }

  function getBubbles(): HTMLElement[] {
    return Array.from(document.querySelectorAll('#detailMessages .bubble-user, #detailMessages .bubble-assistant')) as HTMLElement[];
  }

  function focusBubble(idx: number): void {
    const bubbles = getBubbles();
    if (bubbles.length === 0) return;
    clearBubbleFocus();
    focusedBubbleIdx = Math.max(0, Math.min(idx, bubbles.length - 1));
    const bubble = bubbles[focusedBubbleIdx];
    bubble.classList.add('bubble-focused');
    setHighlight(bubble, true);
    bubble.scrollIntoView({ block: 'nearest' });
  }

  byId('sessionListPane').addEventListener('click', () => {
    focusPane = 'left';
    clearBubbleFocus();
  });
  byId('detailPane').addEventListener('click', () => {
    if (getSelectedSession()) focusPane = 'right';
  });

  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (focusPane === 'right' && getSelectedSession()) {
        const bubbles = getBubbles();
        if (bubbles.length === 0) return;
        if (e.key === 'ArrowDown') {
          focusBubble(focusedBubbleIdx < 0 ? 0 : focusedBubbleIdx + 1);
        } else {
          focusBubble(focusedBubbleIdx < 0 ? bubbles.length - 1 : focusedBubbleIdx - 1);
        }
      } else {
        const items = Array.from(document.querySelectorAll('.session-item')) as HTMLElement[];
        if (items.length === 0) return;
        const currentIdx = items.findIndex((el) => el.dataset.id === getSelectedSession());
        const nextIdx = e.key === 'ArrowDown'
          ? (currentIdx < 0 ? 0 : Math.min(currentIdx + 1, items.length - 1))
          : (currentIdx < 0 ? 0 : Math.max(currentIdx - 1, 0));
        items[nextIdx].click();
        items[nextIdx].scrollIntoView({ block: 'nearest' });
      }
    }

    if (e.key === 'Tab' && getSelectedSession()) {
      e.preventDefault();
      if (focusPane === 'left') {
        focusPane = 'right';
      } else {
        focusPane = 'left';
        clearBubbleFocus();
      }
    }
  });
}
