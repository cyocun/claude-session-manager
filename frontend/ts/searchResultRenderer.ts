import { sanitizeSnippet } from './searchUtils.js';
import { setHighlight } from './dom.js';
import { ICONS } from './icons.js';
import type { SearchHit, SearchMode } from './types.js';

export type SearchResultRendererDeps = {
  byId: (id: string) => any;
  t: (key: string) => string;
  getLang: () => string;
  getSessions: () => Array<{ sessionId: string; firstDisplay: string }>;
  projectDisplayName: (path: string) => string;
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<any>;
  showDetail: (sessionId: string) => Promise<void>;
  setSelectedSession: (sessionId: string) => void;
  chatSearch: { doSearch: () => void; scrollToMessageIndex: (messageIndex: number) => void };
  getActiveResolvedQuery: () => string;
  getSearchInputValue: () => string;
};

export function renderLoading(
  container: HTMLElement,
  indexReady: boolean,
  t: (key: string) => string,
): void {
  container.replaceChildren();
  const msg = document.createElement('div');
  msg.className = 'text-xs text-center py-8';
  msg.style.color = 'var(--text-faint)';
  msg.textContent = indexReady ? t('searchSearching') : t('searchIndexing');
  container.appendChild(msg);
}

export async function fetchContextSnippet(
  hit: SearchHit,
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<any>,
): Promise<{ before: string; current: string; after: string; likely: string } | null> {
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

type GroupedResults = Array<{
  project: string;
  sessions: Array<{ sessionId: string; hits: SearchHit[] }>;
  hitCount: number;
}>;

function groupResults(results: SearchHit[]): GroupedResults {
  const projMap: Record<string, Record<string, SearchHit[]>> = {};
  const projOrder: string[] = [];
  for (const hit of results) {
    if (!projMap[hit.project]) {
      projMap[hit.project] = {};
      projOrder.push(hit.project);
    }
    if (!projMap[hit.project][hit.sessionId]) {
      projMap[hit.project][hit.sessionId] = [];
    }
    projMap[hit.project][hit.sessionId].push(hit);
  }

  return projOrder.map((proj) => {
    const sessMap = projMap[proj];
    const sessions = Object.keys(sessMap).map((sessionId) => ({
      sessionId,
      hits: sessMap[sessionId],
    }));
    const hitCount = sessions.reduce((n, s) => n + s.hits.length, 0);
    return { project: proj, sessions, hitCount };
  });
}

function renderHitItem(
  hit: SearchHit,
  mode: SearchMode,
  deps: SearchResultRendererDeps,
  container: HTMLElement,
): HTMLElement {
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
    contextEl.textContent = deps.t('loadingContext');
    void fetchContextSnippet(hit, deps.invoke).then((ctx) => {
      if (!ctx) {
        contextEl.textContent = '';
        return;
      }
      const lines: string[] = [];
      if (ctx.before) lines.push(`\u2191 ${ctx.before}`);
      if (ctx.current) lines.push(`\u2022 ${ctx.current}`);
      if (ctx.after) lines.push(`\u2193 ${ctx.after}`);
      if (ctx.likely) lines.push(`${deps.t('likelySolution')}: ${ctx.likely}`);
      contextEl.textContent = lines.join('\n');
    });
  }

  item.addEventListener('click', () => {
    container.querySelectorAll('.search-hit-active').forEach((prev: Element) => {
      prev.classList.remove('search-hit-active');
      setHighlight(prev as HTMLElement, false);
    });
    item.classList.add('search-hit-active');
    setHighlight(item, true);
    deps.setSelectedSession(hit.sessionId);
    void deps.showDetail(hit.sessionId).then(() => {
      const q = deps.getActiveResolvedQuery() || deps.getSearchInputValue();
      const chatInput = deps.byId('chatSearch') as HTMLInputElement | null;
      if (q && chatInput) {
        chatInput.value = q;
        deps.chatSearch.doSearch();
      }
      deps.chatSearch.scrollToMessageIndex(hit.messageIndex);
    });
  });

  return item;
}

export function renderSearchResults(
  results: SearchHit[],
  mode: SearchMode,
  indexReady: boolean,
  deps: SearchResultRendererDeps,
): void {
  const container = deps.byId('sessionList') as HTMLElement;
  container.replaceChildren();

  if (results.length === 0) {
    const msg = document.createElement('div');
    msg.className = 'text-xs text-center py-8';
    msg.style.color = 'var(--text-faint)';
    msg.textContent = indexReady
      ? (mode === 'similar' ? deps.t('similarNoResults') : deps.t('searchNoResults'))
      : deps.t('searchIndexing');
    container.appendChild(msg);
    deps.byId('sessionListTitle').textContent = indexReady
      ? (mode === 'similar' ? deps.t('similarNoResults') : deps.t('searchNoResults'))
      : deps.t('searchIndexing');
    return;
  }

  deps.byId('sessionListTitle').textContent =
    deps.t('searchResults').replace('{n}', String(results.length)) +
    (indexReady ? '' : ` (${deps.t('searchIndexing')})`);

  const sessionTitleMap = new Map<string, string>();
  deps.getSessions().forEach((summary) => {
    sessionTitleMap.set(summary.sessionId, summary.firstDisplay);
  });

  const grouped = groupResults(results);

  for (const projGroup of grouped) {
    const group = document.createElement('div');
    group.className = 'project-group';

    const chevron = document.createElement('span');
    chevron.className = 'project-group-chevron open';
    chevron.textContent = '\u25B6';

    const icon = document.createElement('span');
    icon.className = 'project-group-icon';
    icon.innerHTML = ICONS.folder;

    const name = document.createElement('span');
    name.className = 'text-xs font-medium flex-1 truncate';
    name.textContent = deps.projectDisplayName(projGroup.project);
    name.style.color = 'var(--text-secondary)';

    const count = document.createElement('span');
    count.className = 'text-[10px] flex-shrink-0';
    count.textContent = String(projGroup.hitCount);
    count.style.color = 'var(--text-muted)';

    const header = document.createElement('div');
    header.className = 'project-group-header';
    header.append(chevron, icon, name, count);

    const sessionsDiv = document.createElement('div');
    sessionsDiv.className = 'project-group-sessions open';

    for (const sess of projGroup.sessions) {
      const title = sessionTitleMap.get(sess.sessionId) || sess.sessionId.slice(0, 8);

      const sessTitle = document.createElement('span');
      sessTitle.className = 'text-sm leading-snug truncate';
      sessTitle.textContent = title;
      sessTitle.style.color = 'var(--text)';

      const sessHitCount = document.createElement('span');
      sessHitCount.className = 'text-[10px] flex-shrink-0';
      sessHitCount.textContent = `${sess.hits.length}${sess.hits.length === 1 ? ' hit' : ' hits'}`;
      sessHitCount.style.color = 'var(--text-faint)';

      const sessHeader = document.createElement('div');
      sessHeader.className = 'px-3 pt-2 pb-1';
      sessHeader.style.cssText = 'display:flex;align-items:baseline;gap:8px;justify-content:space-between;border-top:1px solid var(--border);margin-top:4px;padding-top:8px;';
      sessHeader.append(sessTitle, sessHitCount);
      sessionsDiv.appendChild(sessHeader);

      for (const hit of sess.hits) {
        sessionsDiv.appendChild(renderHitItem(hit, mode, deps, container));
      }
    }

    header.addEventListener('click', () => {
      chevron.classList.toggle('open');
      sessionsDiv.classList.toggle('open');
    });

    group.append(header, sessionsDiv);
    container.appendChild(group);
  }
}
