import { getSearchTokenFallback, getSearchVariants, isVisibleTextNode, filterRootsContainingAllTokens } from './searchUtils.js';
import { createEl, setHighlight } from './dom.js';
export function createChatSearchController(deps) {
    const { byId, t, isAllMessagesRendered } = deps;
    let chatHits = [];
    let chatHitIndex = -1;
    let searchFilter = 'all';
    let scrollAnimId = null;
    function cancelScroll() {
        if (scrollAnimId !== null) {
            cancelAnimationFrame(scrollAnimId);
            scrollAnimId = null;
        }
    }
    function reset() {
        chatHits = [];
        chatHitIndex = -1;
        cancelScroll();
    }
    function clear() {
        const chatInput = document.getElementById('chatSearch');
        if (!chatInput || !chatInput.value)
            return;
        chatInput.value = '';
        doSearch();
    }
    function smoothScrollTo(el) {
        cancelScroll();
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
                scrollAnimId = requestAnimationFrame(step);
            else
                scrollAnimId = null;
        }
        scrollAnimId = requestAnimationFrame(step);
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
        const selectors = {
            all: '.bubble-user .md-content, .bubble-assistant .md-content',
            user: '.bubble-user .md-content',
            assistant: '.bubble-assistant .md-content',
        };
        return Array.from(messagesEl.querySelectorAll(selectors[searchFilter]));
    }
    function getFilter() { return searchFilter; }
    function setFilter(f) { searchFilter = f; }
    function collectMatches(roots, needles) {
        const matches = [];
        const uniqueNeedles = Array.from(new Set(needles.map((q) => q.trim()).filter(Boolean)));
        if (uniqueNeedles.length === 0)
            return matches;
        const lowerNeedles = uniqueNeedles.map((n) => n.toLocaleLowerCase());
        for (const root of roots) {
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            let node = walker.nextNode();
            while (node) {
                if (!isVisibleTextNode(node)) {
                    node = walker.nextNode();
                    continue;
                }
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
            matches = collectMatches(roots, [variant]);
            if (matches.length > 0)
                break;
        }
        if (matches.length === 0) {
            const tokenFallback = getSearchTokenFallback(q).filter((token) => token.length >= 2);
            if (tokenFallback.length > 0) {
                const filteredRoots = filterRootsContainingAllTokens(roots, tokenFallback);
                matches = collectMatches(filteredRoots, tokenFallback);
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
        cancelScroll();
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
                if (dist < bestDist) {
                    bestDist = dist;
                    bestIdx = i;
                }
            }
            chatHitIndex = bestIdx;
            chatHits.forEach((h) => h.classList.remove('chat-hit-active'));
            chatHits[chatHitIndex].classList.add('chat-hit-active');
            byId('chatSearchCount').textContent = (chatHitIndex + 1) + '/' + chatHits.length;
        }
    }
    function createSearchUI(uiT) {
        const chatSearchInput = createEl('input', {
            type: 'text', id: 'chatSearch',
            className: 'mac-input',
            spellcheck: 'false',
            autocorrect: 'off',
            autocapitalize: 'off',
            autocomplete: 'off',
        });
        chatSearchInput.style.cssText = 'width:100%;height:28px;padding:4px 60px 4px 8px;box-sizing:border-box;';
        chatSearchInput.placeholder = uiT('chatSearchPlaceholder');
        const chatCount = createEl('span', { id: 'chatSearchCount', className: 'text-[10px]' });
        chatCount.style.cssText = 'color:var(--text-faint);white-space:nowrap;';
        const prevBtn = createEl('button', { id: 'chatSearchPrev', className: 'hidden', textContent: '\u25B2' });
        prevBtn.style.cssText = 'font-size:9px;color:var(--text-muted);padding:0 2px;line-height:1;cursor:default;background:none;border:none;pointer-events:auto;';
        const nextBtn = createEl('button', { id: 'chatSearchNext', className: 'hidden', textContent: '\u25BC' });
        nextBtn.style.cssText = 'font-size:9px;color:var(--text-muted);padding:0 2px;line-height:1;cursor:default;background:none;border:none;pointer-events:auto;';
        const chatClearBtn = createEl('button', { id: 'chatSearchClear', textContent: '\u00D7' });
        chatClearBtn.style.cssText = 'font-size:13px;color:var(--text-muted);padding:0 2px;line-height:1;cursor:default;background:none;border:none;pointer-events:auto;display:none;';
        const searchOverlay = createEl('div', {}, [chatCount, prevBtn, nextBtn, chatClearBtn]);
        searchOverlay.style.cssText = 'display:grid;grid-auto-flow:column;grid-auto-columns:max-content;align-items:center;gap:2px;position:absolute;right:6px;top:50%;transform:translateY(-50%);pointer-events:auto;';
        const searchGroup = createEl('div', {}, [chatSearchInput, searchOverlay]);
        searchGroup.style.cssText = 'display:grid;position:relative;min-width:0;';
        // Filter segmented control: All / AI / User
        function svgEl(tag, attrs, children) {
            const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
            for (const [k, v] of Object.entries(attrs))
                el.setAttribute(k, v);
            if (children)
                children.forEach(c => el.appendChild(c));
            return el;
        }
        const bubbleSvgAttrs = { width: '14', height: '14', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
        function bubbleIcon(key) {
            if (key === 'all') {
                return svgEl('svg', bubbleSvgAttrs, [
                    svgEl('path', { d: 'M21 14l-3 -3h-7a1 1 0 0 1 -1 -1v-6a1 1 0 0 1 1 -1h9a1 1 0 0 1 1 1v10' }),
                    svgEl('path', { d: 'M14 15v2a1 1 0 0 1 -1 1h-7l-3 3v-10a1 1 0 0 1 1 -1h2' }),
                ]);
            }
            const svg = svgEl('svg', bubbleSvgAttrs, [
                svgEl('path', { d: 'M18 4a3 3 0 0 1 3 3v8a3 3 0 0 1 -3 3h-5l-5 3v-3h-2a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3h12' }),
            ]);
            if (key === 'user')
                svg.style.transform = 'scaleX(-1)';
            return svg;
        }
        const filters = [
            { key: 'all', label: uiT('chatFilterAll') },
            { key: 'assistant', label: uiT('chatFilterAI') },
            { key: 'user', label: uiT('chatFilterUser') },
        ];
        const filterBar = createEl('div', { className: 'mac-segmented' });
        const filterBtns = [];
        for (const f of filters) {
            const btn = createEl('button', {
                className: 'mac-segmented-btn' + (f.key === searchFilter ? ' active' : ''),
            });
            btn.appendChild(bubbleIcon(f.key));
            btn.title = f.label;
            btn.style.cssText += 'display:inline-flex;align-items:center;justify-content:center;padding:3px 7px;';
            btn.addEventListener('click', () => {
                setFilter(f.key);
                filterBtns.forEach((b, i) => {
                    b.classList.toggle('active', filters[i].key === f.key);
                });
                doSearch();
            });
            filterBtns.push(btn);
            filterBar.appendChild(btn);
        }
        const controlsRow = createEl('div', { className: 'min-w-0' }, [filterBar, searchGroup]);
        controlsRow.style.cssText = 'display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:8px;';
        // Bind search input events
        let chatSearchTimer;
        chatSearchInput.addEventListener('input', () => {
            chatClearBtn.style.display = chatSearchInput.value ? 'block' : 'none';
            clearTimeout(chatSearchTimer);
            chatSearchTimer = setTimeout(() => doSearch(), 200);
        });
        chatClearBtn.addEventListener('click', () => {
            chatSearchInput.value = '';
            chatClearBtn.style.display = 'none';
            doSearch();
            chatSearchInput.focus();
        });
        nextBtn.addEventListener('click', () => next());
        prevBtn.addEventListener('click', () => prev());
        chatSearchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.shiftKey ? prev() : next();
                e.preventDefault();
            }
            if (e.key === 'Escape') {
                const target = e.target;
                if (target) {
                    target.value = '';
                    chatClearBtn.style.display = 'none';
                    doSearch();
                    target.blur();
                }
            }
        });
        return { controlsRow };
    }
    return {
        reset,
        clear,
        doSearch,
        next,
        prev,
        scrollToMessageIndex,
        getFilter,
        setFilter,
        createSearchUI,
    };
}
