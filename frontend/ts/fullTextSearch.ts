import { normalizeSearchQuery } from './searchUtils.js';
import { ICONS } from './icons.js';
import { setHighlight } from './dom.js';

type SearchHit = {
  project: string;
  sessionId: string;
  msgType: string;
  snippet: string;
  messageIndex: number;
};

type SearchMode = 'fulltext' | 'similar';

export type FullTextSearchDeps = {
  byId: (id: string) => any;
  t: (key: string) => string;
  getLang: () => string;
  getSessions: () => any[];
  getSelectedProject: () => string | null;
  projectDisplayName: (path: string) => string;
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<any>;
  renderSessions: () => void;
  showDetail: (sessionId: string) => Promise<void>;
  setSelectedSession: (sessionId: string) => void;
  chatSearch: { doSearch: () => void; scrollToMessageIndex: (messageIndex: number) => void };
};

export function createFullTextSearchController(deps: FullTextSearchDeps) {
  const {
    byId,
    t,
    getLang,
    getSessions,
    getSelectedProject,
    projectDisplayName,
    invoke,
    renderSessions,
    showDetail,
    setSelectedSession,
    chatSearch,
  } = deps;

  let searchMode: SearchMode = 'fulltext';
  let searchResults: SearchHit[] = [];
  let activeQuery = '';
  let activeResolvedQuery = '';
  let activeSearchMode: SearchMode = 'fulltext';
  let searchIndexReady = false;
  let fulltextSearchTimer: ReturnType<typeof setTimeout> | null = null;
  let searchRequestSeq = 0;

  function getMode(): SearchMode {
    return searchMode;
  }

  function isSearchActive(): boolean {
    return activeQuery.length >= 2;
  }

  function setIndexReady(ready: boolean): void {
    searchIndexReady = ready;
  }

  function toggleMode(): void {
    searchMode = searchMode === 'fulltext' ? 'similar' : 'fulltext';
    const search = byId('search') as HTMLInputElement;
    search.placeholder = searchMode === 'similar' ? t('searchSimilar') : t('searchContent');
    void perform(search.value);
  }

  function onSearchInput(): void {
    const search = byId('search') as HTMLInputElement;
    if (fulltextSearchTimer) clearTimeout(fulltextSearchTimer);
    fulltextSearchTimer = setTimeout(() => {
      void perform(search.value);
    }, 300);
  }

  async function perform(query: string): Promise<void> {
    const trimmedQuery = query.trim();
    if (!trimmedQuery || trimmedQuery.length < 2) {
      activeQuery = '';
      activeResolvedQuery = '';
      searchResults = [];
      renderSessions();
      return;
    }

    const requestMode = searchMode;
    const requestSeq = ++searchRequestSeq;
    activeQuery = trimmedQuery;
    activeSearchMode = requestMode;

    renderLoading();
    const searchArgs = {
      project: getSelectedProject() || null,
      limit: requestMode === 'similar' ? 80 : 50,
    };
    let results: SearchHit[] = [];
    let resolvedQuery = trimmedQuery;
    try {
      results = await invoke('search_sessions', {
        query: trimmedQuery,
        ...searchArgs,
      }) || [];
    } catch (error) {
      console.warn('[search] primary query failed, retrying with normalized query', error);
      const retryQuery = normalizeSearchQuery(trimmedQuery);
      if (retryQuery.length >= 2 && retryQuery !== trimmedQuery) {
        try {
          results = await invoke('search_sessions', {
            query: retryQuery,
            ...searchArgs,
          }) || [];
          resolvedQuery = retryQuery;
        } catch (retryError) {
          console.error('[search] retry query failed', retryError);
          results = [];
        }
      } else {
        results = [];
      }
    }

    if (requestSeq !== searchRequestSeq) return;
    if (activeQuery !== trimmedQuery) return;

    activeResolvedQuery = resolvedQuery;
    searchResults = results;
    renderResults(requestMode);
  }

  async function fetchContextSnippet(hit: SearchHit): Promise<{ before: string; current: string; after: string; likely: string } | null> {
    const detail = await invoke('get_session_detail', { sessionId: hit.sessionId });
    if (!detail?.messages || !Array.isArray(detail.messages)) return null;
    const idx = Math.max(0, hit.messageIndex | 0);
    const msgs = detail.messages as Array<{ type: string; content?: string }>;
    const pick = (i: number) => (msgs[i]?.content || '').trim().replace(/\s+/g, ' ').slice(0, 220);
    const before = idx > 0 ? pick(idx - 1) : '';
    const current = pick(idx);
    const after = idx + 1 < msgs.length ? pick(idx + 1) : '';
    let likely = '';
    for (let i = idx + 1; i < Math.min(idx + 8, msgs.length); i++) {
      const m = msgs[i];
      if (m?.type === 'assistant' && (m.content || '').trim()) {
        likely = (m.content || '').trim().replace(/\s+/g, ' ').slice(0, 240);
        break;
      }
    }
    return { before, current, after, likely };
  }

  function renderLoading(): void {
    const el = byId('sessionList');
    el.replaceChildren();
    const msg = document.createElement('div');
    msg.className = 'text-xs text-center py-8';
    msg.style.color = 'var(--text-faint)';
    msg.textContent = searchIndexReady ? t('searchSearching') : t('searchIndexing');
    el.appendChild(msg);
  }

  function sanitizeSnippet(raw: string): string {
    const sanitized = DOMPurify.sanitize(raw, { ALLOWED_TAGS: ['b'] })
      .replace(/<b>/g, '<mark style="background:var(--hit-bg);color:inherit;border-radius:2px;padding:0 1px;">')
      .replace(/<\/b>/g, '</mark>');
    return DOMPurify.sanitize(sanitized, { ALLOWED_TAGS: ['mark'], ALLOWED_ATTR: ['style'] });
  }

  function renderResults(mode: SearchMode = activeSearchMode): void {
    const el = byId('sessionList');
    el.replaceChildren();
    const lang = getLang();

    if (searchResults.length === 0) {
      const msg = document.createElement('div');
      msg.className = 'text-xs text-center py-8';
      msg.style.color = 'var(--text-faint)';
      msg.textContent = searchIndexReady
        ? (mode === 'similar' ? t('similarNoResults') : t('searchNoResults'))
        : t('searchIndexing');
      el.appendChild(msg);
      byId('sessionListTitle').textContent = searchIndexReady
        ? (mode === 'similar' ? t('similarNoResults') : t('searchNoResults'))
        : t('searchIndexing');
      return;
    }

    byId('sessionListTitle').textContent =
      t('searchResults').replace('{n}', String(searchResults.length)) +
      (searchIndexReady ? '' : ` (${t('searchIndexing')})`);

    const sessionTitleMap = new Map<string, string>();
    getSessions().forEach((summary) => {
      sessionTitleMap.set(summary.sessionId, summary.firstDisplay);
    });

    const projMap: Record<string, Record<string, SearchHit[]>> = {};
    const projOrder: string[] = [];
    searchResults.forEach((hit) => {
      if (!projMap[hit.project]) {
        projMap[hit.project] = {};
        projOrder.push(hit.project);
      }
      if (!projMap[hit.project][hit.sessionId]) {
        projMap[hit.project][hit.sessionId] = [];
      }
      projMap[hit.project][hit.sessionId].push(hit);
    });

    projOrder.forEach((proj) => {
      const group = document.createElement('div');
      group.className = 'project-group';

      const chevron = document.createElement('span');
      chevron.className = 'project-group-chevron open';
      chevron.textContent = '\u25B6';

      const icon = document.createElement('span');
      icon.className = 'project-group-icon';
      icon.innerHTML = ICONS.folder;

      const sessMap = projMap[proj];
      const hitCount = Object.values(sessMap).reduce((n, arr) => n + arr.length, 0);

      const name = document.createElement('span');
      name.className = 'text-xs font-medium flex-1 truncate';
      name.textContent = projectDisplayName(proj);
      name.style.color = 'var(--text-secondary)';

      const count = document.createElement('span');
      count.className = 'text-[10px] flex-shrink-0';
      count.textContent = String(hitCount);
      count.style.color = 'var(--text-muted)';

      const header = document.createElement('div');
      header.className = 'project-group-header';
      header.append(chevron, icon, name, count);

      const sessionsDiv = document.createElement('div');
      sessionsDiv.className = 'project-group-sessions open';

      Object.keys(sessMap).forEach((sessionId) => {
        const hits = sessMap[sessionId];
        const title = sessionTitleMap.get(sessionId) || sessionId.slice(0, 8);

        const sessTitle = document.createElement('span');
        sessTitle.className = 'text-sm leading-snug truncate';
        sessTitle.textContent = title;
        sessTitle.style.color = 'var(--text)';

        const sessHitCount = document.createElement('span');
        sessHitCount.className = 'text-[10px] flex-shrink-0';
        sessHitCount.textContent = `${hits.length}${hits.length === 1 ? ' hit' : ' hits'}`;
        sessHitCount.style.color = 'var(--text-faint)';

        const sessHeader = document.createElement('div');
        sessHeader.className = 'px-3 pt-2 pb-1';
        sessHeader.style.cssText = 'display:flex;align-items:baseline;gap:8px;justify-content:space-between;border-top:1px solid var(--border);margin-top:4px;padding-top:8px;';
        sessHeader.append(sessTitle, sessHitCount);
        sessionsDiv.appendChild(sessHeader);

        hits.forEach((hit) => {
          const isUser = hit.msgType === 'user';

          const snippetEl = document.createElement('div');
          snippetEl.className = 'text-xs';
          snippetEl.style.cssText = 'overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;';
          snippetEl.innerHTML = sanitizeSnippet(hit.snippet);

          const item = document.createElement('div');
          item.className = `${isUser ? 'bubble-user' : 'bubble-assistant'} px-3 py-1.5 cursor-default overflow-hidden`;
          item.style.cssText = `margin:3px 4px;font-size:12px;max-width:none;${isUser ? 'margin-left:30px;' : 'margin-right:30px;'}`;
          item.appendChild(snippetEl);
          const contextEl = document.createElement('div');
          contextEl.className = 'text-[11px] mt-1';
          contextEl.style.cssText = 'color:var(--text-faint);display:none;line-height:1.45;';
          item.appendChild(contextEl);
          item.addEventListener('mouseenter', () => { item.style.opacity = '0.8'; });
          item.addEventListener('mouseleave', () => { item.style.opacity = ''; });
          if (mode === 'similar') {
            contextEl.style.display = 'block';
            contextEl.textContent = t('loadingContext');
            void fetchContextSnippet(hit).then((ctx) => {
              if (!ctx) {
                contextEl.textContent = '';
                return;
              }
              const lines: string[] = [];
              if (ctx.before) lines.push(`↑ ${ctx.before}`);
              if (ctx.current) lines.push(`• ${ctx.current}`);
              if (ctx.after) lines.push(`↓ ${ctx.after}`);
              if (ctx.likely) lines.push(`${t('likelySolution')}: ${ctx.likely}`);
              contextEl.textContent = lines.join('\n');
            });
          }
          item.addEventListener('click', () => {
            el.querySelectorAll('.search-hit-active').forEach((prev: Element) => {
              prev.classList.remove('search-hit-active');
              setHighlight(prev as HTMLElement, false);
            });
            item.classList.add('search-hit-active');
            setHighlight(item, true);
            setSelectedSession(hit.sessionId);
            void showDetail(hit.sessionId).then(() => {
              const q = activeResolvedQuery || (byId('search') as HTMLInputElement).value.trim();
              const chatInput = byId('chatSearch') as HTMLInputElement | null;
              if (q && chatInput) {
                chatInput.value = q;
                chatSearch.doSearch();
              }
              chatSearch.scrollToMessageIndex(hit.messageIndex);
            });
          });
          sessionsDiv.appendChild(item);
        });
      });

      header.addEventListener('click', () => {
        chevron.classList.toggle('open');
        sessionsDiv.classList.toggle('open');
      });

      group.append(header, sessionsDiv);
      el.appendChild(group);
    });
  }

  return {
    getMode,
    isSearchActive,
    setIndexReady,
    toggleMode,
    onSearchInput,
    perform,
  };
}
