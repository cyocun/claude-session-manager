// Search mode view controller.
//
// Phase 1 of the search-experience redesign: renders full-text search results
// into a dedicated right-hand pane (#searchResultPane) instead of hijacking the
// sidebar session list. The pane has a result list on the left and a context
// preview on the right. Entering / exiting search mode preserves the
// previously-selected session so that Esc / empty query returns the user to
// whatever they were looking at before.

import { createEl, setHighlight } from './dom.js';
import { sanitizeSnippet } from './searchUtils.js';
import { searchTelemetry } from './searchTelemetry.js';
import type { SearchHit, SearchMode, DetailMessage, SearchSort } from './types.js';

export type RoleFilter = 'all' | 'user' | 'assistant';
export type TimePreset = 'all' | '24h' | '7d' | '30d';

export type SearchFilters = {
  sort: SearchSort;
  role: RoleFilter;
  time: TimePreset;
};

export type SearchViewDeps = {
  byId: <T extends HTMLElement = HTMLElement>(id: string) => T;
  byIdOptional: <T extends HTMLElement>(id: string) => T | null;
  t: (key: string) => string;
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<any>;
  getSessions: () => Array<{ sessionId: string; firstDisplay: string }>;
  projectDisplayName: (path: string) => string;
  // Called when the user confirms a result (Enter / click open). Should open
  // the session in the detail pane and scroll to `messageIndex`.
  openSession: (sessionId: string, messageIndex: number) => void | Promise<void>;
  // Called when the user requests exit (Esc with cleared query).
  onRequestExit: () => void;
  // Called when filter state changes so the query can be re-run with the
  // new filters. Debounce is handled by the caller (fullTextSearch).
  onFiltersChanged: () => void;
  // Correlation id of the currently-displayed search, or null when search
  // mode is inactive. Used by Phase 4 telemetry to tie open/escape events
  // back to the search that produced them.
  getCurrentQueryId: () => string | null;
};

type Row = { el: HTMLElement; hit: SearchHit };

type PreviewResponse = {
  sessionId: string;
  project: string;
  startIndex: number;
  focusOffset: number;
  total: number;
  messages: DetailMessage[];
};

const PREVIEW_WINDOW = 3;
const FILTERS_STORAGE_KEY = 'csm-search-filters';

const DEFAULT_FILTERS: SearchFilters = {
  sort: 'relevance',
  role: 'all',
  time: 'all',
};

function loadFilters(): SearchFilters {
  try {
    const raw = localStorage.getItem(FILTERS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_FILTERS };
    const parsed = JSON.parse(raw) as Partial<SearchFilters>;
    // Whitelist each field — don't trust localStorage past a version bump.
    const sort: SearchSort = (['relevance', 'newest', 'oldest', 'relevance_recent']
      .includes(parsed.sort as string) ? parsed.sort : 'relevance') as SearchSort;
    const role: RoleFilter = (['all', 'user', 'assistant']
      .includes(parsed.role as string) ? parsed.role : 'all') as RoleFilter;
    const time: TimePreset = (['all', '24h', '7d', '30d']
      .includes(parsed.time as string) ? parsed.time : 'all') as TimePreset;
    return { sort, role, time };
  } catch {
    return { ...DEFAULT_FILTERS };
  }
}

function saveFilters(filters: SearchFilters): void {
  try {
    localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(filters));
  } catch {
    // localStorage full or disabled — just drop the write.
  }
}

function timePresetToFromMs(preset: TimePreset): number | undefined {
  if (preset === 'all') return undefined;
  const now = Date.now();
  switch (preset) {
    case '24h': return now - 24 * 60 * 60 * 1000;
    case '7d': return now - 7 * 24 * 60 * 60 * 1000;
    case '30d': return now - 30 * 24 * 60 * 60 * 1000;
    default: return undefined;
  }
}

export function createSearchView(deps: SearchViewDeps) {
  const {
    byId, byIdOptional, t, invoke,
    getSessions, projectDisplayName,
    openSession, onRequestExit, onFiltersChanged, getCurrentQueryId,
  } = deps;

  let active = false;
  let rows: Row[] = [];
  let activeIdx = -1;
  let filters: SearchFilters = loadFilters();
  // Whether any result was opened since the current search was rendered.
  // Flipped to true on confirmActive()/double-click; reset on each new search.
  let resultOpenedForCurrentQuery = false;
  let previewSeq = 0;
  let lastPreviewSessionId: string | null = null;
  let lastPreviewMessageIndex = -1;
  let currentQuery = '';

  function isActive(): boolean {
    return active;
  }

  function enter(): void {
    if (active) return;
    active = true;
    const detailPane = byIdOptional<HTMLElement>('detailPane');
    const searchPane = byId<HTMLElement>('searchResultPane');
    // Stash detail's prior display so exit() can restore it without re-render.
    if (detailPane) {
      detailPane.dataset.preSearchDisplay = detailPane.style.display || 'grid';
      detailPane.style.display = 'none';
    }
    searchPane.style.display = 'grid';
    renderFilterBar();
    renderEmptyPreview();
  }

  function getFilters(): SearchFilters {
    return { ...filters };
  }

  function getFilterPayload(): {
    timeRange?: { from?: number; to?: number };
    msgTypes?: string[];
    sort: SearchSort;
  } {
    const payload: { timeRange?: { from?: number; to?: number }; msgTypes?: string[]; sort: SearchSort } = {
      sort: filters.sort,
    };
    const from = timePresetToFromMs(filters.time);
    if (from !== undefined) {
      payload.timeRange = { from };
    }
    if (filters.role !== 'all') {
      payload.msgTypes = [filters.role];
    }
    return payload;
  }

  function setFilter<K extends keyof SearchFilters>(key: K, value: SearchFilters[K]): void {
    if (filters[key] === value) return;
    filters = { ...filters, [key]: value };
    saveFilters(filters);
    renderFilterBar();
    onFiltersChanged();
  }

  function resetFilters(): void {
    if (
      filters.sort === DEFAULT_FILTERS.sort &&
      filters.role === DEFAULT_FILTERS.role &&
      filters.time === DEFAULT_FILTERS.time
    ) return;
    filters = { ...DEFAULT_FILTERS };
    saveFilters(filters);
    renderFilterBar();
    onFiltersChanged();
  }

  function makeSegmented<V extends string>(
    label: string,
    options: Array<{ value: V; label: string }>,
    current: V,
    onChange: (value: V) => void,
  ): HTMLElement {
    const group = createEl('div', { className: 'search-filter-group' });
    const labelEl = createEl('span', {
      className: 'search-filter-label',
      textContent: label,
    });
    const seg = createEl('div', { className: 'mac-segmented search-filter-seg' });
    for (const opt of options) {
      const btn = createEl('button', {
        className: 'mac-segmented-btn' + (opt.value === current ? ' active' : ''),
        textContent: opt.label,
        onClick: () => onChange(opt.value),
      });
      seg.appendChild(btn);
    }
    group.append(labelEl, seg);
    return group;
  }

  function renderFilterBar(): void {
    const bar = byId<HTMLElement>('searchFilterBar');
    bar.replaceChildren();

    bar.appendChild(makeSegmented<SearchSort>(
      t('searchFilterSort'),
      [
        { value: 'relevance', label: t('searchSortRelevance') },
        { value: 'newest', label: t('searchSortNewest') },
        { value: 'oldest', label: t('searchSortOldest') },
        { value: 'relevance_recent', label: t('searchSortRelevanceRecent') },
      ],
      filters.sort,
      (v) => setFilter('sort', v),
    ));

    bar.appendChild(makeSegmented<RoleFilter>(
      t('searchFilterRole'),
      [
        { value: 'all', label: t('searchRoleAll') },
        { value: 'user', label: t('searchRoleUser') },
        { value: 'assistant', label: t('searchRoleAssistant') },
      ],
      filters.role,
      (v) => setFilter('role', v),
    ));

    bar.appendChild(makeSegmented<TimePreset>(
      t('searchFilterTime'),
      [
        { value: 'all', label: t('searchTimeAll') },
        { value: '24h', label: t('searchTime24h') },
        { value: '7d', label: t('searchTime7d') },
        { value: '30d', label: t('searchTime30d') },
      ],
      filters.time,
      (v) => setFilter('time', v),
    ));

    const anyActive = filters.sort !== DEFAULT_FILTERS.sort
      || filters.role !== DEFAULT_FILTERS.role
      || filters.time !== DEFAULT_FILTERS.time;
    if (anyActive) {
      const reset = createEl('button', {
        className: 'search-filter-reset',
        textContent: t('searchFilterReset'),
        onClick: () => resetFilters(),
      });
      bar.appendChild(reset);
    }
  }

  function exit(): void {
    if (!active) return;
    // Telemetry: if the user dismissed search without opening a result, record
    // an escape_no_open event. Filtering by rows.length>0 avoids logging an
    // exit from a 0-hit query as an "abandonment" — that's already captured
    // by the search event's resultCount=0.
    if (rows.length > 0 && !resultOpenedForCurrentQuery) {
      const qid = getCurrentQueryId();
      if (qid) {
        searchTelemetry.append({
          type: 'escape_no_open',
          queryId: qid,
          timestamp: Date.now(),
        });
      }
    }
    active = false;
    const detailPane = byIdOptional<HTMLElement>('detailPane');
    const searchPane = byId<HTMLElement>('searchResultPane');
    searchPane.style.display = 'none';
    if (detailPane) {
      const prior = detailPane.dataset.preSearchDisplay || 'grid';
      detailPane.style.display = prior;
      delete detailPane.dataset.preSearchDisplay;
    }
    rows = [];
    activeIdx = -1;
    resultOpenedForCurrentQuery = false;
    lastPreviewSessionId = null;
    lastPreviewMessageIndex = -1;
  }

  function renderEmptyPreview(): void {
    const pane = byId<HTMLElement>('searchPreviewPane');
    pane.replaceChildren();
    const empty = createEl('div', {
      className: 'search-preview-empty',
      textContent: t('searchPreviewEmpty'),
    });
    pane.appendChild(empty);
  }

  function updateSummary(results: SearchHit[], mode: SearchMode, indexReady: boolean, query: string): void {
    const summary = byId<HTMLElement>('searchResultSummary');
    summary.replaceChildren();

    const queryLabel = createEl('span', {});
    queryLabel.style.cssText = 'color:var(--text);font-weight:500;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    queryLabel.textContent = query ? `\u201C${query}\u201D` : '';

    const sep = createEl('span', { textContent: '\u00B7' });
    sep.style.cssText = 'color:var(--text-faint);';

    let countText: string;
    if (!indexReady) {
      countText = t('searchIndexing');
    } else if (results.length === 0) {
      countText = mode === 'similar' ? t('similarNoResults') : t('searchNoResults');
    } else {
      countText = t('searchResultsSummary').replace('{n}', String(results.length));
    }
    const countEl = createEl('span', { textContent: countText });
    countEl.style.cssText = 'color:var(--text-secondary);';

    if (query) {
      summary.append(queryLabel, sep, countEl);
    } else {
      summary.append(countEl);
    }

    // Spacer + telemetry indicator pushes to the right edge.
    const spacer = createEl('span', {});
    spacer.style.cssText = 'flex:1 1 auto;';
    summary.append(spacer, buildTelemetryIndicator());
  }

  function buildTelemetryIndicator(): HTMLElement {
    const enabled = searchTelemetry.isEnabled();
    const btn = createEl('button', {
      className: 'search-telemetry-btn' + (enabled ? ' on' : ''),
      title: t(enabled ? 'searchLogEnabled' : 'searchLogDisabled'),
      textContent: enabled ? '\u25CF ' + t('searchLogBadgeOn') : t('searchLogBadgeOff'),
    });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openTelemetryPopover(btn);
    });
    return btn;
  }

  let openPopover: HTMLElement | null = null;
  function closePopover(): void {
    if (openPopover) {
      openPopover.remove();
      openPopover = null;
    }
  }

  function openTelemetryPopover(anchor: HTMLElement): void {
    if (openPopover) {
      closePopover();
      return;
    }
    const rect = anchor.getBoundingClientRect();
    const popover = createEl('div', { className: 'search-telemetry-popover' });
    popover.style.cssText = `position:fixed;top:${rect.bottom + 4}px;right:${window.innerWidth - rect.right}px;z-index:300;`;

    const heading = createEl('div', {
      className: 'stp-heading',
      textContent: t('searchLogHeading'),
    });
    const desc = createEl('div', {
      className: 'stp-desc',
      textContent: t('searchLogDesc'),
    });

    const toggleWrap = createEl('label', { className: 'stp-toggle' });
    const toggle = createEl('input', { type: 'checkbox' }) as HTMLInputElement;
    toggle.checked = searchTelemetry.isEnabled();
    toggle.addEventListener('change', () => {
      searchTelemetry.setEnabled(toggle.checked);
      // Re-render summary so the indicator reflects the new state.
      updateSummary([], 'fulltext', true, currentQuery);
      // Close and reopen to refresh stats.
      closePopover();
      openTelemetryPopover(anchor);
    });
    const toggleLabel = createEl('span', { textContent: t('searchLogToggle') });
    toggleWrap.append(toggle, toggleLabel);

    const stats = searchTelemetry.summarize();
    const statsEl = createEl('div', { className: 'stp-stats' });
    if (stats.totalSearches === 0) {
      statsEl.textContent = t('searchLogEmpty');
    } else {
      const lines = [
        `${t('searchLogStatSearches')}: ${stats.totalSearches}`,
        `${t('searchLogStatZero')}: ${Math.round(stats.zeroHitRate * 100)}%`,
        `${t('searchLogStatOpen')}: ${Math.round(stats.openRate * 100)}%`,
        `${t('searchLogStatAvg')}: ${Math.round(stats.avgDurationMs)}ms`,
      ];
      statsEl.textContent = lines.join(' · ');
    }

    const actions = createEl('div', { className: 'stp-actions' });
    const exportBtn = createEl('button', {
      className: 'mac-btn',
      textContent: t('searchLogExport'),
      onClick: () => {
        const events = searchTelemetry.snapshot();
        const json = JSON.stringify(events, null, 2);
        if (navigator.clipboard) {
          void navigator.clipboard.writeText(json).catch(() => {});
        }
        closePopover();
      },
    });
    const clearBtn = createEl('button', {
      className: 'mac-btn',
      textContent: t('searchLogClear'),
      onClick: () => {
        searchTelemetry.clear();
        closePopover();
        openTelemetryPopover(anchor);
      },
    });
    actions.append(exportBtn, clearBtn);

    popover.append(heading, desc, toggleWrap, statsEl, actions);
    document.body.appendChild(popover);
    openPopover = popover;

    // Close when clicking outside
    const outside = (e: MouseEvent) => {
      if (!openPopover) return;
      if (!openPopover.contains(e.target as Node) && e.target !== anchor) {
        closePopover();
        document.removeEventListener('mousedown', outside);
      }
    };
    // defer so the click that opened it doesn't immediately close
    setTimeout(() => document.addEventListener('mousedown', outside), 0);
  }

  function groupResults(results: SearchHit[]): Array<{ sessionId: string; project: string; hits: SearchHit[] }> {
    const order: string[] = [];
    const map: Record<string, { sessionId: string; project: string; hits: SearchHit[] }> = {};
    for (const hit of results) {
      if (!map[hit.sessionId]) {
        map[hit.sessionId] = { sessionId: hit.sessionId, project: hit.project, hits: [] };
        order.push(hit.sessionId);
      }
      map[hit.sessionId].hits.push(hit);
    }
    return order.map((id) => map[id]);
  }

  function renderResults(results: SearchHit[], mode: SearchMode, indexReady: boolean, query: string): void {
    currentQuery = query;
    // New search → reset the "opened anything?" flag so escape_no_open fires
    // correctly if the user dismisses this new result set.
    resultOpenedForCurrentQuery = false;
    updateSummary(results, mode, indexReady, query);

    const list = byId<HTMLElement>('searchResultList');
    list.replaceChildren();
    rows = [];
    activeIdx = -1;

    if (results.length === 0) {
      const msg = createEl('div', {
        className: 'text-xs',
        textContent: indexReady
          ? (mode === 'similar' ? t('similarNoResults') : t('searchNoResults'))
          : t('searchIndexing'),
      });
      msg.style.cssText = 'color:var(--text-faint);padding:24px 16px;text-align:center;';
      list.appendChild(msg);
      renderEmptyPreview();
      return;
    }

    const titleMap = new Map<string, string>();
    getSessions().forEach((s) => titleMap.set(s.sessionId, s.firstDisplay));

    const grouped = groupResults(results);
    for (const group of grouped) {
      const header = createEl('div', { className: 'search-result-session-header' });
      const title = titleMap.get(group.sessionId) || group.sessionId.slice(0, 8);
      const titleEl = createEl('span', { className: 'srsh-title', textContent: title });
      titleEl.title = `${projectDisplayName(group.project)} · ${group.sessionId}`;
      const countEl = createEl('span', {
        className: 'srsh-count',
        textContent: `${group.hits.length}${t('hits')}`,
      });
      header.append(titleEl, countEl);
      list.appendChild(header);

      for (const hit of group.hits) {
        const row = buildResultRow(hit);
        list.appendChild(row);
        rows.push({ el: row, hit });
      }
    }

    setActiveIndex(0, { scroll: false });
  }

  function buildResultRow(hit: SearchHit): HTMLElement {
    // Hybrid (msgType === 'hybrid') はメッセージ粒度ではないので user/assistant の
    // 見た目から外し、ラベルも空にしておく (matchedBy バッジが識別子を兼ねる)。
    const roleClass = hit.msgType === 'user'
      ? 'user'
      : hit.msgType === 'assistant'
        ? 'assistant'
        : 'hybrid';
    const row = createEl('div', {
      className: `search-result-row ${roleClass}`,
    });

    const roleLabel = hit.msgType === 'user'
      ? 'USER'
      : hit.msgType === 'assistant'
        ? 'AI'
        : '';
    const role = createEl('div', {
      className: 'srr-role',
      textContent: roleLabel,
    });

    const main = createEl('div', { className: 'srr-main' });
    const snippet = createEl('div', { className: 'srr-snippet' });
    snippet.innerHTML = sanitizeSnippet(hit.snippet);
    main.append(snippet);

    // Hybrid 検索のバッジ (BM25 / ベクトル)。純 BM25 モードでは hit.matchedBy は
    // 付かないので何も描画しない。CSS ファイルを触らずインライン style で仕上げる。
    if (hit.matchedBy && hit.matchedBy.length > 0) {
      const badges = createEl('div', {});
      badges.style.cssText = 'display:flex;gap:4px;margin-top:2px;';
      for (const tag of hit.matchedBy) {
        const label = tag === 'bm25' ? t('hybridBadgeBm25') : t('hybridBadgeVector');
        const bg = tag === 'bm25' ? 'var(--accent-weak, #2a4a6b)' : 'var(--accent-alt-weak, #4a2a6b)';
        const b = createEl('span', { textContent: label });
        b.style.cssText = `font-size:10px;padding:1px 6px;border-radius:8px;background:${bg};color:var(--text-secondary);letter-spacing:.02em;`;
        badges.appendChild(b);
      }
      main.append(badges);
    }

    if (hit.contextBefore || hit.contextAfter) {
      const ctx = createEl('div', { className: 'srr-context' });
      if (hit.contextBefore) {
        const before = createEl('div', {
          className: 'srr-context-line',
          textContent: `\u2191 ${hit.contextBefore}`,
        });
        ctx.append(before);
      }
      if (hit.contextAfter) {
        const after = createEl('div', {
          className: 'srr-context-line',
          textContent: `\u2193 ${hit.contextAfter}`,
        });
        ctx.append(after);
      }
      main.append(ctx);
    }

    const meta = createEl('div', { className: 'srr-meta' });
    if (typeof hit.timestamp === 'number' && hit.timestamp > 0) {
      const dt = new Date(hit.timestamp);
      meta.textContent = dt.toLocaleDateString();
      meta.title = dt.toLocaleString();
    }

    row.append(role, main, meta);

    row.addEventListener('mouseenter', () => {
      // Hover-preview to the row even if it's not the keyboard-active one;
      // this matches macOS Mail search UX where the cursor and hover are
      // independent highlights.
      void loadPreviewFor(hit);
    });
    row.addEventListener('click', () => {
      const idx = rows.findIndex((r) => r.el === row);
      if (idx >= 0) setActiveIndex(idx, { scroll: false });
    });
    row.addEventListener('dblclick', () => {
      const idx = rows.findIndex((r) => r.el === row);
      if (idx >= 0) logOpen(hit, idx);
      void openSession(hit.sessionId, hit.messageIndex);
    });

    return row;
  }

  function setActiveIndex(idx: number, opts: { scroll?: boolean } = {}): void {
    if (rows.length === 0) {
      activeIdx = -1;
      return;
    }
    const next = Math.max(0, Math.min(idx, rows.length - 1));
    if (activeIdx >= 0 && activeIdx < rows.length) {
      rows[activeIdx].el.classList.remove('active');
      setHighlight(rows[activeIdx].el, false);
    }
    activeIdx = next;
    const row = rows[activeIdx];
    row.el.classList.add('active');
    setHighlight(row.el, true);
    if (opts.scroll) {
      row.el.scrollIntoView({ block: 'nearest' });
    }
    void loadPreviewFor(row.hit);
  }

  async function loadPreviewFor(hit: SearchHit): Promise<void> {
    if (hit.sessionId === lastPreviewSessionId && hit.messageIndex === lastPreviewMessageIndex) return;
    lastPreviewSessionId = hit.sessionId;
    lastPreviewMessageIndex = hit.messageIndex;

    const seq = ++previewSeq;
    const pane = byId<HTMLElement>('searchPreviewPane');
    pane.replaceChildren();
    const loading = createEl('div', { className: 'search-preview-empty', textContent: t('loadingContext') });
    pane.appendChild(loading);

    let res: PreviewResponse | null = null;
    try {
      res = await invoke('get_session_messages_around', {
        sessionId: hit.sessionId,
        messageIndex: hit.messageIndex,
        window: PREVIEW_WINDOW,
      });
    } catch (err) {
      console.warn('[search-view] preview fetch failed', err);
    }
    if (seq !== previewSeq) return;
    if (!res) {
      pane.replaceChildren();
      const errEl = createEl('div', { className: 'search-preview-empty', textContent: t('toastError') });
      pane.appendChild(errEl);
      return;
    }
    renderPreview(pane, hit, res);
  }

  function renderPreview(pane: HTMLElement, hit: SearchHit, res: PreviewResponse): void {
    pane.replaceChildren();

    const header = createEl('div', { className: 'search-preview-header' });
    const title = createEl('span', {
      className: 'sph-title',
      textContent: `${projectDisplayName(res.project)} \u00B7 ${getSessions().find((s) => s.sessionId === res.sessionId)?.firstDisplay || res.sessionId.slice(0, 8)}`,
    });
    const openBtn = createEl('button', {
      className: 'sph-open',
      textContent: t('searchOpenSession'),
      onClick: () => {
        const idx = rows.findIndex((r) => r.hit === hit);
        if (idx >= 0) logOpen(hit, idx);
        void openSession(hit.sessionId, hit.messageIndex);
      },
    });
    header.append(title, openBtn);
    pane.appendChild(header);

    const body = createEl('div', { className: 'search-preview-body' });
    pane.appendChild(body);

    const before = res.startIndex;
    if (before > 0) {
      const hint = createEl('div', {
        className: 'search-preview-hint',
        textContent: t('searchPreviewMoreBefore').replace('{n}', String(before)),
      });
      body.appendChild(hint);
    }

    res.messages.forEach((msg, i) => {
      const isFocus = i === res.focusOffset;
      const role = (msg.type || 'system').toLowerCase();
      const msgEl = createEl('div', {
        className: `search-preview-msg ${role}${isFocus ? ' focus' : ''}`,
      });
      const roleEl = createEl('div', {
        className: 'spm-role',
        textContent: role,
      });
      const textEl = createEl('div', {});
      const content = (msg.content || '').trim();
      if (isFocus && currentQuery) {
        textEl.innerHTML = highlightQuery(content, currentQuery);
      } else {
        textEl.textContent = content;
      }
      msgEl.append(roleEl, textEl);
      body.appendChild(msgEl);
    });

    const afterRemaining = res.total - (res.startIndex + res.messages.length);
    if (afterRemaining > 0) {
      const hint = createEl('div', {
        className: 'search-preview-hint',
        textContent: t('searchPreviewMoreAfter').replace('{n}', String(afterRemaining)),
      });
      body.appendChild(hint);
    }
  }

  function highlightQuery(content: string, query: string): string {
    const tokens = query.split(/\s+/).filter((s) => s.length >= 2);
    // Escape content first, then inject <mark> around matches. Using textContent
    // on a helper element avoids dealing with HTML entity encoding manually.
    const helper = document.createElement('div');
    helper.textContent = content;
    let html = helper.innerHTML;
    for (const token of tokens) {
      const pat = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      try {
        const re = new RegExp(`(${pat})`, 'gi');
        html = html.replace(re, '<mark>$1</mark>');
      } catch {
        // ignore invalid regex
      }
    }
    return html;
  }

  function moveActive(delta: number): void {
    if (rows.length === 0) return;
    const next = activeIdx < 0 ? 0 : activeIdx + delta;
    setActiveIndex(next, { scroll: true });
  }

  function confirmActive(): void {
    if (activeIdx < 0 || activeIdx >= rows.length) return;
    const hit = rows[activeIdx].hit;
    logOpen(hit, activeIdx);
    void openSession(hit.sessionId, hit.messageIndex);
  }

  function logOpen(hit: SearchHit, position: number): void {
    resultOpenedForCurrentQuery = true;
    const qid = getCurrentQueryId();
    if (!qid) return;
    searchTelemetry.append({
      type: 'open_result',
      queryId: qid,
      position,
      msgType: hit.msgType,
      timestamp: Date.now(),
    });
  }

  function handleKeyDown(e: KeyboardEvent): boolean {
    if (!active) return false;
    // When the user is typing in the global search input, Up/Down should still
    // navigate the result list so they can flow from query -> result without
    // leaving the keyboard.
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveActive(1);
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveActive(-1);
      return true;
    }
    if (e.key === 'Enter') {
      // Don't swallow Enter unless we actually have something to open.
      if (rows.length === 0) return false;
      e.preventDefault();
      confirmActive();
      return true;
    }
    if (e.key === 'Escape') {
      // Let the shortcut layer clear the input; we just signal that exit is
      // desired so app.ts can restore the previous view state.
      onRequestExit();
      return false;
    }
    return false;
  }

  return {
    isActive,
    enter,
    exit,
    renderResults,
    handleKeyDown,
    getFilters,
    getFilterPayload,
  };
}
