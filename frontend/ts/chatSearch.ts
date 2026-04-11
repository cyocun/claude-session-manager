import { getSearchTokenFallback, getSearchVariants } from './searchUtils.js';
import { setHighlight } from './dom.js';

export type ChatSearchFilter = 'all' | 'user' | 'assistant';

export type ChatSearchDeps = {
  byId: (id: string) => any;
  t: (key: string) => string;
  isAllMessagesRendered: () => boolean;
};

export function createChatSearchController(deps: ChatSearchDeps) {
  const { byId, t, isAllMessagesRendered } = deps;

  let chatHits: HTMLElement[] = [];
  let chatHitIndex = -1;
  let searchFilter: ChatSearchFilter = 'all';
  let scrollAnimId: number | null = null;

  function cancelScroll(): void {
    if (scrollAnimId !== null) {
      cancelAnimationFrame(scrollAnimId);
      scrollAnimId = null;
    }
  }

  function reset(): void {
    chatHits = [];
    chatHitIndex = -1;
    cancelScroll();
  }

  function smoothScrollTo(el: HTMLElement): void {
    cancelScroll();
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
      if (progress < 1) scrollAnimId = requestAnimationFrame(step);
      else scrollAnimId = null;
    }
    scrollAnimId = requestAnimationFrame(step);
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

  function getSearchRoots(messagesEl: HTMLElement): HTMLElement[] {
    const selectors: Record<ChatSearchFilter, string> = {
      all: '.bubble-user .md-content, .bubble-assistant .md-content',
      user: '.bubble-user .md-content',
      assistant: '.bubble-assistant .md-content',
    };
    return Array.from(
      messagesEl.querySelectorAll(selectors[searchFilter]),
    ) as HTMLElement[];
  }

  function getFilter(): ChatSearchFilter { return searchFilter; }
  function setFilter(f: ChatSearchFilter): void { searchFilter = f; }

  function collectMatches(
    roots: HTMLElement[],
    query: string,
  ): Array<{ node: Text; start: number; length: number }> {
    return collectMatchesForNeedles(roots, [query]);
  }

  function isVisibleTextNode(node: Text): boolean {
    // Walk up the tree to check all ancestors up to the root
    let el: HTMLElement | null = node.parentElement;
    while (el) {
      const tag = el.tagName;
      // Skip alt/title text from media elements
      if (tag === 'IMG' || tag === 'VIDEO' || tag === 'AUDIO' || tag === 'SOURCE') return false;
      // Skip hidden containers
      if (el.style.display === 'none' || el.style.visibility === 'hidden') return false;
      if (el.style.height === '0' || el.style.height === '0px') return false;
      if (el.offsetHeight === 0 && el.offsetWidth === 0) return false;
      // Stop at the search root (.md-content)
      if (el.classList.contains('md-content')) break;
      el = el.parentElement;
    }
    return true;
  }

  function collectMatchesForNeedles(
    roots: HTMLElement[],
    needles: string[],
  ): Array<{ node: Text; start: number; length: number }> {
    const matches: Array<{ node: Text; start: number; length: number }> = [];
    const uniqueNeedles = Array.from(new Set(needles.map((q) => q.trim()).filter(Boolean)));
    if (uniqueNeedles.length === 0) return matches;
    const lowerNeedles = uniqueNeedles.map((n) => n.toLocaleLowerCase());

    for (const root of roots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode() as Text | null;
      while (node) {
        if (!isVisibleTextNode(node)) { node = walker.nextNode() as Text | null; continue; }
        const text = node.textContent || '';
        const lower = text.toLocaleLowerCase();
        const nodeRanges: Array<{ start: number; length: number }> = [];
        for (const needle of lowerNeedles) {
          let idx = 0;
          while ((idx = lower.indexOf(needle, idx)) !== -1) {
            nodeRanges.push({ start: idx, length: needle.length });
            idx += needle.length;
          }
        }
        nodeRanges.sort((a, b) => (a.start - b.start) || (b.length - a.length));
        let nextAllowed = 0;
        for (const range of nodeRanges) {
          if (range.start < nextAllowed) continue;
          matches.push({ node, start: range.start, length: range.length });
          nextAllowed = range.start + range.length;
        }
        node = walker.nextNode() as Text | null;
      }
    }
    return matches;
  }

  function filterRootsContainingAllTokens(roots: HTMLElement[], tokens: string[]): HTMLElement[] {
    if (tokens.length <= 1) return roots;
    const lowerTokens = tokens.map((t) => t.toLocaleLowerCase());
    return roots.filter((root) => {
      const text = (root.textContent || '').toLocaleLowerCase();
      return lowerTokens.every((token) => text.includes(token));
    });
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

    const roots = getSearchRoots(messagesEl);
    const variants = getSearchVariants(q);
    let matches: Array<{ node: Text; start: number; length: number }> = [];
    for (const variant of variants) {
      if (variant.length < 2) continue;
      matches = collectMatches(roots, variant);
      if (matches.length > 0) break;
    }
    if (matches.length === 0) {
      const tokenFallback = getSearchTokenFallback(q).filter((token) => token.length >= 2);
      if (tokenFallback.length > 0) {
        const filteredRoots = filterRootsContainingAllTokens(roots, tokenFallback);
        matches = collectMatchesForNeedles(filteredRoots, tokenFallback);
      }
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
    cancelScroll();
    const messagesEl = byId('detailMessages') as HTMLElement;
    if (!isAllMessagesRendered() && window._flushRender) window._flushRender();
    const candidates = Array.from(
      messagesEl.querySelectorAll(`[data-msg-idx="${messageIndex}"]`),
    ) as HTMLElement[];
    if (candidates.length === 0) return;
    const el = candidates.find((c) => c.querySelector('mark.chat-hit'))
      || candidates.find((c) => c.classList.contains('bubble-user') || c.classList.contains('bubble-assistant'))
      || candidates.find((c) => c.offsetHeight > 0)
      || candidates[0];
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollIntoView({ block: 'center' });
      setHighlight(el, true);
    });

    // Sync chatHitIndex to the hit closest to the scrolled-to element
    if (chatHits.length > 0) {
      const targetTop = el.getBoundingClientRect().top;
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let i = 0; i < chatHits.length; i++) {
        const dist = Math.abs(chatHits[i].getBoundingClientRect().top - targetTop);
        if (dist < bestDist) { bestDist = dist; bestIdx = i; }
      }
      chatHitIndex = bestIdx;
      chatHits.forEach((h) => h.classList.remove('chat-hit-active'));
      chatHits[chatHitIndex].classList.add('chat-hit-active');
      byId('chatSearchCount').textContent = (chatHitIndex + 1) + '/' + chatHits.length;
    }
  }

  return {
    reset,
    doSearch,
    next,
    prev,
    scrollToMessageIndex,
    getFilter,
    setFilter,
  };
}
