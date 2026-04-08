import { getSearchTokenFallback, getSearchVariants } from './searchUtils.js';
export function createChatSearchController(deps) {
    const { byId, t, isAllMessagesRendered } = deps;
    let chatHits = [];
    let chatHitIndex = -1;
    function reset() {
        chatHits = [];
        chatHitIndex = -1;
    }
    function smoothScrollTo(el) {
        const container = byId('detailMessages');
        const target = el.offsetTop - container.offsetTop - container.clientHeight / 2 + el.clientHeight / 2;
        const start = container.scrollTop;
        const distance = target - start;
        const duration = 200;
        let startTime = null;
        function step(timestamp) {
            if (startTime === null)
                startTime = timestamp;
            const progress = Math.min((timestamp - startTime) / duration, 1);
            const ease = 1 - Math.pow(1 - progress, 3);
            container.scrollTop = start + distance * ease;
            if (progress < 1)
                requestAnimationFrame(step);
        }
        requestAnimationFrame(step);
    }
    function activateChatHit() {
        chatHits.forEach((h) => h.classList.remove('chat-hit-active'));
        if (chatHitIndex >= 0 && chatHitIndex < chatHits.length) {
            const hit = chatHits[chatHitIndex];
            hit.classList.add('chat-hit-active');
            smoothScrollTo(hit);
            byId('chatSearchCount').textContent = (chatHitIndex + 1) + '/' + chatHits.length;
        }
    }
    function getSearchRoots(messagesEl) {
        return Array.from(messagesEl.querySelectorAll('.bubble-user .md-content, .bubble-assistant .md-content'));
    }
    function collectMatches(roots, query) {
        return collectMatchesForNeedles(roots, [query]);
    }
    function collectMatchesForNeedles(roots, needles) {
        const matches = [];
        const uniqueNeedles = Array.from(new Set(needles.map((q) => q.trim()).filter(Boolean)));
        if (uniqueNeedles.length === 0)
            return matches;
        const lowerNeedles = uniqueNeedles.map((n) => n.toLocaleLowerCase());
        for (const root of roots) {
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            let node = walker.nextNode();
            while (node) {
                const text = node.textContent || '';
                const lower = text.toLocaleLowerCase();
                const nodeRanges = [];
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
                    if (range.start < nextAllowed)
                        continue;
                    matches.push({ node, start: range.start, length: range.length });
                    nextAllowed = range.start + range.length;
                }
                node = walker.nextNode();
            }
        }
        return matches;
    }
    function filterRootsContainingAllTokens(roots, tokens) {
        if (tokens.length <= 1)
            return roots;
        const lowerTokens = tokens.map((t) => t.toLocaleLowerCase());
        return roots.filter((root) => {
            const text = (root.textContent || '').toLocaleLowerCase();
            return lowerTokens.every((token) => text.includes(token));
        });
    }
    function doSearch() {
        if (!isAllMessagesRendered() && window._flushRender)
            window._flushRender();
        const q = byId('chatSearch').value.trim();
        const countEl = byId('chatSearchCount');
        const messagesEl = byId('detailMessages');
        messagesEl.querySelectorAll('mark.chat-hit').forEach((m) => {
            const parent = m.parentNode;
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
        let matches = [];
        for (const variant of variants) {
            if (variant.length < 2)
                continue;
            matches = collectMatches(roots, variant);
            if (matches.length > 0)
                break;
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
        chatHits = Array.from(messagesEl.querySelectorAll('mark.chat-hit'));
        countEl.textContent = chatHits.length ? chatHits.length + t('hits') : '0' + t('hits');
        if (chatHits.length > 1) {
            prevEl.classList.remove('hidden');
            nextEl.classList.remove('hidden');
        }
        else {
            prevEl.classList.add('hidden');
            nextEl.classList.add('hidden');
        }
        if (chatHits.length > 0) {
            chatHitIndex = 0;
            activateChatHit();
        }
    }
    function next() {
        if (!chatHits.length)
            return;
        chatHitIndex = (chatHitIndex + 1) % chatHits.length;
        activateChatHit();
    }
    function prev() {
        if (!chatHits.length)
            return;
        chatHitIndex = (chatHitIndex - 1 + chatHits.length) % chatHits.length;
        activateChatHit();
    }
    function scrollToMessageIndex(messageIndex) {
        const messagesEl = byId('detailMessages');
        if (!isAllMessagesRendered() && window._flushRender)
            window._flushRender();
        const candidates = Array.from(messagesEl.querySelectorAll(`[data-msg-idx="${messageIndex}"]`));
        if (candidates.length === 0)
            return;
        const el = candidates.find((c) => c.querySelector('mark.chat-hit'))
            || candidates.find((c) => c.classList.contains('bubble-user') || c.classList.contains('bubble-assistant'))
            || candidates.find((c) => c.offsetHeight > 0)
            || candidates[0];
        if (!el)
            return;
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
