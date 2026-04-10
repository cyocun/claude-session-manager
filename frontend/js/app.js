import { detectLang, translate } from './i18n.js';
import { createEl, getById } from './dom.js';
import { getThemePref, applyTheme, watchSystemTheme } from './theme.js';
import { invoke, invokeStrict, isTauri } from './tauri.js';
import { isRemoteHost, shortPath, timeAgo } from './utils.js';
import { getPreviewDetailCached, hidePreview, initPreview, invalidatePreviewCache, schedulePreviewHide, schedulePreviewShow, setPreviewDetailCached, } from './preview.js';
import { createChatSearchController } from './chatSearch.js';
import { createFullTextSearchController } from './fullTextSearch.js';
import { renderToolBlocks } from './toolRenderer.js';
import { createSessionActions } from './sessionActions.js';
import { initKeyboardNavigation, initResizeHandle } from './layoutControls.js';
import { hasSessionIdentityOrderChanged, patchSessionListItems } from './sessionListView.js';
import { ICONS } from './icons.js';
const tauriWindow = window.__TAURI__;
const byId = (id) => getById(id);
const byIdOptional = (id) => document.getElementById(id);
let lang = detectLang();
function t(key) { return translate(lang, key); }
function applyI18n() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const node = el;
        el.textContent = t(node.dataset.i18n || '');
    });
    document.querySelectorAll('[data-i18n-option]').forEach(el => {
        const node = el;
        el.textContent = t(node.dataset.i18nOption || '');
    });
    byId('search').placeholder = t('searchContent');
    const cs = byIdOptional('chatSearch');
    if (cs)
        cs.placeholder = t('chatSearchPlaceholder');
    byId('homeBtn').title = t('home');
    byId('newSessionBtn').title = t('newSession');
    const tokenBtn = byId('tokenDashboardBtn');
    if (tokenBtn)
        tokenBtn.title = t('tokenDashboard');
}
// --- Theme ---
let themePref = getThemePref();
watchSystemTheme(() => {
    if (themePref === 'system')
        applyTheme(themePref);
});
// --- Markdown ---
const md = window.markdownit({
    html: false, breaks: true, linkify: true,
    highlight: function (str, codeLang) {
        if (codeLang && hljs.getLanguage(codeLang)) {
            try {
                return hljs.highlight(str, { language: codeLang }).value;
            }
            catch { }
        }
        try {
            return hljs.highlightAuto(str).value;
        }
        catch { }
        return '';
    }
});
function renderMarkdown(text) { return DOMPurify.sanitize(md.render(text)); }
// --- State ---
let sessions = [];
let projects = [];
let selectedProject = null;
let selectedSession = null;
let selectedIds = new Set();
let serverSettings = {};
let projectNameMap = {}; // path -> display name
// Stores projects the user has explicitly toggled open/closed
let toggledProjects = new Set(JSON.parse(localStorage.getItem('csm-toggled') || '[]'));
// Stores projects where "show older" has been clicked
let showAllSessions = new Set();
let openedAt = Date.now();
let knownTimestamps = {}; // sessionId -> lastTimestamp at first load
let isFirstLoad = true;
let allMessagesRendered = true;
let renderAbort = null;
let tokenModal = null;
let isPreviewHotkeyPressed = false;
let activeSessionItemEl = null;
let renderSessionsQueued = false;
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
    setSelectedSession: (sessionId) => { selectedSession = sessionId; },
    chatSearch,
});
const actions = createSessionActions({
    byId,
    t,
    getLang: () => lang,
    invoke,
    fetchSessions,
    getShowArchived: () => byId('showArchived').checked,
    getSelectedIds: () => selectedIds,
    clearSelectedIds: () => { selectedIds.clear(); },
    getSessions: () => sessions,
});
async function fetchSessions(includeArchived = false) {
    try {
        sessions = await invokeStrict('list_sessions', { includeArchived });
    }
    catch (error) {
        console.warn('[sessions] fetch failed', error);
        sessions = [];
    }
    if (isFirstLoad) {
        sessions.forEach(s => { knownTimestamps[s.sessionId] = s.lastTimestamp; });
        isFirstLoad = false;
    }
    requestRenderSessions();
    updateLastUpdateBar();
}
function requestRenderSessions() {
    if (renderSessionsQueued)
        return;
    renderSessionsQueued = true;
    requestAnimationFrame(() => {
        renderSessionsQueued = false;
        renderSessions();
    });
}
function isUpdatedSession(s) {
    if (!(s.sessionId in knownTimestamps))
        return true; // new session
    return s.lastTimestamp > knownTimestamps[s.sessionId]; // timestamp changed
}
async function fetchProjects() {
    try {
        projects = await invokeStrict('list_projects');
    }
    catch (error) {
        console.warn('[projects] fetch failed', error);
        projects = [];
    }
    projectNameMap = {};
    projects.forEach(p => { if (p.name)
        projectNameMap[p.path] = p.name; });
    renderProjects();
}
async function fetchDetail(sessionId) {
    try {
        return await invokeStrict('get_session_detail', { sessionId });
    }
    catch (error) {
        console.warn('[detail] fetch failed', error);
        return null;
    }
}
async function fetchSettings() {
    try {
        serverSettings = await invokeStrict('get_settings');
    }
    catch (error) {
        console.warn('[settings] fetch failed', error);
        serverSettings = {};
    }
}
function projectDisplayName(path) {
    return projectNameMap[path] || shortPath(path).split('/').pop() || shortPath(path);
}
function isRemote() {
    return isRemoteHost(location.hostname);
}
function isDetailPaneVisible() {
    const pane = byId('detailPane');
    return !!pane && pane.style.display !== 'none';
}
// --- Rendering ---
function renderProjects() {
    // Projects are now only used for display name mapping, no sidebar rendering
    projectNameMap = {};
    projects.forEach(p => { if (p.name)
        projectNameMap[p.path] = p.name; });
}
// --- Startup project cards ---
const iconCache = new Map();
function hashColor(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++)
        h = ((h << 5) - h + name.charCodeAt(i)) | 0;
    const hue = Math.abs(h) % 360;
    return `hsl(${hue}, 55%, 50%)`;
}
function renderInitialAvatar(name) {
    const initial = (name || '?').charAt(0).toUpperCase();
    const el = createEl('div', { className: 'startup-card-initial', textContent: initial });
    el.style.background = hashColor(name);
    return el;
}
async function openReadmeWindow(projectPath, projectName) {
    const result = await invoke('open_readme_window', { project: projectPath, name: projectName });
    if (result === null) {
        actions.showToast(t('readmeNotFound'));
    }
}
function renderProjectCard(p, iconUri) {
    const card = createEl('div', { className: 'startup-card', onClick: () => focusProjectInSidebar(p.path) });
    card.style.cursor = 'pointer';
    const name = projectDisplayName(p.path);
    let iconEl;
    if (iconUri) {
        iconEl = createEl('img', { className: 'startup-card-icon' });
        iconEl.src = iconUri;
        iconEl.alt = name;
    }
    else {
        iconEl = renderInitialAvatar(name);
    }
    const info = createEl('div', {});
    const nameEl = createEl('div', { className: 'startup-card-name', textContent: name });
    nameEl.title = name;
    const pathEl = createEl('div', { className: 'startup-card-path', textContent: shortPath(p.path) });
    pathEl.title = p.path;
    const actionsRow = createEl('div', { className: 'startup-card-actions' });
    const makeIconBtn = (title, iconSvg, onClick, primary = false) => {
        const btn = createEl('button', {
            className: `mac-btn${primary ? ' mac-btn-primary' : ''}`,
            title,
            'aria-label': title,
            onClick: (e) => {
                e.stopPropagation();
                onClick();
            },
        });
        btn.style.cssText = 'width:28px;height:28px;padding:0;display:inline-flex;align-items:center;justify-content:center;';
        btn.innerHTML = iconSvg;
        return btn;
    };
    const newIcon = ICONS.plus;
    const resumeIcon = ICONS.refresh;
    const terminalIcon = ICONS.terminal;
    const finderIcon = ICONS.folderOpen;
    const readmeIcon = ICONS.fileText;
    actionsRow.appendChild(makeIconBtn(t('newSession'), newIcon, async () => {
        await invoke('start_new_session_in_project', { project: p.path });
        setTimeout(() => fetchSessions(byId('showArchived').checked), 2000);
    }));
    if (p.lastSessionId) {
        actionsRow.appendChild(makeIconBtn(t('resumeLast'), resumeIcon, () => {
            void actions.resumeInTerminal(p.lastSessionId);
        }, true));
    }
    actionsRow.appendChild(makeIconBtn(t('openProjectTerminal'), terminalIcon, async () => {
        const result = await invoke('open_project_in_terminal', { project: p.path });
        if (!result?.ok)
            actions.showToast(t('toastError') + (result?.error || ''));
    }));
    actionsRow.appendChild(makeIconBtn(t('openProjectFinder'), finderIcon, async () => {
        const result = await invoke('open_path', { path: p.path });
        if (result === null)
            actions.showToast(t('toastError'));
    }));
    actionsRow.appendChild(makeIconBtn(t('readme'), readmeIcon, () => {
        void openReadmeWindow(p.path, name);
    }));
    info.appendChild(nameEl);
    info.appendChild(pathEl);
    info.appendChild(actionsRow);
    card.appendChild(iconEl);
    card.appendChild(info);
    return card;
}
async function fetchIcons(list) {
    return Promise.all(list.map(async (p) => {
        if (iconCache.has(p.path))
            return iconCache.get(p.path);
        try {
            const uri = await invoke('get_project_icon', { project: p.path });
            iconCache.set(p.path, uri);
            return uri;
        }
        catch {
            iconCache.set(p.path, null);
            return null;
        }
    }));
}
const INITIAL_PROJECT_COUNT = 4;
async function renderStartupCards() {
    if (projects.length === 0)
        return null;
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
    stopDetailRefresh();
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
        if (el)
            messagesEl.replaceChildren(el);
    });
}
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
const TOKEN_LIMIT_KEYS = {
    input: 'csm-token-limit-input',
    output: 'csm-token-limit-output',
    total: 'csm-token-limit-total',
};
const TOKEN_TREND_POINT_LIMIT = {
    hour: 48,
    day: 30,
    week: 26,
    month: 24,
};
function focusProjectInSidebar(projectPath) {
    const displayName = projectDisplayName(projectPath);
    // Find the matching group header in the DOM
    const findAndFocus = () => {
        const headers = Array.from(document.querySelectorAll('.project-group-header'));
        let targetHeader = null;
        for (const h of headers) {
            const nameEl = h.querySelector('.truncate');
            if (nameEl?.textContent === displayName) {
                targetHeader = h;
                break;
            }
        }
        if (!targetHeader)
            return false;
        // Ensure accordion is open
        const chevron = targetHeader.querySelector('.project-group-chevron');
        const sessionsDiv = targetHeader.nextElementSibling;
        if (chevron && !chevron.classList.contains('open')) {
            chevron.classList.add('open');
            sessionsDiv?.classList.add('open');
            if (toggledProjects.has(projectPath))
                toggledProjects.delete(projectPath);
            else
                toggledProjects.add(projectPath);
            saveToggled();
        }
        targetHeader.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return true;
    };
    // If not found, clear search filter and try again
    if (!findAndFocus()) {
        const searchEl = byId('search');
        if (searchEl.value) {
            searchEl.value = '';
            requestRenderSessions();
        }
        requestAnimationFrame(findAndFocus);
    }
}
function isRecentProject(g) {
    return (Date.now() - g.sessions[0].lastTimestamp) < SEVEN_DAYS;
}
function isProjectOpen(g) {
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
function formatNum(n) {
    return Intl.NumberFormat(lang === 'ja' ? 'ja-JP' : 'en-US').format(Math.round(n || 0));
}
function formatUsd(v) {
    const n = v || 0;
    return '$' + (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(3));
}
function formatCompact(n) {
    const abs = Math.abs(n);
    if (abs >= 1000000000)
        return (n / 1000000000).toFixed(1) + 'B';
    if (abs >= 1000000)
        return (n / 1000000).toFixed(1) + 'M';
    if (abs >= 1000)
        return (n / 1000).toFixed(1) + 'K';
    return String(Math.round(n));
}
function parseTokenLimit(name) {
    const raw = localStorage.getItem(name);
    if (!raw)
        return 0;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}
function saveTokenLimit(name, value) {
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
    models: { opus: '#a78bfa', sonnet: '#818cf8', haiku: '#34d399' },
    tools: { Bash: '#f87171', Read: '#34d399', Edit: '#818cf8', Write: '#fbbf24', Glob: '#a78bfa', Grep: '#38bdf8', Agent: '#fb923c' },
    toolDefault: '#6b7280',
    wordPalette: ['#818cf8', '#34d399', '#f87171', '#fbbf24', '#a78bfa', '#38bdf8', '#fb923c', '#6b7280'],
};
function getCanvasSetup(canvas, height) {
    const parentWidth = canvas.parentElement?.clientWidth || 760;
    const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
    const width = Math.max(320, parentWidth - 16);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx)
        return null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    return { ctx, width, height, dpr };
}
function cssVar(name, fallback) {
    return getComputedStyle(document.body).getPropertyValue(name).trim() || fallback;
}
let chartTooltip = null;
function buildTooltipContent(lines) {
    const frag = createEl('div');
    lines.forEach(line => {
        const row = createEl('div', { style: 'display:flex;gap:6px;align-items:center' });
        if (line.color) {
            const dot = createEl('span');
            dot.style.cssText = `width:8px;height:8px;border-radius:2px;background:${line.color};display:inline-block;flex-shrink:0`;
            row.appendChild(dot);
        }
        const text = createEl(line.bold ? 'b' : 'span', { textContent: line.label });
        row.appendChild(text);
        frag.appendChild(row);
    });
    return frag;
}
function showChartTooltipEl(parent, x, y, content) {
    if (!chartTooltip) {
        chartTooltip = createEl('div', { className: 'chart-tooltip' });
        document.body.appendChild(chartTooltip);
    }
    chartTooltip.replaceChildren(content);
    chartTooltip.style.display = 'block';
    const rect = parent.getBoundingClientRect();
    let left = rect.left + x + 12;
    let top = rect.top + y - 10;
    if (left + 200 > window.innerWidth)
        left = rect.left + x - 200;
    if (top < 0)
        top = rect.top + y + 20;
    chartTooltip.style.left = `${left}px`;
    chartTooltip.style.top = `${top}px`;
}
function hideChartTooltip() {
    if (chartTooltip)
        chartTooltip.style.display = 'none';
}
function animateCounter(el, target, format, duration = 400) {
    const start = performance.now();
    const easeOutExpo = (t) => t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
    function tick(now) {
        const elapsed = Math.min((now - start) / duration, 1);
        const val = target * easeOutExpo(elapsed);
        el.textContent = format(val);
        if (elapsed < 1)
            requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
}
function drawStackedAreaChart(canvas, points) {
    const setup = getCanvasSetup(canvas, 280);
    if (!setup || !points.length)
        return;
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
    const x = (i) => padL + (points.length === 1 ? chartW / 2 : (i * chartW) / (points.length - 1));
    const y = (v) => padT + (1 - v / maxY) * chartH;
    // Grid
    ctx.strokeStyle = cssVar('--border', '#888');
    ctx.lineWidth = 0.5;
    ctx.setLineDash([4, 4]);
    for (let i = 0; i <= 4; i++) {
        const gy = padT + (chartH * i) / 4;
        ctx.beginPath();
        ctx.moveTo(padL, gy);
        ctx.lineTo(width - padR, gy);
        ctx.stroke();
    }
    ctx.setLineDash([]);
    // Stacked areas
    for (let layerIdx = colors.length - 1; layerIdx >= 0; layerIdx--) {
        ctx.beginPath();
        for (let i = 0; i < points.length; i++) {
            let cumTop = 0;
            for (let j = 0; j <= layerIdx; j++)
                cumTop += layers[i][j];
            const px = x(i), py = y(cumTop);
            if (i === 0)
                ctx.moveTo(px, py);
            else
                ctx.lineTo(px, py);
        }
        for (let i = points.length - 1; i >= 0; i--) {
            let cumBot = 0;
            for (let j = 0; j < layerIdx; j++)
                cumBot += layers[i][j];
            ctx.lineTo(x(i), y(cumBot));
        }
        ctx.closePath();
        ctx.fillStyle = colors[layerIdx] + '59';
        ctx.fill();
        ctx.beginPath();
        for (let i = 0; i < points.length; i++) {
            let cumTop = 0;
            for (let j = 0; j <= layerIdx; j++)
                cumTop += layers[i][j];
            const px = x(i), py = y(cumTop);
            if (i === 0)
                ctx.moveTo(px, py);
            else
                ctx.lineTo(px, py);
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
        if (mx < padL || mx > width - padR) {
            hideChartTooltip();
            return;
        }
        const idx = Math.round(((mx - padL) / chartW) * (points.length - 1));
        if (idx < 0 || idx >= points.length) {
            hideChartTooltip();
            return;
        }
        const p = points[idx];
        const vals = [p.inputTokens, p.outputTokens, p.cacheReadInputTokens || 0, p.cacheCreationInputTokens || 0];
        const tipLines = [{ label: p.label, bold: true }];
        vals.forEach((v, i) => tipLines.push({ color: colors[i], label: `${labels[i]}: ${formatNum(v)}` }));
        tipLines.push({ label: `Total: ${formatNum(p.totalTokens)}`, bold: true });
        showChartTooltipEl(canvas, mx, e.clientY - rect.top, buildTooltipContent(tipLines));
    };
    canvas.onmouseleave = () => hideChartTooltip();
}
function drawDonutChart(canvas, segments, centerLabel) {
    const size = 200;
    const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx)
        return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    const cx = size / 2, cy = size / 2, R = 88, r = 52;
    const total = segments.reduce((a, s) => a + s.value, 0);
    if (total === 0)
        return;
    let angle = -Math.PI / 2;
    const segAngles = [];
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
        if (dist < r || dist > R) {
            hideChartTooltip();
            return;
        }
        let a = Math.atan2(dy, dx);
        if (a < -Math.PI / 2)
            a += Math.PI * 2;
        const idx = segAngles.findIndex(s => a >= s.start && a <= s.end);
        if (idx < 0) {
            hideChartTooltip();
            return;
        }
        const seg = segments[idx];
        const pct = ((seg.value / total) * 100).toFixed(1);
        showChartTooltipEl(canvas, e.clientX - rect.left, e.clientY - rect.top, buildTooltipContent([{ color: seg.color, label: seg.label, bold: true }, { label: `${formatNum(seg.value)} (${pct}%)` }]));
    };
    canvas.onmouseleave = () => hideChartTooltip();
}
function drawHeatmap(canvas, byDay) {
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
    if (!ctx)
        return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const dayMap = new Map();
    byDay.forEach(d => dayMap.set(d.label, d.totalTokens));
    const today = new Date();
    const dates = [];
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
    const dayLabels = [t('dayMon'), '', t('dayWed'), '', t('dayFri'), '', ''];
    dayLabels.forEach((label, i) => {
        if (label)
            ctx.fillText(label, padL - 4, padT + i * (cellSize + gap) + cellSize - 1);
    });
    ctx.textAlign = 'center';
    let lastMonth = -1;
    const months = [t('month1'), t('month2'), t('month3'), t('month4'), t('month5'), t('month6'), t('month7'), t('month8'), t('month9'), t('month10'), t('month11'), t('month12')];
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
        }
        else {
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
        if (col < 0 || col >= cols || row < 0 || row >= rows) {
            hideChartTooltip();
            return;
        }
        const idx = col * rows + row;
        if (idx >= dates.length) {
            hideChartTooltip();
            return;
        }
        const d = dates[idx];
        const key = d.toISOString().slice(0, 10);
        const val = dayMap.get(key) || 0;
        showChartTooltipEl(canvas, e.clientX - rect.left, e.clientY - rect.top, buildTooltipContent([{ label: key, bold: true }, { label: `${formatNum(val)} tokens` }]));
    };
    canvas.onmouseleave = () => hideChartTooltip();
}
function drawWordCloud(canvas, words) {
    const w = 380, h = 260;
    const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx || !words.length)
        return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const top = words.slice(0, 40);
    const maxFreq = top[0]?.count || 1;
    const placed = [];
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
            if (px < 0 || py < 0 || px + tw > w || py + th > h) {
                angle += 0.3;
                radius += 0.4;
                continue;
            }
            const collides = placed.some(p => !(px + tw < p.x || px > p.x + p.w || py + th < p.y || py > p.y + p.h));
            if (!collides) {
                found = true;
                break;
            }
            angle += 0.3;
            radius += 0.4;
        }
        if (!found)
            return;
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
        if (hit < 0) {
            hideChartTooltip();
            canvas.style.cursor = 'default';
            return;
        }
        canvas.style.cursor = 'pointer';
        const countLabel = `${top[hit].count} ${t('countTimes')}`;
        showChartTooltipEl(canvas, e.clientX - rect.left, e.clientY - rect.top, buildTooltipContent([{ label: top[hit].word, bold: true }, { label: countLabel }]));
    };
    canvas.onmouseleave = () => { hideChartTooltip(); canvas.style.cursor = 'default'; };
}
function closeTokenModal() {
    if (!tokenModal)
        return;
    tokenModal.remove();
    tokenModal = null;
}
function mkTokenTable(headers, rows) {
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
function tokenTrendPoints(data, period) {
    if (period === 'hour')
        return data.byHour.slice(-TOKEN_TREND_POINT_LIMIT.hour);
    if (period === 'day')
        return data.byDay.slice(-TOKEN_TREND_POINT_LIMIT.day);
    if (period === 'week')
        return data.byWeek.slice(-TOKEN_TREND_POINT_LIMIT.week);
    return data.byMonth.slice(-TOKEN_TREND_POINT_LIMIT.month);
}
const TIME_RANGES = [
    { label: '1W', days: 7 },
    { label: '2W', days: 14 },
    { label: '1M', days: 30 },
    { label: '3M', days: 90 },
    { label: '6M', days: 180 },
    { label: '1Y', days: 365 },
    { label: 'All', days: null },
];
async function openTokenModal() {
    closeTokenModal();
    const modal = createEl('div', {
        className: 'token-modal',
        onClick: (e) => {
            if (e.target === modal)
                closeTokenModal();
        }
    });
    const title = createEl('div', { className: 'text-sm font-medium truncate', textContent: t('tokenTitle') });
    title.style.color = 'var(--text-secondary)';
    const usageBtn = createEl('button', { className: 'mac-btn text-xs', textContent: t('tokenOpenUsage') });
    const refreshBtn = createEl('button', { className: 'mac-btn text-xs', textContent: t('tokenRefresh') });
    const closeBtn = createEl('button', { className: 'token-close-btn', textContent: '\u00D7' });
    const body = createEl('div', { className: 'token-body', textContent: t('loading') });
    // Time range selector
    const rangePills = createEl('div', { className: 'token-pill-group' });
    let selectedRange = null; // null = all
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
    rangePills.lastElementChild?.classList.add('active');
    const headerRow1 = createEl('div', { className: 'token-header-row' }, [title, createEl('span', { style: 'flex:1' }), closeBtn]);
    const headerRow2 = createEl('div', { className: 'token-header-row' }, [rangePills, createEl('span', { style: 'flex:1' }), usageBtn, refreshBtn]);
    const header = createEl('div', { className: 'token-header' }, [headerRow1, headerRow2]);
    const dialog = createEl('div', { className: 'token-dialog' }, [header, body]);
    modal.appendChild(dialog);
    document.body.appendChild(modal);
    tokenModal = modal;
    modal.tabIndex = -1;
    modal.focus();
    closeBtn.addEventListener('click', () => closeTokenModal());
    usageBtn.addEventListener('click', async () => {
        const result = await invoke('open_usage_stats');
        if (result && !result.ok)
            actions.showToast(t('toastError') + (result.error || ''));
    });
    modal.addEventListener('keydown', (e) => {
        if (e.key === 'Escape')
            closeTokenModal();
    });
    // Track canvases for resize redraw
    let resizeRedrawFns = [];
    let resizeTimer = null;
    const resizeObserver = new ResizeObserver(() => {
        if (resizeTimer)
            clearTimeout(resizeTimer);
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
        const data = await invoke('get_token_dashboard', { sinceDays: selectedRange });
        if (!data || !data.totals || data.totals.totalTokens === 0) {
            body.replaceChildren(createEl('div', { className: 'text-xs', textContent: t('tokenNoData') }));
            return;
        }
        body.replaceChildren();
        // [A] Hero stat cards with colored accent and animated counters
        const cardColors = [CHART_COLORS.output, CHART_COLORS.input, CHART_COLORS.output, CHART_COLORS.cacheRead, '#a78bfa'];
        const cardData = [
            { label: t('tokenTotal'), value: data.totals.totalTokens, fmt: formatNum, color: cardColors[0] },
            { label: t('tokenInput'), value: data.totals.inputTokens, fmt: formatNum, color: cardColors[1] },
            { label: t('tokenOutput'), value: data.totals.outputTokens, fmt: formatNum, color: cardColors[2] },
            { label: t('tokenCacheRead'), value: data.totals.cacheReadInputTokens, fmt: formatNum, color: cardColors[3] },
            { label: t('tokenEstimatedCost'), value: data.totals.estimatedCostUsd, fmt: formatUsd, color: cardColors[4] },
        ];
        const grid = createEl('div', { className: 'token-grid' });
        cardData.forEach(cd => {
            const card = createEl('div', { className: 'token-card' });
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
        const periods = [
            { key: 'hour', label: t('tokenPeriodHour') },
            { key: 'day', label: t('tokenPeriodDay') },
            { key: 'week', label: t('tokenPeriodWeek') },
            { key: 'month', label: t('tokenPeriodMonth') },
        ];
        let activePeriod = 'day';
        const chartWrap = createEl('div', { className: 'token-chart-wrap' });
        const canvas = createEl('canvas', { className: 'token-chart' });
        chartWrap.appendChild(canvas);
        // Legend row
        const legendColors = [CHART_COLORS.input, CHART_COLORS.output, CHART_COLORS.cacheRead, CHART_COLORS.cacheCreate];
        const legendLabels = ['Input', 'Output', 'Cache Read', 'Cache Create'];
        const legendRow = createEl('div', { className: 'token-chart-legend' });
        legendLabels.forEach((lbl, i) => {
            const dot = createEl('span', { className: 'token-legend-dot' });
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
            const modelCanvas = createEl('canvas');
            const modelSegs = data.byModel.map(m => ({
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
                const dot = createEl('span', { className: 'token-legend-dot' });
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
            const fill = createEl('div', { className: 'token-limit-bar-fill' });
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
            const toolCanvas = createEl('canvas');
            const topTools = data.toolUsage.slice(0, 8);
            const toolSegs = topTools.map(t => ({
                label: t.name,
                value: t.count,
                color: CHART_COLORS.tools[t.name] || CHART_COLORS.toolDefault,
            }));
            toolChartWrap.appendChild(toolCanvas);
            const toolLegend = createEl('div', { className: 'token-donut-legend' });
            topTools.forEach(tool => {
                const row = createEl('div', { className: 'token-legend-item' });
                const dot = createEl('span', { className: 'token-legend-dot' });
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
            const wordCanvas = createEl('canvas');
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
            const heatmapCanvas = createEl('canvas');
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
        const mkLimit = (label, used, limit, key) => {
            const pct = limit > 0 ? Math.round((used / limit) * 100) : 0;
            const over = limit > 0 && used > limit;
            const remain = limit > 0 ? Math.max(0, limit - used) : 0;
            const fill = createEl('div', { className: 'token-limit-bar-fill' });
            fill.style.width = `${Math.min(100, pct)}%`;
            const inp = createEl('input', {
                className: 'token-limit-input',
                type: 'number',
                min: '0',
                placeholder: t('tokenLimitUnset'),
                value: limit > 0 ? String(limit) : '',
            });
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
        const mkCollapsible = (title, content) => {
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
        body.appendChild(mkCollapsible(t('tokenByHour'), mkTokenTable(['Hour', t('tokenInput'), t('tokenOutput'), t('tokenTotal')], data.byHour.slice(-24).map(h => [h.label, formatNum(h.inputTokens), formatNum(h.outputTokens), formatNum(h.totalTokens)]))));
        body.appendChild(mkCollapsible(t('tokenByDay'), mkTokenTable(['Date', t('tokenInput'), t('tokenOutput'), t('tokenTotal')], data.byDay.slice(-14).map(d => [d.label, formatNum(d.inputTokens), formatNum(d.outputTokens), formatNum(d.totalTokens)]))));
        body.appendChild(mkCollapsible(t('tokenByWeek'), mkTokenTable(['Week', t('tokenTotal'), t('tokenEstimatedCost')], data.byWeek.slice(-12).map(w => [w.label, formatNum(w.totalTokens), formatUsd(w.estimatedCostUsd)]))));
        body.appendChild(mkCollapsible(t('tokenByMonth'), mkTokenTable(['Month', t('tokenTotal'), t('tokenEstimatedCost')], data.byMonth.slice(-12).map(m => [m.label, formatNum(m.totalTokens), formatUsd(m.estimatedCostUsd)]))));
        body.appendChild(mkCollapsible(t('tokenBySession'), mkTokenTable(['Session', 'Project', t('tokenTotal'), t('tokenEstimatedCost')], data.bySession.slice(0, 25).map(s => [s.sessionId.slice(0, 8), projectDisplayName(s.project), formatNum(s.totalTokens), formatUsd(s.estimatedCostUsd)]))));
        body.appendChild(mkCollapsible(t('tokenByProject'), mkTokenTable(['Project', 'Sessions', t('tokenTotal'), t('tokenEstimatedCost')], data.byProject.slice(0, 20).map(p => [projectDisplayName(p.project), String(p.sessionCount), formatNum(p.totalTokens), formatUsd(p.estimatedCostUsd)]))));
    }
    refreshBtn.addEventListener('click', () => { void renderData(); });
    void renderData();
}
function renderSessionItem(s) {
    const cb = createEl('input', {
        type: 'checkbox',
        className: 'session-check mac-check mt-1 flex-shrink-0',
        'data-id': s.sessionId,
        onChange: (e) => {
            const target = e.target;
            if (target?.checked)
                selectedIds.add(s.sessionId);
            else
                selectedIds.delete(s.sessionId);
            const ab = byId('archiveSelectedBtn');
            ab.classList.toggle('invisible', selectedIds.size === 0);
            ab.classList.toggle('visible', selectedIds.size > 0);
        }
    });
    if (selectedIds.has(s.sessionId))
        cb.checked = true;
    const firstMsg = createEl('p', { className: 'session-first text-sm leading-snug truncate', textContent: s.firstDisplay });
    firstMsg.style.color = 'var(--text)';
    const lastMsg = (s.lastDisplay && s.lastDisplay !== s.firstDisplay)
        ? createEl('p', { className: 'session-last text-xs leading-snug truncate mt-0.5', textContent: s.lastDisplay })
        : null;
    if (lastMsg)
        lastMsg.style.color = 'var(--text-muted)';
    const dot = () => { const sp = createEl('span', { className: 'text-[10px] flex-shrink-0', textContent: '·' }); sp.style.color = 'var(--text-dot)'; return sp; };
    const meta = (txt, cls = '') => { const sp = createEl('span', { className: `text-[10px] flex-shrink-0 ${cls}`.trim(), textContent: txt }); sp.style.color = 'var(--text-faint)'; return sp; };
    const metaParts = [meta(timeAgo(s.lastTimestamp, lang, t), 'session-meta-time'), dot(), meta(s.messageCount + t('msg'), 'session-meta-count')];
    if (s.archived) {
        const sp = createEl('span', { className: 'session-meta-archived text-[10px] flex-shrink-0', textContent: t('archived') });
        sp.style.color = 'var(--text-faint)';
        metaParts.push(sp);
    }
    const updated = isUpdatedSession(s);
    const metaDiv = createEl('div', { className: 'session-meta mt-1 overflow-hidden' }, metaParts);
    metaDiv.style.cssText = 'display:grid;grid-auto-flow:column;grid-auto-columns:max-content;align-items:center;gap:8px;';
    const textDiv = createEl('div', { className: 'session-text min-w-0 overflow-hidden' }, [firstMsg, lastMsg, metaDiv].filter(Boolean));
    const rowChildren = [cb];
    if (updated) {
        const updDot = createEl('span', { className: 'session-updated-dot flex-shrink-0 mt-1.5' });
        updDot.style.cssText = 'width:7px;height:7px;border-radius:50%;background:var(--updated-dot);';
        rowChildren.push(updDot);
    }
    rowChildren.push(textDiv);
    const row = createEl('div', { className: 'session-row overflow-hidden' }, rowChildren);
    row.style.cssText = 'display:grid;grid-template-columns:' + (updated ? 'auto auto 1fr' : 'auto 1fr') + ';align-items:start;gap:8px;';
    const isActive = selectedSession === s.sessionId;
    const defaultBg = updated ? 'var(--updated-bg)' : 'transparent';
    const item = createEl('div', {
        className: 'session-item p-3 rounded cursor-default transition border overflow-hidden',
        'data-id': s.sessionId,
        'data-project': s.project,
        'data-default-bg': defaultBg,
        onClick: (e) => {
            const target = e.target;
            if (target?.tagName === 'INPUT')
                return;
            hidePreview();
            selectedSession = s.sessionId;
            knownTimestamps[s.sessionId] = s.lastTimestamp;
            syncActiveSessionItem(item);
            void showDetail(s.sessionId);
        }
    }, [row]);
    setSessionItemActiveState(item, isActive);
    if (isActive)
        activeSessionItemEl = item;
    if (s.archived)
        item.style.opacity = '0.4';
    // Tooltip with date
    const dateStr = s.lastTimestamp ? new Date(s.lastTimestamp).toLocaleString(lang === 'ja' ? 'ja-JP' : 'en-US') : '';
    item.title = dateStr;
    item.addEventListener('mouseenter', () => {
        if (!item.classList.contains('session-item-active'))
            item.style.background = 'var(--item-hover)';
        if (!item.classList.contains('session-item-active') && (isDetailPaneVisible() || isPreviewHotkeyPressed)) {
            schedulePreviewShow(s.sessionId, item.getBoundingClientRect());
        }
    });
    item.addEventListener('mouseleave', () => {
        if (!item.classList.contains('session-item-active'))
            item.style.background = defaultBg;
        schedulePreviewHide();
    });
    return item;
}
function setSessionItemActiveState(item, isActive) {
    if (isActive) {
        item.classList.add('session-item-active');
        item.style.borderColor = 'var(--item-active-border)';
        item.style.background = 'var(--item-active)';
        return;
    }
    item.classList.remove('session-item-active');
    item.style.borderColor = 'transparent';
    item.style.background = item.getAttribute('data-default-bg') || 'transparent';
}
function findSessionItemById(sessionId) {
    const listEl = byId('sessionList');
    if (!listEl)
        return null;
    const items = listEl.querySelectorAll('.session-item');
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.getAttribute('data-id') === sessionId)
            return item;
    }
    return null;
}
function syncActiveSessionItem(nextItem = null) {
    if (activeSessionItemEl && activeSessionItemEl !== nextItem) {
        setSessionItemActiveState(activeSessionItemEl, false);
    }
    let target = nextItem;
    if (!target && selectedSession) {
        target = findSessionItemById(selectedSession);
    }
    if (target) {
        setSessionItemActiveState(target, true);
        activeSessionItemEl = target;
        return;
    }
    activeSessionItemEl = null;
}
function matchesSessionSearch(s, searchLower) {
    if (!searchLower)
        return true;
    return ((s.firstDisplay || '').toLowerCase().includes(searchLower) ||
        (s.lastDisplay || '').toLowerCase().includes(searchLower) ||
        s.project.toLowerCase().includes(searchLower) ||
        (projectNameMap[s.project] || '').toLowerCase().includes(searchLower));
}
function getFilteredSessions() {
    const searchLower = byId('search').value.toLowerCase();
    return sessions.filter((s) => {
        if (selectedProject && s.project !== selectedProject)
            return false;
        return matchesSessionSearch(s, searchLower);
    });
}
function updateSessionListTitle(filteredCount) {
    byId('sessionListTitle').textContent =
        filteredCount + ' ' + t('sessions') + (selectedProject ? ' — ' + projectDisplayName(selectedProject) : '');
}
function updateArchiveSelectedButton() {
    const archBtn = byId('archiveSelectedBtn');
    archBtn.classList.toggle('invisible', selectedIds.size === 0);
    archBtn.classList.toggle('visible', selectedIds.size > 0);
}
function groupSessionsByProject(filtered) {
    const groups = [];
    const groupMap = {};
    filtered.forEach((s) => {
        if (!groupMap[s.project]) {
            groupMap[s.project] = { path: s.project, sessions: [] };
            groups.push(groupMap[s.project]);
        }
        groupMap[s.project].sessions.push(s);
    });
    return groups;
}
function renderProjectGroup(g, groups) {
    const open = isProjectOpen(g);
    const group = createEl('div', { className: 'project-group' });
    const chevron = createEl('span', { className: 'project-group-chevron' + (open ? ' open' : ''), textContent: '\u25B6' });
    const name = createEl('span', { className: 'text-xs font-medium flex-1 truncate', textContent: projectDisplayName(g.path) });
    name.style.color = 'var(--text-secondary)';
    const count = createEl('span', { className: 'text-[10px] flex-shrink-0', textContent: g.sessions.length + '' });
    count.style.cssText = 'color:var(--text-muted);min-width:24px;text-align:right;';
    const startBtn = createEl('button', {
        className: 'project-start-btn',
        textContent: '+',
        title: t('startProjectSession'),
        onClick: async (e) => {
            e.stopPropagation();
            const result = await invoke('start_new_session_in_project', { project: g.path });
            if (!result?.ok)
                actions.showToast(t('toastError') + (result?.error || ''));
            else
                setTimeout(() => fetchSessions(byId('showArchived').checked), 2000);
        }
    });
    const icon = createEl('span', { className: 'project-group-icon' });
    icon.innerHTML = ICONS.folder; // static SVG from icons.ts
    const header = createEl('div', { className: 'project-group-header' }, [chevron, icon, name, startBtn, count]);
    if (projectNameMap[g.path])
        header.title = shortPath(g.path);
    const now = Date.now();
    const recentSessions = g.sessions.filter(s => (now - s.lastTimestamp) < SEVEN_DAYS);
    const olderSessions = g.sessions.filter(s => (now - s.lastTimestamp) >= SEVEN_DAYS);
    const sessionsDiv = createEl('div', { className: 'project-group-sessions' + (open ? ' open' : '') });
    recentSessions.forEach(s => sessionsDiv.appendChild(renderSessionItem(s)));
    if (olderSessions.length > 0) {
        if (showAllSessions.has(g.path)) {
            olderSessions.forEach(s => sessionsDiv.appendChild(renderSessionItem(s)));
        }
        else {
            const showOlderBtn = createEl('button', {
                className: 'show-older-pill',
                textContent: t('showOlder') + ' (' + olderSessions.length + ')',
                onClick: (e) => {
                    e.stopPropagation();
                    showAllSessions.add(g.path);
                    requestRenderSessions();
                }
            });
            sessionsDiv.appendChild(showOlderBtn);
        }
    }
    if (recentSessions.length === 0 && !showAllSessions.has(g.path)) {
        const hint = createEl('p', { className: 'text-[11px] px-3 py-1.5', textContent: t('noRecentSessions') });
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
                groups.forEach(gg => { if (isRecentProject(gg))
                    toggledProjects.add(gg.path); });
            }
            else {
                groups.forEach(gg => { if (!isRecentProject(gg))
                    toggledProjects.add(gg.path); });
            }
            saveToggled();
            return;
        }
        if (toggledProjects.has(g.path))
            toggledProjects.delete(g.path);
        else
            toggledProjects.add(g.path);
        saveToggled();
        chevron.classList.toggle('open');
        sessionsDiv.classList.toggle('open');
    });
    group.appendChild(header);
    group.appendChild(sessionsDiv);
    return group;
}
function renderSessions() {
    const filtered = getFilteredSessions();
    updateSessionListTitle(filtered.length);
    updateArchiveSelectedButton();
    const el = byId('sessionList');
    activeSessionItemEl = null;
    el.replaceChildren();
    if (selectedProject) {
        filtered.forEach(s => el.appendChild(renderSessionItem(s)));
        return;
    }
    const groups = groupSessionsByProject(filtered);
    groups.forEach((g) => {
        el.appendChild(renderProjectGroup(g, groups));
    });
}
function prepareDetailPane(pane, messagesEl) {
    stopDetailRefresh();
    document.body.style.gridTemplateColumns = '280px 1px 1fr';
    if (isTauri) {
        tauriWindow.window.getCurrentWindow().setMinSize(new tauriWindow.window.LogicalSize(700, 500));
    }
    byId('resizeHandle').style.display = '';
    pane.style.display = 'grid';
    if (renderAbort)
        renderAbort.aborted = true;
    messagesEl.style.display = 'block';
    messagesEl.replaceChildren();
    messagesEl.scrollTop = 0;
    chatSearch.reset();
    hidePreview();
}
async function getDetailWithCache(sessionId) {
    const cached = getPreviewDetailCached(sessionId);
    const detail = cached || await fetchDetail(sessionId);
    if (!detail)
        return null;
    setPreviewDetailCached(sessionId, detail);
    return detail;
}
function renderDetailHeader(sessionId, detail, headerEl) {
    const sessionSummary = sessions.find(s => s.sessionId === sessionId);
    const projectName = projectDisplayName(detail.project);
    const sessionTitle = sessionSummary ? sessionSummary.firstDisplay : '';
    const projLine = createEl('span', { className: 'text-xs font-medium', textContent: projectName });
    projLine.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;color:var(--text-secondary);cursor:default;';
    projLine.title = shortPath(detail.project);
    projLine.addEventListener('click', () => focusProjectInSidebar(detail.project));
    const sep = createEl('span', { className: 'text-xs', textContent: '\u00B7' });
    sep.style.cssText = 'color:var(--text-faint);flex-shrink:0;';
    const titleLine = createEl('span', { className: 'text-xs', textContent: sessionTitle || sessionId.slice(0, 8) });
    titleLine.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;color:var(--text-muted);cursor:default;';
    titleLine.title = sessionId;
    titleLine.addEventListener('click', () => {
        const item = findSessionItemById(sessionId);
        if (item) {
            item.scrollIntoView({ behavior: 'smooth', block: 'center' });
            item.style.outline = '2px solid var(--accent)';
            setTimeout(() => { item.style.outline = ''; }, 1500);
        }
    });
    const infoRow = createEl('div', {}, [projLine, sep, titleLine]);
    infoRow.style.cssText = 'display:flex;align-items:baseline;gap:6px;min-width:0;overflow:hidden;';
    infoRow.setAttribute('data-tauri-drag-region', '');
    const chatSearchInput = createEl('input', {
        type: 'text', id: 'chatSearch',
        className: 'mac-input',
        spellcheck: 'false',
        autocorrect: 'off',
        autocapitalize: 'off',
        autocomplete: 'off',
    });
    chatSearchInput.style.cssText = 'width:100%;height:28px;padding:4px 60px 4px 8px;box-sizing:border-box;';
    chatSearchInput.placeholder = t('chatSearchPlaceholder');
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
    // Filter segmented control: All / AI / User (speech bubble icons)
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
            // Tabler "messages": two overlapping bubbles
            return svgEl('svg', bubbleSvgAttrs, [
                svgEl('path', { d: 'M21 14l-3 -3h-7a1 1 0 0 1 -1 -1v-6a1 1 0 0 1 1 -1h9a1 1 0 0 1 1 1v10' }),
                svgEl('path', { d: 'M14 15v2a1 1 0 0 1 -1 1h-7l-3 3v-10a1 1 0 0 1 1 -1h2' }),
            ]);
        }
        // Tabler "message": single bubble, tail bottom-left
        const svg = svgEl('svg', bubbleSvgAttrs, [
            svgEl('path', { d: 'M18 4a3 3 0 0 1 3 3v8a3 3 0 0 1 -3 3h-5l-5 3v-3h-2a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3h12' }),
        ]);
        if (key === 'user')
            svg.style.transform = 'scaleX(-1)';
        return svg;
    }
    const filters = [
        { key: 'all', label: t('chatFilterAll') },
        { key: 'assistant', label: t('chatFilterAI') },
        { key: 'user', label: t('chatFilterUser') },
    ];
    const filterBar = createEl('div', { className: 'mac-segmented' });
    const filterBtns = [];
    for (const f of filters) {
        const btn = createEl('button', {
            className: 'mac-segmented-btn' + (f.key === chatSearch.getFilter() ? ' active' : ''),
        });
        btn.appendChild(bubbleIcon(f.key));
        btn.title = f.label;
        btn.style.cssText += 'display:inline-flex;align-items:center;justify-content:center;padding:3px 7px;';
        btn.addEventListener('click', () => {
            chatSearch.setFilter(f.key);
            filterBtns.forEach((b, i) => {
                b.classList.toggle('active', filters[i].key === f.key);
            });
            chatSearch.doSearch();
        });
        filterBtns.push(btn);
        filterBar.appendChild(btn);
    }
    const controlsRow = createEl('div', { className: 'min-w-0' }, [filterBar, searchGroup]);
    controlsRow.style.cssText = 'display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:8px;';
    // Place infoRow inside the titlebar drag area (bottom-aligned) so that
    // controlsRow aligns vertically with the left pane's search row.
    const titlebarDrag = headerEl.previousElementSibling;
    if (titlebarDrag?.classList.contains('titlebar-drag')) {
        titlebarDrag.style.cssText = 'display:flex;align-items:flex-end;padding:0 16px 10px;min-width:0;background:var(--bg-surface);';
        titlebarDrag.replaceChildren(infoRow);
    }
    headerEl.replaceChildren(controlsRow);
    let chatSearchTimer;
    chatSearchInput.addEventListener('input', () => {
        chatClearBtn.style.display = chatSearchInput.value ? 'block' : 'none';
        clearTimeout(chatSearchTimer);
        chatSearchTimer = setTimeout(() => chatSearch.doSearch(), 200);
    });
    chatClearBtn.addEventListener('click', () => {
        chatSearchInput.value = '';
        chatClearBtn.style.display = 'none';
        chatSearch.doSearch();
        chatSearchInput.focus();
    });
    nextBtn.addEventListener('click', () => chatSearch.next());
    prevBtn.addEventListener('click', () => chatSearch.prev());
    chatSearchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.shiftKey ? chatSearch.prev() : chatSearch.next();
            e.preventDefault();
        }
        if (e.key === 'Escape') {
            const target = e.target;
            if (target) {
                target.value = '';
                chatClearBtn.style.display = 'none';
                chatSearch.doSearch();
                target.blur();
            }
        }
    });
}
function renderDetailFooter(sessionId) {
    const mkBtn = (text, isPrimary, onClick) => {
        const btn = createEl('button', {
            className: 'mac-btn flex-shrink-0' + (isPrimary ? ' mac-btn-primary' : ''),
            textContent: text, onClick
        });
        return btn;
    };
    const footerEl = byId('detailFooter');
    const updatedSessionSummary = sessions.find(s => s.sessionId === sessionId);
    const sessionUpdated = updatedSessionSummary ? isUpdatedSession(updatedSessionSummary) : false;
    const resumeOpenBtn = mkBtn(isRemote() ? t('resumeCopy') : 'Resume (' + (serverSettings.terminalApp || 'Terminal') + ')', sessionUpdated, () => isRemote() ? actions.copyResume(sessionId) : actions.resumeInTerminal(sessionId));
    const resumeCopyBtn = mkBtn(t('copyCmd'), false, () => actions.copyResume(sessionId));
    const archiveBtn = mkBtn(t('archive'), false, () => actions.archiveSingle(sessionId));
    const summarizeBtn = mkBtn(t('summarize'), false, async () => {
        const res = await invoke('resume_with_prompt', {
            sessionId,
            prompt: t('summarizePrompt'),
        });
        if (res?.ok)
            actions.showToast(t('toastSummarizing'));
        else
            actions.showToast(t('toastError') + (res?.error || ''));
    });
    footerEl.replaceChildren(resumeOpenBtn, resumeCopyBtn, summarizeBtn, archiveBtn);
}
function renderMsgDesc(desc, resultMap) {
    const { msg: m, hasText, hasTools } = desc;
    const isUser = m.type === 'user';
    const els = [];
    if (hasTools) {
        const toolEls = renderToolBlocks(m.tools || [], resultMap, createEl);
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
    const hasImages = Boolean(m.images && m.images.length > 0);
    if (!hasText && !hasImages)
        return els;
    const bubbleInner = createEl('div', { className: 'md-content text-sm leading-relaxed break-words' });
    if (hasText)
        bubbleInner.innerHTML = renderMarkdown(m.content || '');
    if (hasImages) {
        for (const img of m.images || []) {
            const imgEl = document.createElement('img');
            imgEl.className = 'chat-inline-img';
            if (img.sourceType === 'base64')
                imgEl.src = `data:${img.mediaType};base64,${img.data}`;
            else
                imgEl.src = `asset://localhost/${encodeURIComponent(img.data)}`;
            imgEl.alt = 'image';
            bubbleInner.appendChild(imgEl);
        }
    }
    const bubble = createEl('div', { className: (isUser ? 'bubble-user' : 'bubble-assistant') + ' px-4 py-2.5' }, [bubbleInner]);
    bubble.style.justifySelf = isUser ? 'end' : 'start';
    els.push(bubble);
    return els;
}
function appendRenderedMsgDesc(desc, parentEl, resultMap) {
    const els = renderMsgDesc(desc, resultMap);
    if (els.length === 0) {
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
// State for active detail auto-refresh
let activeDetailState = null;
let detailRefreshTimer = null;
function stopDetailRefresh() {
    if (detailRefreshTimer !== null) {
        clearInterval(detailRefreshTimer);
        detailRefreshTimer = null;
    }
    activeDetailState = null;
}
function startDetailRefresh(sessionId, messageCount, globalResultMap, chatContainer, messagesEl) {
    stopDetailRefresh();
    activeDetailState = { sessionId, messageCount, globalResultMap, chatContainer, messagesEl };
    detailRefreshTimer = setInterval(async () => {
        const state = activeDetailState;
        if (!state || state.sessionId !== selectedSession) {
            stopDetailRefresh();
            return;
        }
        let detail;
        try {
            detail = await fetchDetail(state.sessionId);
        }
        catch {
            return;
        }
        if (!detail || detail.messages.length <= state.messageCount)
            return;
        // Update cache
        setPreviewDetailCached(state.sessionId, detail);
        // Collect new tool results
        const newMessages = detail.messages.slice(state.messageCount);
        for (const m of newMessages) {
            if (m.tools) {
                for (const tool of m.tools) {
                    if (tool.name === '_result')
                        state.globalResultMap[tool.id] = tool;
                }
            }
        }
        // Check if user is scrolled to bottom (within 50px tolerance)
        const wasAtBottom = state.messagesEl.scrollHeight - state.messagesEl.scrollTop - state.messagesEl.clientHeight < 50;
        // Append new messages
        for (let i = 0; i < newMessages.length; i++) {
            const origIdx = state.messageCount + i;
            const m = newMessages[i];
            const hasText = Boolean(m.content && m.content !== '[Tool Result]' && !m.content.startsWith('[Tool:'));
            const hasTools = Boolean(m.tools && m.tools.length > 0);
            appendRenderedMsgDesc({ msg: m, hasText, hasTools, origIdx }, state.chatContainer, state.globalResultMap);
        }
        state.messageCount = detail.messages.length;
        if (wasAtBottom) {
            requestAnimationFrame(() => { state.messagesEl.scrollTop = state.messagesEl.scrollHeight; });
        }
    }, 5000);
}
function renderDetailMessages(detail, messagesEl) {
    stopDetailRefresh();
    messagesEl.replaceChildren();
    const chatContainer = createEl('div', {});
    chatContainer.style.cssText = 'display:grid;gap:12px;';
    const globalResultMap = {};
    detail.messages.forEach((m) => {
        if (m.tools) {
            m.tools.filter((tool) => tool.name === '_result').forEach((tool) => { globalResultMap[tool.id] = tool; });
        }
    });
    const msgDescs = [];
    detail.messages.forEach((m, origIdx) => {
        const hasText = Boolean(m.content &&
            m.content !== '[Tool Result]' &&
            !m.content.startsWith('[Tool:'));
        const hasTools = Boolean(m.tools && m.tools.length > 0);
        msgDescs.push({ msg: m, hasText, hasTools, origIdx });
    });
    const immediateCount = Math.min(100, msgDescs.length);
    const deferredCount = msgDescs.length - immediateCount;
    const deferredPlaceholder = deferredCount > 0 ? createEl('div') : null;
    if (deferredPlaceholder)
        chatContainer.appendChild(deferredPlaceholder);
    for (let i = deferredCount; i < msgDescs.length; i++) {
        appendRenderedMsgDesc(msgDescs[i], chatContainer, globalResultMap);
    }
    messagesEl.appendChild(chatContainer);
    const spacer = createEl('div', {});
    spacer.style.height = '24px';
    messagesEl.appendChild(spacer);
    requestAnimationFrame(() => { messagesEl.scrollTop = messagesEl.scrollHeight; });
    const ctrl = { aborted: false };
    renderAbort = ctrl;
    allMessagesRendered = (deferredCount === 0);
    function flushDeferred() {
        if (allMessagesRendered)
            return;
        if (!deferredPlaceholder)
            return;
        const frag = document.createDocumentFragment();
        for (let i = 0; i < deferredCount; i++) {
            appendRenderedMsgDesc(msgDescs[i], frag, globalResultMap);
        }
        const prevScrollTop = messagesEl.scrollTop;
        const prevScrollHeight = messagesEl.scrollHeight;
        deferredPlaceholder.replaceWith(frag);
        messagesEl.scrollTop = prevScrollTop + (messagesEl.scrollHeight - prevScrollHeight);
        allMessagesRendered = true;
    }
    window._flushRender = flushDeferred;
    if (deferredCount > 0) {
        let chunkIdx = 0;
        const deferredFrag = document.createDocumentFragment();
        function buildChunk(deadline) {
            if (ctrl.aborted)
                return;
            const end = Math.min(chunkIdx + 10, deferredCount);
            while (chunkIdx < end) {
                appendRenderedMsgDesc(msgDescs[chunkIdx], deferredFrag, globalResultMap);
                chunkIdx++;
                if (deadline && deadline.timeRemaining && deadline.timeRemaining() < 2)
                    break;
            }
            if (chunkIdx < deferredCount) {
                if (typeof requestIdleCallback === 'function')
                    requestIdleCallback(buildChunk, { timeout: 100 });
                else
                    setTimeout(() => buildChunk(null), 16);
            }
            else if (!ctrl.aborted && deferredPlaceholder && deferredPlaceholder.parentNode) {
                const prevScrollTop = messagesEl.scrollTop;
                const prevScrollHeight = messagesEl.scrollHeight;
                deferredPlaceholder.replaceWith(deferredFrag);
                messagesEl.scrollTop = prevScrollTop + (messagesEl.scrollHeight - prevScrollHeight);
                allMessagesRendered = true;
            }
        }
        if (typeof requestIdleCallback === 'function')
            requestIdleCallback(buildChunk, { timeout: 100 });
        else
            setTimeout(() => buildChunk(null), 16);
    }
    // Start auto-refresh for this session
    if (selectedSession) {
        startDetailRefresh(selectedSession, detail.messages.length, globalResultMap, chatContainer, messagesEl);
    }
}
async function showDetail(sessionId) {
    const pane = byId('detailPane');
    const headerEl = byId('detailHeader');
    const messagesEl = byId('detailMessages');
    prepareDetailPane(pane, messagesEl);
    const detail = await getDetailWithCache(sessionId);
    if (!detail) {
        actions.showToast(t('toastError'));
        return;
    }
    renderDetailHeader(sessionId, detail, headerEl);
    renderDetailFooter(sessionId);
    renderDetailMessages(detail, messagesEl);
}
initResizeHandle(byId);
// --- Init ---
const searchClearBtn = byId('searchClearBtn');
byId('search').addEventListener('input', () => {
    fullTextSearch.onSearchInput();
    searchClearBtn.style.display = byId('search').value ? 'flex' : 'none';
});
searchClearBtn.addEventListener('click', () => {
    byId('search').value = '';
    searchClearBtn.style.display = 'none';
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
    if (result && !result.ok)
        actions.showToast(t('toastError') + (result.error || ''));
    else
        setTimeout(() => fetchSessions(byId('showArchived').checked), 2000);
});
// Native menu events are emitted by Tauri and reflected into in-app state.
if (isTauri && tauriWindow.event) {
    const { listen } = tauriWindow.event;
    listen('menu-theme', (e) => {
        themePref = e.payload;
        localStorage.setItem('csm-theme', themePref);
        applyTheme(themePref);
    });
    listen('menu-terminal', (e) => {
        serverSettings.terminalApp = e.payload;
        invoke('update_settings', { terminalApp: e.payload });
    });
    listen('menu-lang', (e) => {
        lang = e.payload;
        localStorage.setItem('csm-lang', lang);
        applyI18n();
        requestRenderSessions();
    });
    listen('search-index-ready', () => {
        fullTextSearch.setIndexReady(true);
        const indicator = byIdOptional('searchIndexIndicator');
        if (indicator)
            indicator.remove();
    });
    // Check if index was already built before listener was registered
    invoke('get_search_index_status').then((status) => {
        if (status && !status.is_indexing) {
            fullTextSearch.setIndexReady(true);
            const indicator = byIdOptional('searchIndexIndicator');
            if (indicator)
                indicator.remove();
        }
    }).catch(() => { });
    listen('menu-show-archived', (e) => {
        byId('showArchived').checked = e.payload;
        fetchSessions(e.payload);
    });
    listen('menu-zoom', (e) => {
        if (e.payload === 'in') {
            zoomLevel = Math.min(200, zoomLevel + 10);
        }
        else if (e.payload === 'out') {
            zoomLevel = Math.max(60, zoomLevel - 10);
        }
        else {
            zoomLevel = 100;
        }
        localStorage.setItem('csm-zoom', String(zoomLevel));
        applyZoom();
    });
}
// --- Zoom ---
let zoomLevel = parseFloat(localStorage.getItem('csm-zoom') || '100');
function applyZoom() {
    byId('detailPane').style.zoom = String(zoomLevel / 100);
}
initKeyboardNavigation({
    byId,
    getSelectedSession: () => selectedSession,
});
applyTheme(themePref);
applyI18n();
initPreview();
applyZoom();
function focusInputAndSelect(el) {
    if (!el)
        return;
    el.focus();
    el.select();
}
function clearGlobalSearch() {
    const search = byId('search');
    const clearBtn = byId('searchClearBtn');
    if (!search.value)
        return;
    search.value = '';
    clearBtn.style.display = 'none';
    fullTextSearch.onSearchInput();
}
function clearChatSearch() {
    const chatInput = byIdOptional('chatSearch');
    if (!chatInput || !chatInput.value)
        return;
    chatInput.value = '';
    chatSearch.doSearch();
}
document.addEventListener('keydown', (e) => {
    const active = document.activeElement;
    const activeTag = active?.tagName;
    const activeIsTextInput = activeTag === 'INPUT' || activeTag === 'TEXTAREA';
    const chatInput = byIdOptional('chatSearch');
    const globalSearch = byId('search');
    if (e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        focusInputAndSelect(globalSearch);
        return;
    }
    if (e.metaKey && !e.shiftKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        focusInputAndSelect(selectedSession && chatInput ? chatInput : globalSearch);
        return;
    }
    if (e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        focusInputAndSelect(globalSearch);
        return;
    }
    if (e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'g') {
        if (!chatInput)
            return;
        e.preventDefault();
        if (e.shiftKey)
            chatSearch.prev();
        else
            chatSearch.next();
        return;
    }
    if (e.key === 'Escape' && activeIsTextInput) {
        if (active === chatInput) {
            clearChatSearch();
            active.blur();
            return;
        }
        if (active === globalSearch) {
            clearGlobalSearch();
            active.blur();
            return;
        }
    }
    isPreviewHotkeyPressed = e.altKey && e.shiftKey;
});
document.addEventListener('keyup', (e) => {
    if (e.key === 'Alt' || e.key === 'Shift') {
        isPreviewHotkeyPressed = e.altKey && e.shiftKey;
        if (!isPreviewHotkeyPressed && !isDetailPaneVisible())
            hidePreview();
    }
    else if (!e.altKey || !e.shiftKey) {
        isPreviewHotkeyPressed = false;
        if (!isDetailPaneVisible())
            hidePreview();
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
    updateLastUpdateBar();
    // Show startup project cards when no session is selected
    showStartupView();
});
// Auto-refresh every 30s to detect updated sessions
function updateLastUpdateBar() {
    const bar = byIdOptional('lastUpdateBar');
    if (bar) {
        const now = new Date();
        const ts = now.toLocaleTimeString(lang === 'ja' ? 'ja-JP' : 'en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        bar.textContent = `${sessions.length} sessions · ${ts}`;
    }
}
setInterval(async () => {
    const oldSessions = sessions.slice();
    let nextSessions;
    try {
        nextSessions = await invokeStrict('list_sessions', { includeArchived: byId('showArchived').checked });
    }
    catch (error) {
        console.warn('[poll] auto-refresh failed', error);
        return;
    }
    const added = nextSessions.filter(s => !oldSessions.find(o => o.sessionId === s.sessionId));
    const removed = oldSessions.filter(s => !nextSessions.find(o => o.sessionId === s.sessionId));
    const changed = nextSessions.filter(s => {
        const old = oldSessions.find(o => o.sessionId === s.sessionId);
        return old && old.lastTimestamp !== s.lastTimestamp;
    });
    const hasDataChange = added.length > 0 || removed.length > 0 || changed.length > 0;
    if (hasDataChange) {
        console.log(`[poll] data changed: +${added.length} -${removed.length} ~${changed.length} (total ${nextSessions.length})`);
    }
    sessions = nextSessions;
    if (isFirstLoad) {
        sessions.forEach(s => { knownTimestamps[s.sessionId] = s.lastTimestamp; });
        isFirstLoad = false;
    }
    updateLastUpdateBar();
    const searchActive = fullTextSearch.isSearchActive();
    if (searchActive) {
        if (hasDataChange) {
            console.log('[poll] search active — re-running search with updated data');
            fullTextSearch.onSearchInput();
        }
    }
    else {
        const identityChanged = hasSessionIdentityOrderChanged(oldSessions, nextSessions, SEVEN_DAYS);
        if (identityChanged) {
            console.log('[poll] identity/order changed — full render');
            requestRenderSessions();
        }
        else {
            const patched = patchSessionListItems({
                root: byId('sessionList'),
                sessions: nextSessions,
                selectedIds,
                selectedSession,
                archivedLabel: t('archived'),
                msgSuffix: t('msg'),
                formatTimeAgo: (timestamp) => timeAgo(timestamp, lang, t),
                formatDateTitle: (timestamp) => (timestamp
                    ? new Date(timestamp).toLocaleString(lang === 'ja' ? 'ja-JP' : 'en-US')
                    : ''),
                isUpdatedSession,
            });
            if (!patched) {
                console.log('[poll] patch failed — full render');
                requestRenderSessions();
            }
        }
    }
    // Invalidate preview cache for changed/added sessions
    const updatedIds = changed.map(s => s.sessionId).concat(added.map(s => s.sessionId));
    if (updatedIds.length > 0) {
        invalidatePreviewCache(updatedIds);
        // Incremental search index update
        invoke('update_search_index', { sessionIds: updatedIds }).catch((error) => {
            console.warn('[poll] incremental index update failed', error);
        });
    }
}, 30000);
