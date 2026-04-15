import { normalizeSearchQuery, parseSearchQuery } from './searchUtils.js';
import { searchTelemetry } from './searchTelemetry.js';
import type { HybridHit, SearchHit, SearchMode, SearchSort } from './types.js';

export type SearchFilterPayload = {
  timeRange?: { from?: number; to?: number };
  msgTypes?: string[];
  sort: SearchSort;
};

export type SearchViewApi = {
  enter: () => void;
  exit: () => void;
  isActive: () => boolean;
  renderResults: (results: SearchHit[], mode: SearchMode, indexReady: boolean, query: string) => void;
  getFilterPayload: () => SearchFilterPayload;
};

export type FullTextSearchDeps = {
  byId: (id: string) => any;
  t: (key: string) => string;
  getSelectedProject: () => string | null;
  setProjectFilter: (path: string | null) => void;
  resolveProjectPath: (displayName: string) => string | null;
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<any>;
  searchView: SearchViewApi;
  // Called when search exits (empty query) so app.ts can restore the previous
  // view (detail or startup). Invoked after searchView.exit() has hidden the
  // search pane.
  onExit: () => void;
};

function hybridToSearchHit(h: HybridHit): SearchHit {
  return {
    sessionId: h.sessionId,
    project: h.project,
    snippet: h.snippet,
    msgType: h.msgType,
    messageIndex: h.messageIndex,
    timestamp: h.timestamp,
    score: h.score,
    contextBefore: h.contextBefore,
    contextAfter: h.contextAfter,
    matchedBy: h.matchedBy,
  };
}

export function createFullTextSearchController(deps: FullTextSearchDeps) {
  const {
    byId,
    t,
    getSelectedProject,
    setProjectFilter,
    resolveProjectPath,
    invoke,
    searchView,
    onExit,
  } = deps;

  let searchMode: SearchMode = 'fulltext';
  let activeQuery = '';
  let activeResolvedQuery = '';
  let activeSearchMode: SearchMode = 'fulltext';
  let searchIndexReady = false;
  let fulltextSearchTimer: ReturnType<typeof setTimeout> | null = null;
  let searchRequestSeq = 0;
  // Correlation id for the most recent completed search. Used by
  // searchView/app.ts to tag open_result and escape_no_open events.
  let currentQueryId: string | null = null;

  function getCurrentQueryId(): string | null {
    return currentQueryId;
  }

  function getMode(): SearchMode {
    return searchMode;
  }

  function getActiveResolvedQuery(): string {
    return activeResolvedQuery;
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
      const wasActive = activeQuery.length >= 2;
      const dismissedQueryId = currentQueryId;
      activeQuery = '';
      activeResolvedQuery = '';
      if (wasActive && searchView.isActive()) {
        // exit() reads getCurrentQueryId() to tag an escape_no_open event,
        // so keep currentQueryId alive across the exit call and clear after.
        searchView.exit();
        onExit();
        if (dismissedQueryId) {
          searchTelemetry.append({
            type: 'cleared_input',
            queryId: dismissedQueryId,
            timestamp: Date.now(),
          });
        }
      }
      currentQueryId = null;
      return;
    }

    const requestMode = searchMode;
    const requestSeq = ++searchRequestSeq;
    activeQuery = trimmedQuery;
    activeSearchMode = requestMode;

    if (!searchView.isActive()) {
      searchView.enter();
    }
    // Show a loading affordance via an empty render; final results overwrite.
    searchView.renderResults([], requestMode, searchIndexReady, trimmedQuery);

    const filterPayload = searchView.getFilterPayload();
    const searchArgs: Record<string, unknown> = {
      project: getSelectedProject() || null,
      limit: requestMode === 'similar' ? 30 : 50,
      sort: filterPayload.sort,
    };
    if (filterPayload.timeRange) searchArgs.timeRange = filterPayload.timeRange;
    if (filterPayload.msgTypes) searchArgs.msgTypes = filterPayload.msgTypes;
    const startedAt = performance.now();
    let results: SearchHit[] = [];
    let resolvedQuery = trimmedQuery;
    const isHybrid = requestMode === 'similar';
    // Phase D では time/role フィルタは hybrid_search 未対応なので、
    // hybrid 時は project フィルタのみ渡す。BM25 は従来通り全フィルタ対応。
    const runQuery = async (q: string): Promise<SearchHit[]> => {
      if (isHybrid) {
        const hybrid: HybridHit[] = await invoke('hybrid_search', {
          query: q,
          limit: 30,
          project: getSelectedProject() || null,
        }) || [];
        return hybrid.map(hybridToSearchHit);
      }
      return (await invoke('search_sessions', {
        query: q,
        ...searchArgs,
      })) || [];
    };

    try {
      results = await runQuery(trimmedQuery);
    } catch (error) {
      console.warn('[search] primary query failed, retrying with normalized query', error);
      const retryQuery = normalizeSearchQuery(trimmedQuery);
      if (retryQuery.length >= 2 && retryQuery !== trimmedQuery) {
        try {
          results = await runQuery(retryQuery);
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
    searchView.renderResults(results, activeSearchMode, searchIndexReady, resolvedQuery);

    // Mint a new correlation id per completed search; subsequent open/escape
    // events tag against it. Done after render so telemetry reflects the
    // actual result set the user saw.
    currentQueryId = searchTelemetry.newQueryId();
    searchTelemetry.append({
      type: 'search',
      queryId: currentQueryId,
      query: resolvedQuery,
      mode: requestMode,
      filters: filterPayload,
      resultCount: results.length,
      durationMs: Math.round(performance.now() - startedAt),
      indexReady: searchIndexReady,
      timestamp: Date.now(),
    });
  }

  function clear(): void {
    const search = byId('search') as HTMLInputElement;
    const clearBtn = byId('searchClearBtn');
    if (!search.value && !searchView.isActive()) return;
    search.value = '';
    if (clearBtn) clearBtn.style.display = 'none';
    if (fulltextSearchTimer) clearTimeout(fulltextSearchTimer);
    // Force-perform to short-circuit into the "empty query" exit path.
    void perform('');
  }

  // Re-run the search with the current input value. Used by the filter bar:
  // changing a chip doesn't touch the query itself, but we need to fetch again
  // with the new filter payload. Debounces via a shorter delay than onInput
  // since there's no typing involved.
  let rerunTimer: ReturnType<typeof setTimeout> | null = null;
  function rerun(): void {
    if (!searchView.isActive()) return;
    const search = byId('search') as HTMLInputElement;
    if (rerunTimer) clearTimeout(rerunTimer);
    rerunTimer = setTimeout(() => {
      void perform(search.value);
    }, 150);
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
    getActiveResolvedQuery,
    rerun,
    getCurrentQueryId,
  };
}
