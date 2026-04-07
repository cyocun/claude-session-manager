type SearchHit = {
  project: string;
  sessionId: string;
  msgType: string;
  snippet: string;
  messageIndex: number;
};

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

  let searchMode: 'filter' | 'fulltext' | 'similar' = 'fulltext';
  let searchResults: SearchHit[] = [];
  let searchIndexReady = false;
  let fulltextSearchTimer: ReturnType<typeof setTimeout> | null = null;

  function getMode(): 'filter' | 'fulltext' | 'similar' {
    return searchMode;
  }

  function setIndexReady(ready: boolean): void {
    searchIndexReady = ready;
  }

  function toggleMode(): void {
    searchMode = searchMode === 'fulltext' ? 'similar' : 'fulltext';
    const search = byId('search') as HTMLInputElement;
    search.placeholder = searchMode === 'similar' ? t('searchSimilar') : t('searchContent');
    const q = search.value.trim();
    if (q) {
      void perform(q);
    }
  }

  function onSearchInput(): void {
    const search = byId('search') as HTMLInputElement;
    if (searchMode === 'fulltext' || searchMode === 'similar') {
      if (fulltextSearchTimer) clearTimeout(fulltextSearchTimer);
      fulltextSearchTimer = setTimeout(() => {
        void perform(search.value.trim());
      }, 300);
    } else {
      renderSessions();
    }
  }

  async function perform(query: string): Promise<void> {
    if (!query || query.length < 2) {
      searchResults = [];
      renderSessions();
      return;
    }
    renderLoading();
    searchResults = await invoke('search_sessions', {
      query,
      project: getSelectedProject() || null,
      limit: searchMode === 'similar' ? 80 : 50,
    }) || [];
    renderResults();
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
    msg.textContent = t('searchIndexing');
    el.appendChild(msg);
  }

  function sanitizeSnippet(raw: string): string {
    const sanitized = DOMPurify.sanitize(raw, { ALLOWED_TAGS: ['b'] })
      .replace(/<b>/g, '<mark style="background:var(--hit-bg);color:inherit;border-radius:2px;padding:0 1px;">')
      .replace(/<\/b>/g, '</mark>');
    return DOMPurify.sanitize(sanitized, { ALLOWED_TAGS: ['mark'], ALLOWED_ATTR: ['style'] });
  }

  function renderResults(): void {
    const el = byId('sessionList');
    el.replaceChildren();
    const lang = getLang();

    if (searchResults.length === 0) {
      const msg = document.createElement('div');
      msg.className = 'text-xs text-center py-8';
      msg.style.color = 'var(--text-faint)';
      msg.textContent = searchIndexReady
        ? (searchMode === 'similar' ? t('similarNoResults') : t('searchNoResults'))
        : (lang === 'ja' ? 'インデックス構築中...' : 'Indexing...');
      el.appendChild(msg);
      byId('sessionListTitle').textContent = searchIndexReady
        ? (searchMode === 'similar' ? t('similarNoResults') : t('searchNoResults'))
        : (lang === 'ja' ? 'インデックス構築中...' : 'Indexing...');
      return;
    }

    byId('sessionListTitle').textContent =
      t('searchResults').replace('{n}', String(searchResults.length)) +
      (searchIndexReady ? '' : (lang === 'ja' ? ' (インデックス構築中...)' : ' (indexing...)'));

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
      icon.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4.5A1.5 1.5 0 013.5 3H6l1.5 2h5A1.5 1.5 0 0114 6.5v5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5z"/></svg>';

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
        const summary = getSessions().find((s) => s.sessionId === sessionId);
        const title = summary ? summary.firstDisplay : sessionId.slice(0, 8);

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
          if (searchMode === 'similar') {
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
              (prev as HTMLElement).style.outline = '';
            });
            item.classList.add('search-hit-active');
            item.style.outline = '2px solid var(--accent)';
            setSelectedSession(hit.sessionId);
            void showDetail(hit.sessionId).then(() => {
              const q = (byId('search') as HTMLInputElement).value.trim();
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
    setIndexReady,
    toggleMode,
    onSearchInput,
    perform,
  };
}
