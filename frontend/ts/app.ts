import { detectLang, translate } from './i18n.js';
import { createEl } from './dom.js';
import { getThemePref, applyTheme, watchSystemTheme } from './theme.js';
import { invoke, isTauri } from './tauri.js';
import { isRemoteHost, shortPath, shortPathElements, timeAgo } from './utils.js';
import {
  getPreviewDetailCached,
  hidePreview,
  initPreview,
  schedulePreviewHide,
  schedulePreviewShow,
  setPreviewDetailCached,
} from './preview.js';
import { createChatSearchController } from './chatSearch.js';
import { createFullTextSearchController } from './fullTextSearch.js';
import { renderToolBlocks } from './toolRenderer.js';
import { createSessionActions } from './sessionActions.js';
import { initKeyboardNavigation, initResizeHandle } from './layoutControls.js';

const tauriWindow = window.__TAURI__ as any;
const byId = (id: string) => document.getElementById(id) as any;

type SessionSummary = {
  sessionId: string;
  project: string;
  firstDisplay: string;
  lastDisplay?: string;
  lastTimestamp: number;
  messageCount: number;
  archived?: boolean;
};

type ProjectInfo = { path: string; name?: string; lastSessionId?: string; sessionCount?: number; lastTimestamp?: number };
type ProjectGroup = { path: string; sessions: SessionSummary[] };
type DetailMessage = { type: string; content?: string; tools?: any[] };
type SessionDetail = { project: string; messages: DetailMessage[] };
type MsgDesc = { msg: DetailMessage; hasText: boolean; hasTools: boolean; origIdx: number };
type TokenTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
};
type TokenProjectRow = {
  project: string;
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
};
type TokenTimePoint = {
  label: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
};
type TokenSessionRow = {
  sessionId: string;
  project: string;
  lastTimestamp: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
};
type ToolUsageEntry = { name: string; count: number };
type ModelBreakdown = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  messageCount: number;
};
type WordFreqEntry = { word: string; count: number };
type TokenDashboard = {
  totals: TokenTotals;
  byHour: TokenTimePoint[];
  byProject: TokenProjectRow[];
  byDay: TokenTimePoint[];
  byWeek: TokenTimePoint[];
  byMonth: TokenTimePoint[];
  bySession: TokenSessionRow[];
  toolUsage: ToolUsageEntry[];
  byModel: ModelBreakdown[];
  wordFreq: WordFreqEntry[];
};
type TokenTrendPeriod = 'hour' | 'day' | 'week' | 'month';

let lang = detectLang();
function t(key: string): string { return translate(lang, key); }

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const node = el as HTMLElement;
    el.textContent = t(node.dataset.i18n || '');
  });
  document.querySelectorAll('[data-i18n-option]').forEach(el => {
    const node = el as HTMLElement;
    el.textContent = t(node.dataset.i18nOption || '');
  });
  byId('search').placeholder = t('searchContent');
  const cs = byId('chatSearch');
  if (cs) cs.placeholder = t('chatSearchPlaceholder');
  byId('newSessionBtn').title = lang === 'ja' ? '新規セッション' : 'New Session';
  const tokenBtn = byId('tokenDashboardBtn') as HTMLButtonElement | null;
  if (tokenBtn) tokenBtn.title = t('tokenDashboard');
}

// --- Theme ---
let themePref = getThemePref();
watchSystemTheme(() => {
  if (themePref === 'system') applyTheme(themePref);
});

// --- Markdown ---
const md = window.markdownit({
  html: false, breaks: true, linkify: true,
  highlight: function(str: string, codeLang: string) {
    if (codeLang && hljs.getLanguage(codeLang)) {
      try { return hljs.highlight(str, { language: codeLang }).value; } catch {}
    }
    try { return hljs.highlightAuto(str).value; } catch {}
    return '';
  }
});
function renderMarkdown(text: string): string { return DOMPurify.sanitize(md.render(text)); }

// --- State ---
let sessions: SessionSummary[] = [];
let projects: ProjectInfo[] = [];
let selectedProject: string | null = null;
let selectedSession: string | null = null;
let selectedIds = new Set<string>();
let serverSettings: any = {};
let projectNameMap: Record<string, string> = {}; // path -> display name
// Stores projects the user has explicitly toggled open/closed
let toggledProjects = new Set<string>(JSON.parse(localStorage.getItem('csm-toggled') || '[]'));
// Stores projects where "show older" has been clicked
let showAllSessions = new Set<string>();
let openedAt = Date.now();
let knownTimestamps: Record<string, number> = {}; // sessionId -> lastTimestamp at first load
let isFirstLoad = true;
let allMessagesRendered = true;
let renderAbort: { aborted: boolean } | null = null;
let tokenModal: HTMLElement | null = null;
let isPreviewHotkeyPressed = false;
// Search controllers are pure modules; app.ts wires them to current state/getters.
const chatSearch = createChatSearchController({
  byId,
  t,
  isAllMessagesRendered: () => allMessagesRendered,
});
const fullTextSearch = createFullTextSearchController({
  byId,
  t,
  getLang: () => lang,
  getSessions: () => sessions,
  getSelectedProject: () => selectedProject,
  projectDisplayName,
  invoke,
  renderSessions,
  showDetail,
  setSelectedSession: (sessionId: string) => { selectedSession = sessionId; },
  chatSearch,
});
const actions = createSessionActions({
  byId,
  t,
  getLang: () => lang,
  invoke,
  fetchSessions,
  getShowArchived: () => (byId('showArchived') as HTMLInputElement).checked,
  getSelectedIds: () => selectedIds,
  clearSelectedIds: () => { selectedIds.clear(); },
  getSessions: () => sessions,
});

async function fetchSessions(includeArchived = false) {
  sessions = await invoke('list_sessions', { includeArchived }) || [];
  if (isFirstLoad) {
    sessions.forEach(s => { knownTimestamps[s.sessionId] = s.lastTimestamp; });
    isFirstLoad = false;
  }
  renderSessions();
}
function isUpdatedSession(s: SessionSummary): boolean {
  if (!(s.sessionId in knownTimestamps)) return true; // new session
  return s.lastTimestamp > knownTimestamps[s.sessionId]; // timestamp changed
}
async function fetchProjects() {
  projects = await invoke('list_projects') || [];
  projectNameMap = {};
  projects.forEach(p => { if (p.name) projectNameMap[p.path] = p.name; });
  renderProjects();
}
async function fetchDetail(sessionId: string): Promise<SessionDetail | null> {
  const detail = await invoke('get_session_detail', { sessionId });
  return detail as SessionDetail | null;
}
async function fetchSettings() {
  serverSettings = await invoke('get_settings') || {};
}

function projectDisplayName(path: string): string {
  return projectNameMap[path] || shortPath(path).split('/').pop() || shortPath(path);
}
function isRemote() {
  return isRemoteHost(location.hostname);
}

function isDetailPaneVisible(): boolean {
  const pane = byId('detailPane') as HTMLElement | null;
  return !!pane && pane.style.display !== 'none';
}

// --- Rendering ---

function renderProjects() {
  // Projects are now only used for display name mapping, no sidebar rendering
  projectNameMap = {};
  projects.forEach(p => { if (p.name) projectNameMap[p.path] = p.name; });
}

// --- Startup project cards ---
const iconCache = new Map<string, string | null>();

function hashColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return `hsl(${hue}, 55%, 50%)`;
}

function renderInitialAvatar(name: string): HTMLElement {
  const initial = (name || '?').charAt(0).toUpperCase();
  const el = createEl('div', { className: 'startup-card-initial', textContent: initial });
  el.style.background = hashColor(name);
  return el;
}

async function openReadmeWindow(projectPath: string, projectName: string) {
  const result = await invoke('open_readme_window', { project: projectPath, name: projectName });
  if (result === null) {
    actions.showToast(t('readmeNotFound'));
  }
}

function renderProjectCard(p: ProjectInfo, iconUri: string | null): HTMLElement {
  const card = createEl('div', { className: 'startup-card', onClick: () => focusProjectInSidebar(p.path) });
  card.style.cursor = 'pointer';
  const name = projectDisplayName(p.path);

  let iconEl: HTMLElement;
  if (iconUri) {
    iconEl = createEl('img', { className: 'startup-card-icon' }) as HTMLImageElement;
    (iconEl as HTMLImageElement).src = iconUri;
    (iconEl as HTMLImageElement).alt = name;
  } else {
    iconEl = renderInitialAvatar(name);
  }

  const info = createEl('div', {});
  const nameEl = createEl('div', { className: 'startup-card-name', textContent: name });
  nameEl.title = name;
  const pathEl = createEl('div', { className: 'startup-card-path', textContent: shortPath(p.path) });
  pathEl.title = p.path;

  const actionsRow = createEl('div', { className: 'startup-card-actions' });
  const newBtn = createEl('button', {
    className: 'mac-btn', textContent: t('newSession'),
    onClick: () => { invoke('start_new_session_in_project', { project: p.path }); },
  });
  actionsRow.appendChild(newBtn);

  if (p.lastSessionId) {
    const resumeBtn = createEl('button', {
      className: 'mac-btn mac-btn-primary', textContent: t('resumeLast'),
      onClick: () => { actions.resumeInTerminal(p.lastSessionId!); },
    });
    actionsRow.appendChild(resumeBtn);
  }

  const readmeBtn = createEl('button', {
    className: 'mac-btn', textContent: t('readme'),
    onClick: () => { openReadmeWindow(p.path, name); },
  });
  actionsRow.appendChild(readmeBtn);

  info.appendChild(nameEl);
  info.appendChild(pathEl);
  info.appendChild(actionsRow);
  card.appendChild(iconEl);
  card.appendChild(info);
  return card;
}

async function fetchIcons(list: ProjectInfo[]): Promise<(string | null)[]> {
  return Promise.all(list.map(async (p) => {
    if (iconCache.has(p.path)) return iconCache.get(p.path)!;
    try {
      const uri: string | null = await invoke('get_project_icon', { project: p.path });
      iconCache.set(p.path, uri);
      return uri;
    } catch {
      iconCache.set(p.path, null);
      return null;
    }
  }));
}

const INITIAL_PROJECT_COUNT = 4;

async function renderStartupCards() {
  if (projects.length === 0) return null;

  const initial = projects.slice(0, INITIAL_PROJECT_COUNT);
  const container = createEl('div', { className: 'startup-container' });
  const heading = createEl('div', { className: 'startup-heading', textContent: t('recentProjects') });
  const grid = createEl('div', { className: 'startup-grid' });

  const icons = await fetchIcons(initial);
  initial.forEach((p, i) => grid.appendChild(renderProjectCard(p, icons[i])));

  container.appendChild(heading);
  container.appendChild(grid);

  if (projects.length > INITIAL_PROJECT_COUNT) {
    const moreBtn = createEl('button', {
      className: 'mac-btn startup-more-btn',
      textContent: `More (${projects.length - INITIAL_PROJECT_COUNT})`,
      onClick: async () => {
        const rest = projects.slice(INITIAL_PROJECT_COUNT);
        const restIcons = await fetchIcons(rest);
        rest.forEach((p, i) => grid.appendChild(renderProjectCard(p, restIcons[i])));
        moreBtn.remove();
        // More展開後はコンテンツが増えるので中央配置を解除してスクロール可能に
        container.style.justifyContent = 'flex-start';
        requestAnimationFrame(() => {
          container.scrollTop = 0;
        });
      },
    });
    container.appendChild(moreBtn);
  }

  return container;
}

function showStartupView() {
  const pane = byId('detailPane');
  const messagesEl = byId('detailMessages');
  const headerEl = byId('detailHeader');
  const footerEl = byId('detailFooter');

  document.body.style.gridTemplateColumns = '280px 1px 1fr';
  if (isTauri) {
    tauriWindow.window.getCurrentWindow().setMinSize(new tauriWindow.window.LogicalSize(700, 500));
  }
  byId('resizeHandle').style.display = '';
  pane.style.display = 'grid';
  messagesEl.style.display = 'grid';
  headerEl.replaceChildren();
  footerEl.replaceChildren();

  renderStartupCards().then(el => {
    if (el) messagesEl.replaceChildren(el);
  });
}

const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
const TOKEN_LIMIT_KEYS = {
  input: 'csm-token-limit-input',
  output: 'csm-token-limit-output',
  total: 'csm-token-limit-total',
} as const;
const TOKEN_TREND_POINT_LIMIT: Record<TokenTrendPeriod, number> = {
  hour: 48,
  day: 30,
  week: 26,
  month: 24,
};

function focusProjectInSidebar(projectPath: string): void {
  const displayName = projectDisplayName(projectPath);

  // Find the matching group header in the DOM
  const findAndFocus = () => {
    const headers = Array.from(document.querySelectorAll('.project-group-header'));
    let targetHeader: Element | null = null;
    for (const h of headers) {
      const nameEl = h.querySelector('.truncate');
      if (nameEl?.textContent === displayName) {
        targetHeader = h;
        break;
      }
    }
    if (!targetHeader) return false;

    // Ensure accordion is open
    const chevron = targetHeader.querySelector('.project-group-chevron');
    const sessionsDiv = targetHeader.nextElementSibling;
    if (chevron && !chevron.classList.contains('open')) {
      chevron.classList.add('open');
      sessionsDiv?.classList.add('open');
      if (toggledProjects.has(projectPath)) toggledProjects.delete(projectPath);
      else toggledProjects.add(projectPath);
      saveToggled();
    }

    targetHeader.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return true;
  };

  // If not found, clear search filter and try again
  if (!findAndFocus()) {
    const searchEl = byId('search') as HTMLInputElement;
    if (searchEl.value) {
      searchEl.value = '';
      renderSessions();
    }
    requestAnimationFrame(findAndFocus);
  }
}

function isRecentProject(g: ProjectGroup): boolean {
  return (Date.now() - g.sessions[0].lastTimestamp) < SEVEN_DAYS;
}

function isProjectOpen(g: ProjectGroup): boolean {
  // User explicitly toggled -> respect that
  if (toggledProjects.has(g.path)) {
    // toggled means: flip the default
    // default open = recent, default closed = old
    return !isRecentProject(g);
  }
  // Default: open if recent
  return isRecentProject(g);
}

function saveToggled() {
  localStorage.setItem('csm-toggled', JSON.stringify([...toggledProjects]));
}

function formatNum(n: number | undefined): string {
  return Intl.NumberFormat(lang === 'ja' ? 'ja-JP' : 'en-US').format(Math.round(n || 0));
}

function formatUsd(v: number | undefined): string {
  const n = v || 0;
  return '$' + (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(3));
}

function formatCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + 'B';
  if (abs >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (abs >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(Math.round(n));
}

function parseTokenLimit(name: string): number {
  const raw = localStorage.getItem(name);
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function saveTokenLimit(name: string, value: string) {
  const n = Number(value);
  if (!value.trim() || !Number.isFinite(n) || n <= 0) {
    localStorage.removeItem(name);
    return;
  }
  localStorage.setItem(name, String(Math.round(n)));
}

// --- Chart color constants ---
const CHART_COLORS = {
  input: '#34d399',
  output: '#818cf8',
  cacheRead: '#fbbf24',
  cacheCreate: '#f87171',
  models: { opus: '#a78bfa', sonnet: '#818cf8', haiku: '#34d399' } as Record<string, string>,
  tools: { Bash: '#f87171', Read: '#34d399', Edit: '#818cf8', Write: '#fbbf24', Glob: '#a78bfa', Grep: '#38bdf8', Agent: '#fb923c' } as Record<string, string>,
  toolDefault: '#6b7280',
  wordPalette: ['#818cf8', '#34d399', '#f87171', '#fbbf24', '#a78bfa', '#38bdf8', '#fb923c', '#6b7280'],
};

function getCanvasSetup(canvas: HTMLCanvasElement, height: number): { ctx: CanvasRenderingContext2D; width: number; height: number; dpr: number } | null {
  const parentWidth = canvas.parentElement?.clientWidth || 760;
  const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
  const width = Math.max(320, parentWidth - 16);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height, dpr };
}

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.body).getPropertyValue(name).trim() || fallback;
}

let chartTooltip: HTMLElement | null = null;
function buildTooltipContent(lines: { color?: string; label: string; bold?: boolean }[]): HTMLElement {
  const frag = createEl('div');
  lines.forEach(line => {
    const row = createEl('div', { style: 'display:flex;gap:6px;align-items:center' });
    if (line.color) {
      const dot = createEl('span') as HTMLElement;
      dot.style.cssText = `width:8px;height:8px;border-radius:2px;background:${line.color};display:inline-block;flex-shrink:0`;
      row.appendChild(dot);
    }
    const text = createEl(line.bold ? 'b' : 'span', { textContent: line.label });
    row.appendChild(text);
    frag.appendChild(row);
  });
  return frag;
}
function showChartTooltipEl(parent: HTMLElement, x: number, y: number, content: HTMLElement) {
  if (!chartTooltip) {
    chartTooltip = createEl('div', { className: 'chart-tooltip' });
    document.body.appendChild(chartTooltip);
  }
  chartTooltip.replaceChildren(content);
  chartTooltip.style.display = 'block';
  const rect = parent.getBoundingClientRect();
  let left = rect.left + x + 12;
  let top = rect.top + y - 10;
  if (left + 200 > window.innerWidth) left = rect.left + x - 200;
  if (top < 0) top = rect.top + y + 20;
  chartTooltip.style.left = `${left}px`;
  chartTooltip.style.top = `${top}px`;
}
function hideChartTooltip() {
  if (chartTooltip) chartTooltip.style.display = 'none';
}

function animateCounter(el: HTMLElement, target: number, format: (n: number) => string, duration = 400) {
  const start = performance.now();
  const easeOutExpo = (t: number) => t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
  function tick(now: number) {
    const elapsed = Math.min((now - start) / duration, 1);
    const val = target * easeOutExpo(elapsed);
    el.textContent = format(val);
    if (elapsed < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function drawStackedAreaChart(canvas: HTMLCanvasElement, points: TokenTimePoint[]) {
  const setup = getCanvasSetup(canvas, 280);
  if (!setup || !points.length) return;
  const { ctx, width, height } = setup;
  const padL = 50, padR = 16, padT = 16, padB = 32;
  const chartW = width - padL - padR;
  const chartH = height - padT - padB;

  const layers = points.map(p => [
    p.inputTokens,
    p.outputTokens,
    p.cacheReadInputTokens || 0,
    p.cacheCreationInputTokens || 0,
  ]);
  const maxY = Math.max(...layers.map(l => l.reduce((a, b) => a + b, 0)), 1);
  const colors = [CHART_COLORS.input, CHART_COLORS.output, CHART_COLORS.cacheRead, CHART_COLORS.cacheCreate];
  const labels = ['Input', 'Output', 'Cache Read', 'Cache Create'];

  const x = (i: number) => padL + (points.length === 1 ? chartW / 2 : (i * chartW) / (points.length - 1));
  const y = (v: number) => padT + (1 - v / maxY) * chartH;

  // Grid
  ctx.strokeStyle = cssVar('--border', '#888');
  ctx.lineWidth = 0.5;
  ctx.setLineDash([4, 4]);
  for (let i = 0; i <= 4; i++) {
    const gy = padT + (chartH * i) / 4;
    ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(width - padR, gy); ctx.stroke();
  }
  ctx.setLineDash([]);

  // Stacked areas
  for (let layerIdx = colors.length - 1; layerIdx >= 0; layerIdx--) {
    ctx.beginPath();
    for (let i = 0; i < points.length; i++) {
      let cumTop = 0;
      for (let j = 0; j <= layerIdx; j++) cumTop += layers[i][j];
      const px = x(i), py = y(cumTop);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    for (let i = points.length - 1; i >= 0; i--) {
      let cumBot = 0;
      for (let j = 0; j < layerIdx; j++) cumBot += layers[i][j];
      ctx.lineTo(x(i), y(cumBot));
    }
    ctx.closePath();
    ctx.fillStyle = colors[layerIdx] + '59';
    ctx.fill();
    ctx.beginPath();
    for (let i = 0; i < points.length; i++) {
      let cumTop = 0;
      for (let j = 0; j <= layerIdx; j++) cumTop += layers[i][j];
      const px = x(i), py = y(cumTop);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = colors[layerIdx];
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Y-axis
  ctx.fillStyle = cssVar('--text-faint', '#888');
  ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const val = maxY * (1 - i / 4);
    ctx.fillText(formatCompact(val), padL - 6, padT + (chartH * i) / 4 + 3);
  }
  // X-axis
  ctx.textAlign = 'center';
  const tickCount = Math.min(points.length, 7);
  for (let t = 0; t < tickCount; t++) {
    const idx = tickCount === 1 ? 0 : Math.round(t * (points.length - 1) / (tickCount - 1));
    ctx.fillText(points[idx].label, x(idx), height - 8);
  }

  // Hover
  canvas.onmousemove = (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    if (mx < padL || mx > width - padR) { hideChartTooltip(); return; }
    const idx = Math.round(((mx - padL) / chartW) * (points.length - 1));
    if (idx < 0 || idx >= points.length) { hideChartTooltip(); return; }
    const p = points[idx];
    const vals = [p.inputTokens, p.outputTokens, p.cacheReadInputTokens || 0, p.cacheCreationInputTokens || 0];
    const tipLines: { color?: string; label: string; bold?: boolean }[] = [{ label: p.label, bold: true }];
    vals.forEach((v, i) => tipLines.push({ color: colors[i], label: `${labels[i]}: ${formatNum(v)}` }));
    tipLines.push({ label: `Total: ${formatNum(p.totalTokens)}`, bold: true });
    showChartTooltipEl(canvas, mx, e.clientY - rect.top, buildTooltipContent(tipLines));
  };
  canvas.onmouseleave = () => hideChartTooltip();
}

type DonutSegment = { label: string; value: number; color: string };
function drawDonutChart(canvas: HTMLCanvasElement, segments: DonutSegment[], centerLabel?: string) {
  const size = 200;
  const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);

  const cx = size / 2, cy = size / 2, R = 88, r = 52;
  const total = segments.reduce((a, s) => a + s.value, 0);
  if (total === 0) return;

  let angle = -Math.PI / 2;
  const segAngles: { start: number; end: number }[] = [];
  segments.forEach(seg => {
    const sliceAngle = (seg.value / total) * Math.PI * 2;
    const gap = segments.length > 1 && seg.value / total < 0.95 ? 0.02 : 0;
    const start = angle + gap;
    const end = angle + sliceAngle - gap;
    segAngles.push({ start, end });
    ctx.beginPath();
    ctx.arc(cx, cy, R, start, end);
    ctx.arc(cx, cy, r, end, start, true);
    ctx.closePath();
    ctx.fillStyle = seg.color;
    ctx.fill();
    angle += sliceAngle;
  });

  if (centerLabel) {
    ctx.fillStyle = cssVar('--text-secondary', '#333');
    ctx.font = 'bold 18px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(centerLabel, cx, cy);
  }

  canvas.onmousemove = (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (size / rect.width);
    const my = (e.clientY - rect.top) * (size / rect.height);
    const dx = mx - cx, dy = my - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < r || dist > R) { hideChartTooltip(); return; }
    let a = Math.atan2(dy, dx);
    if (a < -Math.PI / 2) a += Math.PI * 2;
    const idx = segAngles.findIndex(s => a >= s.start && a <= s.end);
    if (idx < 0) { hideChartTooltip(); return; }
    const seg = segments[idx];
    const pct = ((seg.value / total) * 100).toFixed(1);
    showChartTooltipEl(canvas, e.clientX - rect.left, e.clientY - rect.top,
      buildTooltipContent([{ color: seg.color, label: seg.label, bold: true }, { label: `${formatNum(seg.value)} (${pct}%)` }]));
  };
  canvas.onmouseleave = () => hideChartTooltip();
}

function drawHeatmap(canvas: HTMLCanvasElement, byDay: TokenTimePoint[]) {
  const cellSize = 11, gap = 2, cols = 53, rows = 7;
  const padL = 28, padT = 18, padR = 4, padB = 4;
  const w = padL + cols * (cellSize + gap) + padR;
  const h = padT + rows * (cellSize + gap) + padB;
  const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const dayMap = new Map<string, number>();
  byDay.forEach(d => dayMap.set(d.label, d.totalTokens));

  const today = new Date();
  const dates: Date[] = [];
  for (let i = cols * rows - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    dates.push(d);
  }

  const maxVal = Math.max(...[...dayMap.values()], 1);
  const accent = cssVar('--accent', '#0a84ff');
  const emptyColor = cssVar('--bg-surface', '#fff');
  const alphas = [0, 0.2, 0.4, 0.7, 1.0];

  ctx.fillStyle = cssVar('--text-faint', '#888');
  ctx.font = '9px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign = 'right';
  const dayLabels = lang === 'ja' ? ['月', '', '水', '', '金', '', ''] : ['Mon', '', 'Wed', '', 'Fri', '', ''];
  dayLabels.forEach((label, i) => {
    if (label) ctx.fillText(label, padL - 4, padT + i * (cellSize + gap) + cellSize - 1);
  });

  ctx.textAlign = 'center';
  let lastMonth = -1;
  const months = lang === 'ja'
    ? ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月']
    : ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  dates.forEach((d, i) => {
    const col = Math.floor(i / rows);
    const row = i % rows;
    if (row === 0 && d.getMonth() !== lastMonth) {
      ctx.fillStyle = cssVar('--text-faint', '#888');
      ctx.fillText(months[d.getMonth()], padL + col * (cellSize + gap) + cellSize / 2, padT - 6);
      lastMonth = d.getMonth();
    }

    const key = d.toISOString().slice(0, 10);
    const val = dayMap.get(key) || 0;
    const level = val === 0 ? 0 : Math.min(4, Math.ceil((val / maxVal) * 4));
    const cellX = padL + col * (cellSize + gap);
    const cellY = padT + row * (cellSize + gap);

    if (level === 0) {
      ctx.fillStyle = emptyColor;
      ctx.strokeStyle = cssVar('--border', '#ddd');
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.roundRect(cellX, cellY, cellSize, cellSize, 2);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.fillStyle = accent;
      ctx.globalAlpha = alphas[level];
      ctx.beginPath();
      ctx.roundRect(cellX, cellY, cellSize, cellSize, 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  });

  canvas.onmousemove = (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (w / rect.width);
    const my = (e.clientY - rect.top) * (h / rect.height);
    const col = Math.floor((mx - padL) / (cellSize + gap));
    const row = Math.floor((my - padT) / (cellSize + gap));
    if (col < 0 || col >= cols || row < 0 || row >= rows) { hideChartTooltip(); return; }
    const idx = col * rows + row;
    if (idx >= dates.length) { hideChartTooltip(); return; }
    const d = dates[idx];
    const key = d.toISOString().slice(0, 10);
    const val = dayMap.get(key) || 0;
    showChartTooltipEl(canvas, e.clientX - rect.left, e.clientY - rect.top,
      buildTooltipContent([{ label: key, bold: true }, { label: `${formatNum(val)} tokens` }]));
  };
  canvas.onmouseleave = () => hideChartTooltip();
}

function drawWordCloud(canvas: HTMLCanvasElement, words: WordFreqEntry[]) {
  const w = 380, h = 260;
  const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  if (!ctx || !words.length) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const top = words.slice(0, 40);
  const maxFreq = top[0]?.count || 1;
  const placed: { x: number; y: number; w: number; h: number }[] = [];
  const cx = w / 2, cy = h / 2;
  const palette = CHART_COLORS.wordPalette;

  top.forEach((entry, idx) => {
    const fontSize = 12 + (entry.count / maxFreq) * 28;
    ctx.font = `${Math.round(fontSize)}px -apple-system, BlinkMacSystemFont, sans-serif`;
    const metrics = ctx.measureText(entry.word);
    const tw = metrics.width + 4;
    const th = fontSize + 4;

    let angle = 0, radius = 0;
    let px = 0, py = 0;
    let found = false;
    for (let step = 0; step < 500; step++) {
      px = cx + radius * Math.cos(angle) - tw / 2;
      py = cy + radius * Math.sin(angle) - th / 2;
      if (px < 0 || py < 0 || px + tw > w || py + th > h) { angle += 0.3; radius += 0.4; continue; }
      const collides = placed.some(p => !(px + tw < p.x || px > p.x + p.w || py + th < p.y || py > p.y + p.h));
      if (!collides) { found = true; break; }
      angle += 0.3; radius += 0.4;
    }
    if (!found) return;

    placed.push({ x: px, y: py, w: tw, h: th });
    ctx.fillStyle = palette[idx % palette.length];
    ctx.font = `${Math.round(fontSize)}px -apple-system, BlinkMacSystemFont, sans-serif`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText(entry.word, px + 2, py + 2);
  });

  canvas.onmousemove = (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (w / rect.width);
    const my = (e.clientY - rect.top) * (h / rect.height);
    const hit = placed.findIndex((p, i) => i < top.length && mx >= p.x && mx <= p.x + p.w && my >= p.y && my <= p.y + p.h);
    if (hit < 0) { hideChartTooltip(); canvas.style.cursor = 'default'; return; }
    canvas.style.cursor = 'pointer';
    const countLabel = `${top[hit].count} ${lang === 'ja' ? '回' : 'times'}`;
    showChartTooltipEl(canvas, e.clientX - rect.left, e.clientY - rect.top,
      buildTooltipContent([{ label: top[hit].word, bold: true }, { label: countLabel }]));
  };
  canvas.onmouseleave = () => { hideChartTooltip(); canvas.style.cursor = 'default'; };
}

function closeTokenModal() {
  if (!tokenModal) return;
  tokenModal.remove();
  tokenModal = null;
}

function mkTokenTable(headers: string[], rows: string[][]): HTMLElement {
  const table = createEl('table', { className: 'token-table' });
  const thead = createEl('thead');
  const trh = createEl('tr');
  headers.forEach(h => trh.appendChild(createEl('th', { textContent: h })));
  thead.appendChild(trh);
  table.appendChild(thead);
  const tbody = createEl('tbody');
  rows.forEach(r => {
    const tr = createEl('tr');
    r.forEach(c => tr.appendChild(createEl('td', { textContent: c })));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  return table;
}

function tokenTrendPoints(data: TokenDashboard, period: TokenTrendPeriod): TokenTimePoint[] {
  if (period === 'hour') return data.byHour.slice(-TOKEN_TREND_POINT_LIMIT.hour);
  if (period === 'day') return data.byDay.slice(-TOKEN_TREND_POINT_LIMIT.day);
  if (period === 'week') return data.byWeek.slice(-TOKEN_TREND_POINT_LIMIT.week);
  return data.byMonth.slice(-TOKEN_TREND_POINT_LIMIT.month);
}

type TimeRange = { label: string; days: number | null };
const TIME_RANGES: TimeRange[] = [
  { label: '1W', days: 7 },
  { label: '2W', days: 14 },
  { label: '1M', days: 30 },
  { label: '3M', days: 90 },
  { label: '6M', days: 180 },
  { label: '1Y', days: 365 },
  { label: 'All', days: null },
];

async function openTokenModal(): Promise<void> {
  closeTokenModal();
  const modal = createEl('div', {
    className: 'project-summary-modal',
    onClick: (e: Event) => {
      if (e.target === modal) closeTokenModal();
    }
  });
  const title = createEl('div', { className: 'text-sm font-medium truncate', textContent: t('tokenTitle') });
  title.style.color = 'var(--text-secondary)';
  const usageBtn = createEl('button', { className: 'mac-btn text-xs', textContent: t('tokenOpenUsage') });
  const refreshBtn = createEl('button', { className: 'mac-btn text-xs', textContent: t('tokenRefresh') });
  const closeBtn = createEl('button', { className: 'token-close-btn', textContent: '\u00D7' });
  const body = createEl('div', { className: 'project-summary-body', textContent: t('loading') });

  // Time range selector
  const rangePills = createEl('div', { className: 'token-pill-group' });
  let selectedRange: number | null = null; // null = all
  TIME_RANGES.forEach(r => {
    const btn = createEl('button', {
      className: 'token-pill-btn' + (r.days === selectedRange ? ' active' : ''),
      textContent: r.label,
    });
    btn.addEventListener('click', () => {
      selectedRange = r.days;
      rangePills.querySelectorAll('.token-pill-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      void renderData();
    });
    rangePills.appendChild(btn);
  });
  // Activate "All" by default
  (rangePills.lastElementChild as HTMLElement)?.classList.add('active');

  const headerRow1 = createEl('div', { className: 'token-header-row' }, [title, createEl('span', { style: 'flex:1' }), closeBtn]);
  const headerRow2 = createEl('div', { className: 'token-header-row' }, [rangePills, createEl('span', { style: 'flex:1' }), usageBtn, refreshBtn]);
  const header = createEl('div', { className: 'token-header' }, [headerRow1, headerRow2]);
  const dialog = createEl('div', { className: 'project-summary-dialog' }, [header, body]);
  modal.appendChild(dialog);
  document.body.appendChild(modal);
  tokenModal = modal;
  (modal as HTMLElement).tabIndex = -1;
  (modal as HTMLElement).focus();

  closeBtn.addEventListener('click', () => closeTokenModal());
  usageBtn.addEventListener('click', async () => {
    const result = await invoke('open_usage_stats');
    if (result && !result.ok) actions.showToast(t('toastError') + (result.error || ''));
  });
  modal.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeTokenModal();
  });

  // Track canvases for resize redraw
  let resizeRedrawFns: (() => void)[] = [];
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  const resizeObserver = new ResizeObserver(() => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => resizeRedrawFns.forEach(fn => fn()), 100);
  });
  resizeObserver.observe(body);
  // Disconnect on close via MutationObserver on modal removal
  const cleanupObserver = new MutationObserver(() => {
    if (!document.body.contains(modal)) {
      resizeObserver.disconnect();
      cleanupObserver.disconnect();
    }
  });
  cleanupObserver.observe(document.body, { childList: true });

  async function renderData() {
    resizeRedrawFns = [];
    body.replaceChildren(createEl('div', { textContent: t('loading') }));
    const data = await invoke('get_token_dashboard', { sinceDays: selectedRange }) as TokenDashboard | null;
    if (!data || !data.totals || data.totals.totalTokens === 0) {
      body.replaceChildren(createEl('div', { className: 'text-xs', textContent: t('tokenNoData') }));
      return;
    }
    body.replaceChildren();

    // [A] Hero stat cards with colored accent and animated counters
    const cardColors = [CHART_COLORS.output, CHART_COLORS.input, CHART_COLORS.output, CHART_COLORS.cacheRead, '#a78bfa'];
    const cardData: { label: string; value: number; fmt: (n: number) => string; color: string }[] = [
      { label: t('tokenTotal'), value: data.totals.totalTokens, fmt: formatNum, color: cardColors[0] },
      { label: t('tokenInput'), value: data.totals.inputTokens, fmt: formatNum, color: cardColors[1] },
      { label: t('tokenOutput'), value: data.totals.outputTokens, fmt: formatNum, color: cardColors[2] },
      { label: t('tokenCacheRead'), value: data.totals.cacheReadInputTokens, fmt: formatNum, color: cardColors[3] },
      { label: t('tokenEstimatedCost'), value: data.totals.estimatedCostUsd, fmt: formatUsd, color: cardColors[4] },
    ];
    const grid = createEl('div', { className: 'token-grid' });
    cardData.forEach(cd => {
      const card = createEl('div', { className: 'token-card' }) as HTMLElement;
      card.style.setProperty('--card-accent', cd.color);
      const valEl = createEl('div', { className: 'token-card-value', textContent: '0' });
      card.append(createEl('div', { className: 'token-card-label', textContent: cd.label }), valEl);
      grid.appendChild(card);
      animateCounter(valEl, cd.value, cd.fmt);
    });
    body.appendChild(grid);

    // [B] Stacked area chart with pill toggle
    body.appendChild(createEl('div', { className: 'token-section-title', textContent: t('tokenTrend') }));
    const pillGroup = createEl('div', { className: 'token-pill-group' });
    const periods: { key: TokenTrendPeriod; label: string }[] = [
      { key: 'hour', label: t('tokenPeriodHour') },
      { key: 'day', label: t('tokenPeriodDay') },
      { key: 'week', label: t('tokenPeriodWeek') },
      { key: 'month', label: t('tokenPeriodMonth') },
    ];
    let activePeriod: TokenTrendPeriod = 'day';
    const chartWrap = createEl('div', { className: 'token-chart-wrap' });
    const canvas = createEl('canvas', { className: 'token-chart' }) as HTMLCanvasElement;
    chartWrap.appendChild(canvas);

    // Legend row
    const legendColors = [CHART_COLORS.input, CHART_COLORS.output, CHART_COLORS.cacheRead, CHART_COLORS.cacheCreate];
    const legendLabels = ['Input', 'Output', 'Cache Read', 'Cache Create'];
    const legendRow = createEl('div', { className: 'token-chart-legend' });
    legendLabels.forEach((lbl, i) => {
      const dot = createEl('span', { className: 'token-legend-dot' }) as HTMLElement;
      dot.style.background = legendColors[i];
      legendRow.append(createEl('span', { className: 'token-legend-item' }, [dot, createEl('span', { textContent: lbl })]));
    });

    const renderTrend = () => drawStackedAreaChart(canvas, tokenTrendPoints(data, activePeriod));
    periods.forEach(p => {
      const btn = createEl('button', { className: 'token-pill-btn' + (p.key === activePeriod ? ' active' : ''), textContent: p.label });
      btn.addEventListener('click', () => {
        activePeriod = p.key;
        pillGroup.querySelectorAll('.token-pill-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        renderTrend();
      });
      pillGroup.appendChild(btn);
    });
    body.append(pillGroup, chartWrap, legendRow);
    renderTrend();
    resizeRedrawFns.push(renderTrend);

    // [C] Two-column layout: model donut + project bars | tool donut + word cloud
    const twoCol = createEl('div', { className: 'token-two-col' });

    // Left column
    const leftCol = createEl('div');

    // Model breakdown donut
    if (data.byModel && data.byModel.length > 0) {
      leftCol.appendChild(createEl('div', { className: 'token-section-title', textContent: t('tokenModelBreakdown') }));
      const modelChartWrap = createEl('div', { className: 'token-donut-section' });
      const modelCanvas = createEl('canvas') as HTMLCanvasElement;
      const modelSegs: DonutSegment[] = data.byModel.map(m => ({
        label: m.model.charAt(0).toUpperCase() + m.model.slice(1),
        value: m.estimatedCostUsd,
        color: CHART_COLORS.models[m.model] || '#6b7280',
      }));
      modelChartWrap.appendChild(modelCanvas);
      // Model legend
      const modelLegend = createEl('div', { className: 'token-donut-legend' });
      data.byModel.forEach(m => {
        const name = m.model.charAt(0).toUpperCase() + m.model.slice(1);
        const row = createEl('div', { className: 'token-legend-item' });
        const dot = createEl('span', { className: 'token-legend-dot' }) as HTMLElement;
        dot.style.background = CHART_COLORS.models[m.model] || '#6b7280';
        row.append(dot, createEl('span', { textContent: `${name}: ${formatUsd(m.estimatedCostUsd)} (${formatNum(m.messageCount)} msg)` }));
        modelLegend.appendChild(row);
      });
      modelChartWrap.appendChild(modelLegend);
      leftCol.appendChild(modelChartWrap);
      const drawModelDonut = () => drawDonutChart(modelCanvas, modelSegs, formatUsd(data.totals.estimatedCostUsd));
      requestAnimationFrame(drawModelDonut);
      resizeRedrawFns.push(drawModelDonut);
    }

    // Project comparison
    leftCol.appendChild(createEl('div', { className: 'token-section-title', textContent: t('tokenProjectCompare') }));
    const maxProjectTokens = Math.max(...data.byProject.slice(0, 12).map(p => p.totalTokens), 1);
    const barList = createEl('div', { className: 'token-bar-list' });
    data.byProject.slice(0, 12).forEach((p) => {
      const fill = createEl('div', { className: 'token-limit-bar-fill' }) as HTMLElement;
      fill.style.width = `${Math.max(2, Math.round((p.totalTokens / maxProjectTokens) * 100))}%`;
      barList.appendChild(createEl('div', { className: 'token-bar-row' }, [
        createEl('div', { className: 'truncate', textContent: projectDisplayName(p.project) }),
        createEl('div', { className: 'token-limit-bar' }, [fill]),
        createEl('div', { className: 'text-xs', textContent: formatNum(p.totalTokens) }),
      ]));
    });
    leftCol.appendChild(barList);

    // Right column
    const rightCol = createEl('div');

    // Tool usage donut
    if (data.toolUsage && data.toolUsage.length > 0) {
      rightCol.appendChild(createEl('div', { className: 'token-section-title', textContent: t('tokenToolUsage') }));
      const toolChartWrap = createEl('div', { className: 'token-donut-section' });
      const toolCanvas = createEl('canvas') as HTMLCanvasElement;
      const topTools = data.toolUsage.slice(0, 8);
      const toolSegs: DonutSegment[] = topTools.map(t => ({
        label: t.name,
        value: t.count,
        color: CHART_COLORS.tools[t.name] || CHART_COLORS.toolDefault,
      }));
      toolChartWrap.appendChild(toolCanvas);
      const toolLegend = createEl('div', { className: 'token-donut-legend' });
      topTools.forEach(tool => {
        const row = createEl('div', { className: 'token-legend-item' });
        const dot = createEl('span', { className: 'token-legend-dot' }) as HTMLElement;
        dot.style.background = CHART_COLORS.tools[tool.name] || CHART_COLORS.toolDefault;
        row.append(dot, createEl('span', { textContent: `${tool.name}: ${formatNum(tool.count)}` }));
        toolLegend.appendChild(row);
      });
      toolChartWrap.appendChild(toolLegend);
      rightCol.appendChild(toolChartWrap);
      const totalCalls = topTools.reduce((a, t) => a + t.count, 0);
      const drawToolDonut = () => drawDonutChart(toolCanvas, toolSegs, formatNum(totalCalls));
      requestAnimationFrame(drawToolDonut);
      resizeRedrawFns.push(drawToolDonut);
    }

    // Word cloud
    if (data.wordFreq && data.wordFreq.length > 0) {
      rightCol.appendChild(createEl('div', { className: 'token-section-title', textContent: t('tokenWordCloud') }));
      const wordCanvas = createEl('canvas') as HTMLCanvasElement;
      const wordWrap = createEl('div', { className: 'token-chart-wrap' });
      wordWrap.appendChild(wordCanvas);
      rightCol.appendChild(wordWrap);
      const drawWords = () => drawWordCloud(wordCanvas, data.wordFreq);
      requestAnimationFrame(drawWords);
      resizeRedrawFns.push(drawWords);
    }

    twoCol.append(leftCol, rightCol);
    body.appendChild(twoCol);

    // [D] Activity heatmap
    if (data.byDay && data.byDay.length > 0) {
      body.appendChild(createEl('div', { className: 'token-section-title', textContent: t('tokenHeatmap') }));
      const heatmapWrap = createEl('div', { className: 'token-chart-wrap', style: 'overflow-x:auto' });
      const heatmapCanvas = createEl('canvas') as HTMLCanvasElement;
      heatmapWrap.appendChild(heatmapCanvas);
      body.appendChild(heatmapWrap);
      const drawHeat = () => drawHeatmap(heatmapCanvas, data.byDay);
      requestAnimationFrame(drawHeat);
      resizeRedrawFns.push(drawHeat);
    }

    // [E] Usage limits
    const limitInput = parseTokenLimit(TOKEN_LIMIT_KEYS.input);
    const limitOutput = parseTokenLimit(TOKEN_LIMIT_KEYS.output);
    const limitTotal = parseTokenLimit(TOKEN_LIMIT_KEYS.total);
    body.appendChild(createEl('div', { className: 'token-section-title', textContent: t('tokenLimitUsage') }));
    const mkLimit = (label: string, used: number, limit: number, key: string) => {
      const pct = limit > 0 ? Math.round((used / limit) * 100) : 0;
      const over = limit > 0 && used > limit;
      const remain = limit > 0 ? Math.max(0, limit - used) : 0;
      const fill = createEl('div', { className: 'token-limit-bar-fill' }) as HTMLElement;
      fill.style.width = `${Math.min(100, pct)}%`;
      const inp = createEl('input', {
        className: 'token-limit-input',
        type: 'number',
        min: '0',
        placeholder: t('tokenLimitUnset'),
        value: limit > 0 ? String(limit) : '',
      }) as HTMLInputElement;
      const saveBtn = createEl('button', { className: 'mac-btn text-xs', textContent: t('tokenLimitSave') });
      saveBtn.addEventListener('click', () => {
        saveTokenLimit(key, inp.value);
        saveBtn.textContent = t('tokenLimitSaved');
        setTimeout(() => { saveBtn.textContent = t('tokenLimitSave'); }, 900);
        void renderData();
      });
      return createEl('div', { className: 'token-limit-card' + (over ? ' token-limit-over' : '') }, [
        createEl('div', { className: 'token-limit-label', textContent: label }),
        createEl('div', { className: 'token-limit-value', textContent: limit > 0 ? `${formatNum(used)} / ${formatNum(limit)} (${pct}%)` : `${formatNum(used)} / -` }),
        createEl('div', { className: 'token-limit-bar' }, [fill]),
        createEl('div', { className: 'text-[11px]', textContent: limit > 0 ? (over ? t('tokenLimitExceeded') : `${t('tokenRemaining')}: ${formatNum(remain)}`) : '' }),
        createEl('div', { className: 'token-limit-input-row' }, [inp, saveBtn]),
      ]);
    };
    body.appendChild(createEl('div', { className: 'token-limit-grid' }, [
      mkLimit(t('tokenLimitInput'), data.totals.inputTokens, limitInput, TOKEN_LIMIT_KEYS.input),
      mkLimit(t('tokenLimitOutput'), data.totals.outputTokens, limitOutput, TOKEN_LIMIT_KEYS.output),
      mkLimit(t('tokenLimitTotal'), data.totals.totalTokens, limitTotal, TOKEN_LIMIT_KEYS.total),
    ]));

    // [F] Collapsible detail tables
    const mkCollapsible = (title: string, content: HTMLElement): HTMLElement => {
      const header = createEl('div', { className: 'token-section-title token-collapsible' });
      const chevron = createEl('span', { className: 'token-chevron', textContent: '\u25B6' });
      const label = createEl('span', { textContent: ` ${title}` });
      header.append(chevron, label);
      content.style.display = 'none';
      header.addEventListener('click', () => {
        const open = content.style.display !== 'none';
        content.style.display = open ? 'none' : 'block';
        chevron.textContent = open ? '\u25B6' : '\u25BC';
      });
      return createEl('div', {}, [header, content]);
    };

    body.appendChild(createEl('div', { className: 'token-section-title', textContent: t('tokenDetailTables') }));

    body.appendChild(mkCollapsible(t('tokenByHour'), mkTokenTable(
      ['Hour', t('tokenInput'), t('tokenOutput'), t('tokenTotal')],
      data.byHour.slice(-24).map(h => [h.label, formatNum(h.inputTokens), formatNum(h.outputTokens), formatNum(h.totalTokens)])
    )));
    body.appendChild(mkCollapsible(t('tokenByDay'), mkTokenTable(
      ['Date', t('tokenInput'), t('tokenOutput'), t('tokenTotal')],
      data.byDay.slice(-14).map(d => [d.label, formatNum(d.inputTokens), formatNum(d.outputTokens), formatNum(d.totalTokens)])
    )));
    body.appendChild(mkCollapsible(t('tokenByWeek'), mkTokenTable(
      ['Week', t('tokenTotal'), t('tokenEstimatedCost')],
      data.byWeek.slice(-12).map(w => [w.label, formatNum(w.totalTokens), formatUsd(w.estimatedCostUsd)])
    )));
    body.appendChild(mkCollapsible(t('tokenByMonth'), mkTokenTable(
      ['Month', t('tokenTotal'), t('tokenEstimatedCost')],
      data.byMonth.slice(-12).map(m => [m.label, formatNum(m.totalTokens), formatUsd(m.estimatedCostUsd)])
    )));
    body.appendChild(mkCollapsible(t('tokenBySession'), mkTokenTable(
      ['Session', 'Project', t('tokenTotal'), t('tokenEstimatedCost')],
      data.bySession.slice(0, 25).map(s => [s.sessionId.slice(0, 8), projectDisplayName(s.project), formatNum(s.totalTokens), formatUsd(s.estimatedCostUsd)])
    )));
    body.appendChild(mkCollapsible(t('tokenByProject'), mkTokenTable(
      ['Project', 'Sessions', t('tokenTotal'), t('tokenEstimatedCost')],
      data.byProject.slice(0, 20).map(p => [projectDisplayName(p.project), String(p.sessionCount), formatNum(p.totalTokens), formatUsd(p.estimatedCostUsd)])
    )));
  }

  refreshBtn.addEventListener('click', () => { void renderData(); });
  void renderData();
}


function renderSessionItem(s: SessionSummary): HTMLElement {
  const cb = createEl('input', {
    type: 'checkbox',
    className: 'session-check mac-check mt-1 flex-shrink-0',
    'data-id': s.sessionId,
    onChange: (e: Event) => {
      const target = e.target as HTMLInputElement | null;
      if (target?.checked) selectedIds.add(s.sessionId);
      else selectedIds.delete(s.sessionId);
      const ab = byId('archiveSelectedBtn');
      ab.classList.toggle('invisible', selectedIds.size === 0);
      ab.classList.toggle('visible', selectedIds.size > 0);
    }
  });
  if (selectedIds.has(s.sessionId)) (cb as HTMLInputElement).checked = true;

  const firstMsg = createEl('p', { className: 'text-sm leading-snug truncate', textContent: s.firstDisplay });
  firstMsg.style.color = 'var(--text)';
  const lastMsg = (s.lastDisplay && s.lastDisplay !== s.firstDisplay)
    ? createEl('p', { className: 'text-xs leading-snug truncate mt-0.5', textContent: s.lastDisplay })
    : null;
  if (lastMsg) lastMsg.style.color = 'var(--text-muted)';

  const dot = () => { const sp = createEl('span', { className: 'text-[10px] flex-shrink-0', textContent: '·' }); sp.style.color = 'var(--text-dot)'; return sp; };
  const meta = (txt: string) => { const sp = createEl('span', { className: 'text-[10px] flex-shrink-0', textContent: txt }); sp.style.color = 'var(--text-faint)'; return sp; };
  const metaParts = [meta(timeAgo(s.lastTimestamp, lang, t)), dot(), meta(s.messageCount + t('msg'))];
  if (s.archived) { const sp = createEl('span', { className: 'text-[10px] flex-shrink-0', textContent: t('archived') }); sp.style.color = 'var(--text-faint)'; metaParts.push(sp); }

  const updated = isUpdatedSession(s);

  const metaDiv = createEl('div', { className: 'mt-1 overflow-hidden' }, metaParts);
  metaDiv.style.cssText = 'display:grid;grid-auto-flow:column;grid-auto-columns:max-content;align-items:center;gap:8px;';
  const textDiv = createEl('div', { className: 'min-w-0 overflow-hidden' }, [firstMsg, lastMsg, metaDiv].filter(Boolean));

  const rowChildren = [cb];
  if (updated) {
    const updDot = createEl('span', { className: 'flex-shrink-0 mt-1.5' });
    updDot.style.cssText = 'width:7px;height:7px;border-radius:50%;background:var(--updated-dot);';
    rowChildren.push(updDot);
  }
  rowChildren.push(textDiv);
  const row = createEl('div', { className: 'overflow-hidden' }, rowChildren);
  row.style.cssText = 'display:grid;grid-template-columns:' + (updated ? 'auto auto 1fr' : 'auto 1fr') + ';align-items:start;gap:8px;';

  const isActive = selectedSession === s.sessionId;
  const defaultBg = updated ? 'var(--updated-bg)' : 'transparent';
  const item = createEl('div', {
    className: 'session-item p-3 rounded cursor-default transition border overflow-hidden',
    'data-id': s.sessionId,
    onClick: (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (target?.tagName === 'INPUT') return;
      hidePreview();
      // Deselect previous
      const prev = document.querySelector('.session-item-active');
      if (prev) {
        prev.classList.remove('session-item-active');
        (prev as HTMLElement).style.borderColor = 'transparent';
        (prev as HTMLElement).style.background = '';
      }
      selectedSession = s.sessionId;
      knownTimestamps[s.sessionId] = s.lastTimestamp;
      // Select current
      item.classList.add('session-item-active');
      item.style.borderColor = 'var(--item-active-border)';
      item.style.background = 'var(--item-active)';
      showDetail(s.sessionId);
    }
  }, [row]);
  if (isActive) item.classList.add('session-item-active');
  item.style.borderColor = isActive ? 'var(--item-active-border)' : 'transparent';
  item.style.background = isActive ? 'var(--item-active)' : defaultBg;
  if (s.archived) item.style.opacity = '0.4';
  // Tooltip with date
  const dateStr = s.lastTimestamp ? new Date(s.lastTimestamp).toLocaleString(lang === 'ja' ? 'ja-JP' : 'en-US') : '';
  item.title = dateStr;

  item.addEventListener('mouseenter', () => {
    if (!isActive) item.style.background = 'var(--item-hover)';
    if (!isActive && (isDetailPaneVisible() || isPreviewHotkeyPressed)) {
      schedulePreviewShow(s.sessionId, item.getBoundingClientRect());
    }
  });
  item.addEventListener('mouseleave', () => {
    if (!isActive) item.style.background = defaultBg;
    schedulePreviewHide();
  });
  return item;
}

function renderSessions() {
  const search = byId('search').value.toLowerCase();
  let filtered: SessionSummary[] = sessions;
  if (selectedProject) filtered = filtered.filter(s => s.project === selectedProject);
  if (search) filtered = filtered.filter(s =>
    (s.firstDisplay || '').toLowerCase().includes(search) ||
    (s.lastDisplay || '').toLowerCase().includes(search) ||
    s.project.toLowerCase().includes(search) ||
    (projectNameMap[s.project] || '').toLowerCase().includes(search)
  );

  byId('sessionListTitle').textContent =
    filtered.length + ' ' + t('sessions') + (selectedProject ? ' — ' + projectDisplayName(selectedProject) : '');

  const archBtn = byId('archiveSelectedBtn');
  archBtn.classList.toggle('invisible', selectedIds.size === 0);
  archBtn.classList.toggle('visible', selectedIds.size > 0);

  const el = byId('sessionList');
  el.replaceChildren();

  // When a specific project is selected, render flat list
  if (selectedProject) {
    filtered.forEach(s => el.appendChild(renderSessionItem(s)));
    return;
  }

  // Group by project
  const groups: ProjectGroup[] = [];
  const groupMap: Record<string, ProjectGroup> = {};
  filtered.forEach(s => {
    if (!groupMap[s.project]) {
      groupMap[s.project] = { path: s.project, sessions: [] };
      groups.push(groupMap[s.project]);
    }
    groupMap[s.project].sessions.push(s);
  });

  groups.forEach(g => {
    const open = isProjectOpen(g);
    const group = createEl('div', { className: 'project-group' });

    // Group header
    const chevron = createEl('span', { className: 'project-group-chevron' + (open ? ' open' : ''), textContent: '\u25B6' });
    const name = createEl('span', { className: 'text-xs font-medium flex-1 truncate', textContent: projectDisplayName(g.path) });
    name.style.color = 'var(--text-secondary)';
    const count = createEl('span', { className: 'text-[10px] flex-shrink-0', textContent: g.sessions.length + '' });
    count.style.cssText = 'color:var(--text-muted);min-width:24px;text-align:right;';
    const startBtn = createEl('button', {
      className: 'project-start-btn',
      textContent: '+',
      title: t('startProjectSession'),
      onClick: async (e: Event) => {
        e.stopPropagation();
        const result = await invoke('start_new_session_in_project', { project: g.path });
        if (!result?.ok) actions.showToast(t('toastError') + (result?.error || ''));
      }
    });
    const icon = createEl('span', { className: 'project-group-icon' });
    icon.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4.5A1.5 1.5 0 013.5 3H6l1.5 2h5A1.5 1.5 0 0114 6.5v5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5z"/></svg>';
    const header = createEl('div', { className: 'project-group-header' }, [chevron, icon, name, startBtn, count]);
    if (projectNameMap[g.path]) header.title = shortPath(g.path);

    // Split sessions into recent (7 days) and older
    const now = Date.now();
    const recentSessions = g.sessions.filter(s => (now - s.lastTimestamp) < SEVEN_DAYS);
    const olderSessions = g.sessions.filter(s => (now - s.lastTimestamp) >= SEVEN_DAYS);

    const sessionsDiv = createEl('div', { className: 'project-group-sessions' + (open ? ' open' : '') });

    recentSessions.forEach(s => sessionsDiv.appendChild(renderSessionItem(s)));

    if (olderSessions.length > 0) {
      if (showAllSessions.has(g.path)) {
        olderSessions.forEach(s => sessionsDiv.appendChild(renderSessionItem(s)));
      } else {
        const showOlderBtn = createEl('button', {
          className: 'show-older-pill',
          textContent: (lang === 'ja' ? '古いセッションを表示' : 'Show older') + ' (' + olderSessions.length + ')',
          onClick: (e: Event) => {
            e.stopPropagation();
            showAllSessions.add(g.path);
            renderSessions();
          }
        });
        sessionsDiv.appendChild(showOlderBtn);
      }
    }

    if (recentSessions.length === 0 && !showAllSessions.has(g.path)) {
      const hint = createEl('p', { className: 'text-[11px] px-3 py-1.5', textContent: lang === 'ja' ? '最近のセッションなし' : 'No recent sessions' });
      hint.style.color = 'var(--text-faint)';
      sessionsDiv.insertBefore(hint, sessionsDiv.firstChild);
    }

    header.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey) {
        const allChevrons = document.querySelectorAll('.project-group-chevron');
        const allSessions = document.querySelectorAll('.project-group-sessions');
        const shouldOpen = !chevron.classList.contains('open');
        allChevrons.forEach(c => c.classList.toggle('open', shouldOpen));
        allSessions.forEach(s => s.classList.toggle('open', shouldOpen));
        toggledProjects.clear();
        if (!shouldOpen) {
          groups.forEach(gg => { if (isRecentProject(gg)) toggledProjects.add(gg.path); });
        } else {
          groups.forEach(gg => { if (!isRecentProject(gg)) toggledProjects.add(gg.path); });
        }
        saveToggled();
        return;
      }
      if (toggledProjects.has(g.path)) toggledProjects.delete(g.path);
      else toggledProjects.add(g.path);
      saveToggled();
      chevron.classList.toggle('open');
      sessionsDiv.classList.toggle('open');
    });

    group.appendChild(header);
    group.appendChild(sessionsDiv);
    el.appendChild(group);
  });
}

async function showDetail(sessionId: string) {
  const pane = byId('detailPane');
  const headerEl = byId('detailHeader');
  const messagesEl = byId('detailMessages');

  // Switch to 3-column layout & enforce wider min width
  document.body.style.gridTemplateColumns = '280px 1px 1fr';
  if (isTauri) {
    tauriWindow.window.getCurrentWindow().setMinSize(new tauriWindow.window.LogicalSize(700, 500));
  }
  byId('resizeHandle').style.display = '';
  pane.style.display = 'grid';

  // Abort any in-progress chunk rendering from previous session
  if (renderAbort) renderAbort.aborted = true;

  // Switch from grid centering (empty state) to block for scrollable content
  messagesEl.style.display = 'block';
  messagesEl.replaceChildren();
  messagesEl.scrollTop = 0;
  chatSearch.reset();
  hidePreview();

  const cached = getPreviewDetailCached(sessionId);
  const detail = cached || await fetchDetail(sessionId);
  if (!detail) {
    actions.showToast(t('toastError'));
    return;
  }
  setPreviewDetailCached(sessionId, detail);

  const sessionSummary = sessions.find(s => s.sessionId === sessionId);
  const projectName = projectDisplayName(detail.project);
  const sessionTitle = sessionSummary ? sessionSummary.firstDisplay : '';

  const pathLine = createEl('span', { className: 'text-xs' });
  pathLine.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;';
  const projSpan = createEl('span', { className: 'font-medium', textContent: projectName });
  projSpan.style.color = 'var(--text-secondary)';
  pathLine.appendChild(projSpan);
  if (sessionTitle) {
    const sep = createEl('span', { textContent: ' — ' });
    sep.style.color = 'var(--text-faint)';
    pathLine.appendChild(sep);
    const titleSpan = createEl('span', { textContent: sessionTitle });
    titleSpan.style.color = 'var(--text-muted)';
    pathLine.appendChild(titleSpan);
  }
  pathLine.title = shortPath(detail.project) + ' · ' + sessionId;


  const mkBtn = (text: string, isPrimary: boolean, onClick: () => void | Promise<void>): HTMLElement => {
    const btn = createEl('button', {
      className: 'mac-btn flex-shrink-0' + (isPrimary ? ' mac-btn-primary' : ''),
      textContent: text, onClick
    });
    return btn;
  };

  // Chat search — macOS-style with count and nav inside the field
  const chatSearchInput = createEl('input', {
    type: 'text', id: 'chatSearch',
    className: 'mac-input',
  }) as HTMLInputElement;
  chatSearchInput.style.cssText = 'width:100%;height:28px;padding:4px 60px 4px 8px;box-sizing:border-box;';
  chatSearchInput.placeholder = t('chatSearchPlaceholder');
  const chatCount = createEl('span', { id: 'chatSearchCount', className: 'text-[10px]' });
  chatCount.style.cssText = 'color:var(--text-faint);white-space:nowrap;';
  const prevBtn = createEl('button', { id: 'chatSearchPrev', className: 'hidden', textContent: '\u25B2' });
  prevBtn.style.cssText = 'font-size:9px;color:var(--text-muted);padding:0 2px;line-height:1;cursor:default;background:none;border:none;pointer-events:auto;';
  const nextBtn = createEl('button', { id: 'chatSearchNext', className: 'hidden', textContent: '\u25BC' });
  nextBtn.style.cssText = 'font-size:9px;color:var(--text-muted);padding:0 2px;line-height:1;cursor:default;background:none;border:none;pointer-events:auto;';

  const searchOverlay = createEl('div', {}, [chatCount, prevBtn, nextBtn]);
  searchOverlay.style.cssText = 'display:grid;grid-auto-flow:column;grid-auto-columns:max-content;align-items:center;gap:2px;position:absolute;right:6px;top:50%;transform:translateY(-50%);pointer-events:auto;';

  const searchGroup = createEl('div', {}, [chatSearchInput, searchOverlay]);
  searchGroup.style.cssText = 'display:grid;position:relative;width:200px;justify-self:end;';
  const headerRow = createEl('div', { className: 'min-w-0' }, [
    pathLine, searchGroup,
  ]);
  headerRow.style.cssText = 'display:grid;grid-template-columns:minmax(0,1fr) 200px;align-items:center;gap:12px;';

  const headerRow2 = createEl('div', {});
  headerRow2.style.height = '22px';
  headerEl.replaceChildren(headerRow, headerRow2);

  // Re-bind chat search events
  let chatSearchTimer: ReturnType<typeof setTimeout> | undefined;
  chatSearchInput.addEventListener('input', () => { clearTimeout(chatSearchTimer); chatSearchTimer = setTimeout(() => chatSearch.doSearch(), 200); });
  nextBtn.addEventListener('click', () => chatSearch.next());
  prevBtn.addEventListener('click', () => chatSearch.prev());
  chatSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.shiftKey ? chatSearch.prev() : chatSearch.next(); e.preventDefault(); }
    if (e.key === 'Escape') {
      const target = e.target as HTMLInputElement | null;
      if (target) {
        target.value = '';
        chatSearch.doSearch();
        target.blur();
      }
    }
  });

  // Footer buttons
  const footerEl = byId('detailFooter');
  const updatedSessionSummary = sessions.find(s => s.sessionId === sessionId);
  const sessionUpdated = updatedSessionSummary ? isUpdatedSession(updatedSessionSummary) : false;
  const resumeOpenBtn = mkBtn(
    isRemote() ? t('resumeCopy') : 'Resume (' + (serverSettings.terminalApp || 'Terminal') + ')',
    sessionUpdated,
    () => isRemote() ? actions.copyResume(sessionId) : actions.resumeInTerminal(sessionId),
  );
  const resumeCopyBtn = mkBtn(t('copyCmd'), false, () => actions.copyResume(sessionId));
  const archiveBtn = mkBtn(t('archive'), false, () => actions.archiveSingle(sessionId));
  const summarizeBtn = mkBtn(t('summarize'), false, async () => {
    const res = await invoke('resume_with_prompt', {
      sessionId,
      prompt: 'このセッションの内容を要約して',
    }) as any;
    if (res?.ok) actions.showToast(t('toastSummarizing'));
    else actions.showToast(t('toastError') + (res?.error || ''));
  });
  footerEl.replaceChildren(resumeOpenBtn, resumeCopyBtn, summarizeBtn, archiveBtn);

  // Chat messages are rendered in two phases:
  // 1) latest chunk immediately for responsiveness
  // 2) older chunk in idle time, inserted once to avoid layout thrash
  messagesEl.replaceChildren();
  const chatContainer = createEl('div', {});
  chatContainer.style.cssText = 'display:grid;gap:12px;';

  // Build a global result map across all messages
  const globalResultMap: Record<string, any> = {};
  detail.messages.forEach((m: DetailMessage) => {
    if (m.tools) {
      m.tools.filter((tool: any) => tool.name === '_result').forEach((tool: any) => { globalResultMap[tool.id] = tool; });
    }
  });

  // Prepare message descriptors (lightweight) without rendering.
  // Keep all original indices so Tantivy's message_index always maps correctly.
  const msgDescs: MsgDesc[] = [];
  detail.messages.forEach((m: DetailMessage, origIdx: number) => {
    const hasText = Boolean(
      m.content &&
      m.content !== '[Tool Result]' &&
      !m.content.startsWith('[Tool:')
    );
    const hasTools = Boolean(m.tools && m.tools.length > 0);
    msgDescs.push({ msg: m, hasText, hasTools, origIdx });
  });

  // Render a single message descriptor into DOM elements
  function renderMsgDesc(desc: MsgDesc): HTMLElement[] {
    const { msg: m, hasText, hasTools } = desc;
    const isUser = m.type === 'user';
    const els: HTMLElement[] = [];

    if (hasTools) {
      const toolEls = renderToolBlocks(m.tools || [], globalResultMap, createEl);
      if (toolEls.length > 0) {
        if (hasText) {
          const bubbleInner = createEl('div', { className: 'md-content text-sm leading-relaxed break-words' });
          bubbleInner.innerHTML = renderMarkdown(m.content || '');
          const bubble = createEl('div', { className: (isUser ? 'bubble-user' : 'bubble-assistant') + ' px-4 py-2.5' }, [bubbleInner]);
          bubble.style.justifySelf = isUser ? 'end' : 'start';
          els.push(bubble);
        }
        toolEls.forEach(te => els.push(te));
        return els;
      }
    }

    const hasImages = Boolean((m as any).images && (m as any).images.length > 0);

    if (!hasText && !hasImages) return els;

    const bubbleInner = createEl('div', { className: 'md-content text-sm leading-relaxed break-words' });
    if (hasText) bubbleInner.innerHTML = renderMarkdown(m.content || '');

    // Render inline images
    if (hasImages) {
      for (const img of (m as any).images) {
        const imgEl = document.createElement('img');
        imgEl.className = 'chat-inline-img';
        if (img.sourceType === 'base64') {
          imgEl.src = `data:${img.mediaType};base64,${img.data}`;
        } else {
          imgEl.src = `asset://localhost/${encodeURIComponent(img.data)}`;
        }
        imgEl.alt = 'image';
        bubbleInner.appendChild(imgEl);
      }
    }

    const bubble = createEl('div', { className: (isUser ? 'bubble-user' : 'bubble-assistant') + ' px-4 py-2.5' }, [bubbleInner]);
    bubble.style.justifySelf = isUser ? 'end' : 'start';
    els.push(bubble);
    return els;
  }

  function appendRenderedMsgDesc(desc: MsgDesc, parentEl: ParentNode) {
    const els = renderMsgDesc(desc);
    if (els.length === 0) {
      // Keep a stable anchor even for visually empty messages so message_index lookup stays stable.
      const anchor = createEl('div', {});
      anchor.style.cssText = 'height:0;overflow:hidden;';
      anchor.setAttribute('data-msg-idx', String(desc.origIdx));
      parentEl.appendChild(anchor);
      return;
    }
    els.forEach(el => {
      el.setAttribute('data-msg-idx', String(desc.origIdx));
      parentEl.appendChild(el);
    });
  }

  // Render last 100 immediately, rest in background then insert in one batch
  const immediateCount = Math.min(100, msgDescs.length);
  const deferredCount = msgDescs.length - immediateCount;

  // Placeholder for deferred block (single element to replace later)
  const deferredPlaceholder: HTMLElement | null = deferredCount > 0 ? createEl('div') : null;
  if (deferredPlaceholder) chatContainer.appendChild(deferredPlaceholder);

  // Immediate messages (bottom N)
  for (let i = deferredCount; i < msgDescs.length; i++) {
    appendRenderedMsgDesc(msgDescs[i], chatContainer);
  }

  messagesEl.appendChild(chatContainer);
  const spacer = createEl('div', {});
  spacer.style.height = '24px';
  messagesEl.appendChild(spacer);
  requestAnimationFrame(() => { messagesEl.scrollTop = messagesEl.scrollHeight; });

  // Background rendering into DocumentFragment, then one-shot insert
  const ctrl = { aborted: false };
  renderAbort = ctrl;
  allMessagesRendered = (deferredCount === 0);

  function flushDeferred() {
    if (allMessagesRendered) return;
    if (!deferredPlaceholder) return;
    const frag = document.createDocumentFragment();
    for (let i = 0; i < deferredCount; i++) {
      appendRenderedMsgDesc(msgDescs[i], frag);
    }
    const prevScrollTop = messagesEl.scrollTop;
    const prevScrollHeight = messagesEl.scrollHeight;
    deferredPlaceholder.replaceWith(frag);
    messagesEl.scrollTop = prevScrollTop + (messagesEl.scrollHeight - prevScrollHeight);
    allMessagesRendered = true;
  }

  // Expose flush for search/scroll
  window._flushRender = flushDeferred;

  if (deferredCount > 0) {
    // Render offscreen in idle chunks, then batch-insert
    let chunkIdx = 0;
    const deferredFrag = document.createDocumentFragment();

    function buildChunk(deadline: IdleDeadline | null) {
      if (ctrl.aborted) return;
      const end = Math.min(chunkIdx + 10, deferredCount);
      while (chunkIdx < end) {
        appendRenderedMsgDesc(msgDescs[chunkIdx], deferredFrag);
        chunkIdx++;
        if (deadline && deadline.timeRemaining && deadline.timeRemaining() < 2) break;
      }
      if (chunkIdx < deferredCount) {
        if (typeof requestIdleCallback === 'function') requestIdleCallback(buildChunk, { timeout: 100 });
        else setTimeout(() => buildChunk(null), 16);
      } else {
        // All built — single DOM insert
        if (!ctrl.aborted && deferredPlaceholder && deferredPlaceholder.parentNode) {
          const prevScrollTop = messagesEl.scrollTop;
          const prevScrollHeight = messagesEl.scrollHeight;
          deferredPlaceholder.replaceWith(deferredFrag);
          messagesEl.scrollTop = prevScrollTop + (messagesEl.scrollHeight - prevScrollHeight);
          allMessagesRendered = true;
        }
      }
    }

    if (typeof requestIdleCallback === 'function') requestIdleCallback(buildChunk, { timeout: 100 });
    else setTimeout(() => buildChunk(null), 16);
  }
}

initResizeHandle(byId);

// --- Init ---

byId('search').addEventListener('input', () => {
  fullTextSearch.onSearchInput();
});
byId('homeBtn').addEventListener('click', () => {
  showStartupView();
});
byId('tokenDashboardBtn').addEventListener('click', () => {
  void openTokenModal();
});
byId('archiveSelectedBtn').addEventListener('click', () => actions.archiveSelected());
byId('newSessionBtn').addEventListener('click', async () => {
  const result = await invoke('start_new_session');
  if (result && !result.ok) actions.showToast(t('toastError') + (result.error || ''));
});

// Native menu events are emitted by Tauri and reflected into in-app state.
if (isTauri && tauriWindow.event) {
  const { listen } = tauriWindow.event;
  listen('menu-theme', (e: any) => {
    themePref = e.payload; localStorage.setItem('csm-theme', themePref); applyTheme(themePref);
  });
  listen('menu-terminal', (e: any) => {
    serverSettings.terminalApp = e.payload;
    invoke('update_settings', { terminalApp: e.payload });
  });
  listen('menu-lang', (e: any) => {
    lang = e.payload; localStorage.setItem('csm-lang', lang); applyI18n(); renderSessions();
  });
  listen('search-index-ready', () => {
    fullTextSearch.setIndexReady(true);
    const indicator = byId('searchIndexIndicator');
    if (indicator) indicator.remove();
  });
  listen('menu-show-archived', (e: any) => {
    byId('showArchived').checked = e.payload;
    fetchSessions(e.payload);
  });
  listen('menu-zoom', (e: any) => {
    if (e.payload === 'in') { zoomLevel = Math.min(200, zoomLevel + 10); }
    else if (e.payload === 'out') { zoomLevel = Math.max(60, zoomLevel - 10); }
    else { zoomLevel = 100; }
    localStorage.setItem('csm-zoom', String(zoomLevel)); applyZoom();
  });
}

// --- Zoom ---
let zoomLevel = parseFloat(localStorage.getItem('csm-zoom') || '100');
function applyZoom() {
  byId('detailPane').style.zoom = (zoomLevel / 100);
}

initKeyboardNavigation({
  byId,
  getSelectedSession: () => selectedSession,
});

applyTheme(themePref);
applyI18n();
initPreview();
applyZoom();

document.addEventListener('keydown', (e: KeyboardEvent) => {
  isPreviewHotkeyPressed = e.altKey && e.shiftKey;
});
document.addEventListener('keyup', (e: KeyboardEvent) => {
  if (e.key === 'Alt' || e.key === 'Shift') {
    isPreviewHotkeyPressed = e.altKey && e.shiftKey;
    if (!isPreviewHotkeyPressed && !isDetailPaneVisible()) hidePreview();
  } else if (!e.altKey || !e.shiftKey) {
    isPreviewHotkeyPressed = false;
    if (!isDetailPaneVisible()) hidePreview();
  }
});

Promise.all([fetchSessions(), fetchProjects(), fetchSettings()]).then(() => {
  // Sync menu state with saved preferences
  invoke('sync_menu_state', {
    theme: themePref,
    terminal: serverSettings.terminalApp || 'Terminal',
    lang: lang,
    showArchived: false,
  });
  // Show startup project cards when no session is selected
  showStartupView();
});

// Auto-refresh every 30s to detect updated sessions
setInterval(async () => {
  const oldSessions = sessions.slice();
  // Fetch new data but don't re-render if in fulltext search mode
  sessions = await invoke('list_sessions', { includeArchived: byId('showArchived').checked }) || [];
  if (isFirstLoad) {
    sessions.forEach(s => { knownTimestamps[s.sessionId] = s.lastTimestamp; });
    isFirstLoad = false;
  }
  if (fullTextSearch.getMode() !== 'fulltext') renderSessions();
  // Incremental search index update for changed sessions
  const updatedIds = sessions
    .filter(s => {
      const old = oldSessions.find(o => o.sessionId === s.sessionId);
      return !old || old.lastTimestamp !== s.lastTimestamp;
    })
    .map(s => s.sessionId);
  if (updatedIds.length > 0) {
    invoke('update_search_index', { sessionIds: updatedIds });
  }
}, 30000);
