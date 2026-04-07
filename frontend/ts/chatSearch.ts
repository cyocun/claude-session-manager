export type ChatSearchDeps = {
  byId: (id: string) => any;
  t: (key: string) => string;
  isAllMessagesRendered: () => boolean;
};

export function createChatSearchController(deps: ChatSearchDeps) {
  const { byId, t, isAllMessagesRendered } = deps;

  let chatHits: HTMLElement[] = [];
  let chatHitIndex = -1;

  function reset(): void {
    chatHits = [];
    chatHitIndex = -1;
  }

  function smoothScrollTo(el: HTMLElement): void {
    const container = byId('detailMessages') as HTMLElement;
    const target = el.offsetTop - container.offsetTop - container.clientHeight / 2 + el.clientHeight / 2;
    const start = container.scrollTop;
    const distance = target - start;
    const duration = 200;
    let startTime: number | null = null;

    function step(timestamp: number) {
      if (startTime === null) startTime = timestamp;
      const progress = Math.min((timestamp - startTime) / duration, 1);
      const ease = 1 - Math.pow(1 - progress, 3);
      container.scrollTop = start + distance * ease;
      if (progress < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function activateChatHit(): void {
    chatHits.forEach((h) => h.classList.remove('chat-hit-active'));
    if (chatHitIndex >= 0 && chatHitIndex < chatHits.length) {
      const hit = chatHits[chatHitIndex];
      hit.classList.add('chat-hit-active');
      smoothScrollTo(hit);
      byId('chatSearchCount').textContent = (chatHitIndex + 1) + '/' + chatHits.length;
    }
  }

  function doSearch(): void {
    if (!isAllMessagesRendered() && window._flushRender) window._flushRender();

    const q = (byId('chatSearch') as HTMLInputElement).value.trim();
    const countEl = byId('chatSearchCount');
    const messagesEl = byId('detailMessages') as HTMLElement;
    messagesEl.querySelectorAll('mark.chat-hit').forEach((m) => {
      const parent = m.parentNode as Node;
      parent.replaceChild(document.createTextNode(m.textContent || ''), m);
      parent.normalize();
    });
    reset();

    const prevEl = byId('chatSearchPrev');
    const nextEl = byId('chatSearchNext');
    if (!q) {
      countEl.textContent = '';
      prevEl.classList.add('hidden');
      nextEl.classList.add('hidden');
      return;
    }

    const walker = document.createTreeWalker(messagesEl, NodeFilter.SHOW_TEXT);
    const matches: Array<{ node: Text; start: number; length: number }> = [];
    let node = walker.nextNode() as Text | null;
    while (node) {
      const text = node.textContent || '';
      const lower = text.toLowerCase();
      const qLower = q.toLowerCase();
      let idx = 0;
      while ((idx = lower.indexOf(qLower, idx)) !== -1) {
        matches.push({ node, start: idx, length: q.length });
        idx += q.length;
      }
      node = walker.nextNode() as Text | null;
    }

    for (let i = matches.length - 1; i >= 0; i--) {
      const m = matches[i];
      const range = document.createRange();
      range.setStart(m.node, m.start);
      range.setEnd(m.node, m.start + m.length);
      const mark = document.createElement('mark');
      mark.className = 'chat-hit';
      range.surroundContents(mark);
    }

    chatHits = Array.from(messagesEl.querySelectorAll('mark.chat-hit')) as HTMLElement[];
    countEl.textContent = chatHits.length ? chatHits.length + t('hits') : '0' + t('hits');
    if (chatHits.length > 1) {
      prevEl.classList.remove('hidden');
      nextEl.classList.remove('hidden');
    } else {
      prevEl.classList.add('hidden');
      nextEl.classList.add('hidden');
    }
    if (chatHits.length > 0) {
      chatHitIndex = 0;
      activateChatHit();
    }
  }

  function next(): void {
    if (!chatHits.length) return;
    chatHitIndex = (chatHitIndex + 1) % chatHits.length;
    activateChatHit();
  }

  function prev(): void {
    if (!chatHits.length) return;
    chatHitIndex = (chatHitIndex - 1 + chatHits.length) % chatHits.length;
    activateChatHit();
  }

  function scrollToMessageIndex(messageIndex: number): void {
    const messagesEl = byId('detailMessages') as HTMLElement;
    if (!isAllMessagesRendered() && window._flushRender) window._flushRender();
    const el = messagesEl.querySelector(`[data-msg-idx="${messageIndex}"]`) as HTMLElement | null;
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.style.outline = '2px solid var(--accent)';
    el.style.outlineOffset = '2px';
    el.style.borderRadius = '12px';
    setTimeout(() => {
      el.style.outline = '';
      el.style.outlineOffset = '';
    }, 2000);
  }

  return {
    reset,
    doSearch,
    next,
    prev,
    scrollToMessageIndex,
  };
}
