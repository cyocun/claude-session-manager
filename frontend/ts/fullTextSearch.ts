import { normalizeSearchQuery, parseSearchQuery } from './searchUtils.js';
import { renderSearchResults, renderLoading, type SearchResultRendererDeps } from './searchResultRenderer.js';
import type { SearchHit, SearchMode } from './types.js';

export type FullTextSearchDeps = {
  byId: (id: string) => any;
  t: (key: string) => string;
  getLang: () => string;
  getSessions: () => Array<{ sessionId: string; firstDisplay: string }>;
  getSelectedProject: () => string | null;
  setProjectFilter: (path: string | null) => void;
  resolveProjectPath: (displayName: string) => string | null;
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
    setProjectFilter,
    resolveProjectPath,
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

  function onIndexReady(): void {
    setIndexReady(true);
    const indicator = document.getElementById('searchIndexIndicator');
    if (indicator) indicator.remove();
  }

  function toggleMode(): void {
    searchMode = searchMode === 'fulltext' ? 'similar' : 'fulltext';
    const search = byId('search') as HTMLInputElement;
    search.placeholder = searchMode === 'similar' ? t('searchSimilar') : t('searchContent');
    void perform(search.value);
  }

  function onSearchInput(): void {
    const search = byId('search') as HTMLInputElement;
    const parsed = parseSearchQuery(search.value);
    if (parsed.project !== null) {
      const resolved = resolveProjectPath(parsed.project);
      if (resolved) {
        search.value = parsed.query;
        const clearBtn = byId('searchClearBtn');
        if (clearBtn) clearBtn.style.display = search.value ? 'flex' : 'none';
        if (fulltextSearchTimer) clearTimeout(fulltextSearchTimer);
        setProjectFilter(resolved);
        return;
      }
    }
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

    renderLoading(byId('sessionList'), searchIndexReady, t);

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

    const rendererDeps: SearchResultRendererDeps = {
      byId,
      t,
      getLang,
      getSessions,
      projectDisplayName,
      invoke,
      showDetail,
      setSelectedSession,
      chatSearch,
      getActiveResolvedQuery: () => activeResolvedQuery,
      getSearchInputValue: () => (byId('search') as HTMLInputElement).value.trim(),
    };
    renderSearchResults(searchResults, activeSearchMode, searchIndexReady, rendererDeps);
  }

  function clear(): void {
    const search = byId('search') as HTMLInputElement;
    const clearBtn = byId('searchClearBtn');
    if (!search.value) return;
    search.value = '';
    clearBtn.style.display = 'none';
    onSearchInput();
  }

  function bindInputEvents(inputEl: HTMLInputElement, clearBtn: HTMLElement): void {
    inputEl.addEventListener('input', () => {
      onSearchInput();
      clearBtn.style.display = inputEl.value ? 'flex' : 'none';
    });
    clearBtn.addEventListener('click', () => {
      inputEl.value = '';
      clearBtn.style.display = 'none';
      onSearchInput();
    });
  }

  return {
    getMode,
    isSearchActive,
    onIndexReady,
    toggleMode,
    onSearchInput,
    perform,
    clear,
    bindInputEvents,
  };
}
