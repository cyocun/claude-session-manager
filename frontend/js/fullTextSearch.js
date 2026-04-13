import { normalizeSearchQuery, parseSearchQuery } from './searchUtils.js';
import { renderSearchResults, renderLoading } from './searchResultRenderer.js';
export function createFullTextSearchController(deps) {
    const { byId, t, getLang, getSessions, getSelectedProject, setProjectFilter, resolveProjectPath, projectDisplayName, invoke, renderSessions, showDetail, setSelectedSession, chatSearch, } = deps;
    let searchMode = 'fulltext';
    let searchResults = [];
    let activeQuery = '';
    let activeResolvedQuery = '';
    let activeSearchMode = 'fulltext';
    let searchIndexReady = false;
    let fulltextSearchTimer = null;
    let searchRequestSeq = 0;
    function getMode() {
        return searchMode;
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
        searchResults = results;
        const rendererDeps = {
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
            getSearchInputValue: () => byId('search').value.trim(),
        };
        renderSearchResults(searchResults, activeSearchMode, searchIndexReady, rendererDeps);
    }
    function clear() {
        const search = byId('search');
        const clearBtn = byId('searchClearBtn');
        if (!search.value)
            return;
        search.value = '';
        clearBtn.style.display = 'none';
        onSearchInput();
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
    };
}
