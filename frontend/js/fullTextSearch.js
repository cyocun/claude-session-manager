import { normalizeSearchQuery, parseSearchQuery } from './searchUtils.js';
export function createFullTextSearchController(deps) {
    const { byId, t, getSelectedProject, setProjectFilter, resolveProjectPath, invoke, searchView, onExit, } = deps;
    let searchMode = 'fulltext';
    let activeQuery = '';
    let activeResolvedQuery = '';
    let activeSearchMode = 'fulltext';
    let searchIndexReady = false;
    let fulltextSearchTimer = null;
    let searchRequestSeq = 0;
    function getMode() {
        return searchMode;
    }
    function getActiveResolvedQuery() {
        return activeResolvedQuery;
    }
    function isSearchActive() {
        return activeQuery.length >= 2;
    }
    function setIndexReady(ready) {
        searchIndexReady = ready;
    }
    function onIndexReady() {
        setIndexReady(true);
        const indicator = document.getElementById('searchIndexIndicator');
        if (indicator)
            indicator.remove();
    }
    function toggleMode() {
        searchMode = searchMode === 'fulltext' ? 'similar' : 'fulltext';
        const search = byId('search');
        search.placeholder = searchMode === 'similar' ? t('searchSimilar') : t('searchContent');
        void perform(search.value);
    }
    function onSearchInput() {
        const search = byId('search');
        const parsed = parseSearchQuery(search.value);
        if (parsed.project !== null) {
            const resolved = resolveProjectPath(parsed.project);
            if (resolved) {
                search.value = parsed.query;
                const clearBtn = byId('searchClearBtn');
                if (clearBtn)
                    clearBtn.style.display = search.value ? 'flex' : 'none';
                if (fulltextSearchTimer)
                    clearTimeout(fulltextSearchTimer);
                setProjectFilter(resolved);
                return;
            }
        }
        if (fulltextSearchTimer)
            clearTimeout(fulltextSearchTimer);
        fulltextSearchTimer = setTimeout(() => {
            void perform(search.value);
        }, 300);
    }
    async function perform(query) {
        const trimmedQuery = query.trim();
        if (!trimmedQuery || trimmedQuery.length < 2) {
            const wasActive = activeQuery.length >= 2;
            activeQuery = '';
            activeResolvedQuery = '';
            if (wasActive && searchView.isActive()) {
                searchView.exit();
                onExit();
            }
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
        const searchArgs = {
            project: getSelectedProject() || null,
            limit: requestMode === 'similar' ? 80 : 50,
            sort: filterPayload.sort,
        };
        if (filterPayload.timeRange)
            searchArgs.timeRange = filterPayload.timeRange;
        if (filterPayload.msgTypes)
            searchArgs.msgTypes = filterPayload.msgTypes;
        let results = [];
        let resolvedQuery = trimmedQuery;
        try {
            results = await invoke('search_sessions', {
                query: trimmedQuery,
                ...searchArgs,
            }) || [];
        }
        catch (error) {
            console.warn('[search] primary query failed, retrying with normalized query', error);
            const retryQuery = normalizeSearchQuery(trimmedQuery);
            if (retryQuery.length >= 2 && retryQuery !== trimmedQuery) {
                try {
                    results = await invoke('search_sessions', {
                        query: retryQuery,
                        ...searchArgs,
                    }) || [];
                    resolvedQuery = retryQuery;
                }
                catch (retryError) {
                    console.error('[search] retry query failed', retryError);
                    results = [];
                }
            }
            else {
                results = [];
            }
        }
        if (requestSeq !== searchRequestSeq)
            return;
        if (activeQuery !== trimmedQuery)
            return;
        activeResolvedQuery = resolvedQuery;
        searchView.renderResults(results, activeSearchMode, searchIndexReady, resolvedQuery);
    }
    function clear() {
        const search = byId('search');
        const clearBtn = byId('searchClearBtn');
        if (!search.value && !searchView.isActive())
            return;
        search.value = '';
        if (clearBtn)
            clearBtn.style.display = 'none';
        if (fulltextSearchTimer)
            clearTimeout(fulltextSearchTimer);
        // Force-perform to short-circuit into the "empty query" exit path.
        void perform('');
    }
    // Re-run the search with the current input value. Used by the filter bar:
    // changing a chip doesn't touch the query itself, but we need to fetch again
    // with the new filter payload. Debounces via a shorter delay than onInput
    // since there's no typing involved.
    let rerunTimer = null;
    function rerun() {
        if (!searchView.isActive())
            return;
        const search = byId('search');
        if (rerunTimer)
            clearTimeout(rerunTimer);
        rerunTimer = setTimeout(() => {
            void perform(search.value);
        }, 150);
    }
    function bindInputEvents(inputEl, clearBtn) {
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
    };
}
