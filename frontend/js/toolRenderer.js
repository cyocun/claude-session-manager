import { ICONS } from './icons.js';
const TOOL_ICONS = {
    Bash: ICONS.terminal,
    Edit: ICONS.pencil,
    Write: ICONS.filePlus,
    Read: ICONS.fileText,
    Glob: ICONS.files,
    Grep: ICONS.search,
    Agent: ICONS.user,
    WebSearch: ICONS.world,
    WebFetch: ICONS.download,
};
const TOOL_ICON_DEFAULT = ICONS.code;
function toolIcon(name) {
    const span = document.createElement('span');
    span.style.cssText = 'display:inline-flex;align-items:center;flex-shrink:0;color:var(--text-muted);';
    span.innerHTML = TOOL_ICONS[name] || TOOL_ICON_DEFAULT;
    return span;
}
function guessLang(filePath) {
    if (!filePath)
        return null;
    const ext = filePath.split('.').pop()?.toLowerCase();
    if (!ext)
        return null;
    const map = {
        js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
        py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java',
        css: 'css', scss: 'css', html: 'xml', htm: 'xml', vue: 'xml', svelte: 'xml',
        json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini',
        sh: 'bash', zsh: 'bash', bash: 'bash',
        sql: 'sql', md: 'markdown', swift: 'swift', kt: 'kotlin',
    };
    return map[ext] || null;
}
function highlightCode(text, lang) {
    if (lang && hljs.getLanguage(lang)) {
        try {
            return hljs.highlight(text, { language: lang }).value;
        }
        catch { }
    }
    try {
        return hljs.highlightAuto(text).value;
    }
    catch { }
    return null;
}
function makeHighlightedPre(text, lang) {
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.className = 'hljs' + (lang ? ' language-' + lang : '');
    const highlighted = highlightCode(text, lang);
    if (highlighted)
        code.innerHTML = DOMPurify.sanitize(highlighted);
    else
        code.textContent = text;
    pre.appendChild(code);
    return pre;
}
const MARKDOWN_RESULT_TOOLS = new Set([
    'EnterPlanMode', 'ExitPlanMode', 'ExitWorktree', 'EnterWorktree',
    'Agent', 'TaskCreate', 'TaskGet', 'TaskOutput',
]);
function looksLikeMarkdown(text) {
    return /^#{1,6}\s|^\*\*|^- |\n#{1,6}\s|\n- |\n\*\*|```/.test(text);
}
function guessLangFromKey(key) {
    const k = key.toLowerCase();
    if (/(^|_)(function|script|code|js|javascript|expression)($|_)/.test(k))
        return 'javascript';
    if (/(^|_)(ts|typescript)($|_)/.test(k))
        return 'typescript';
    if (/sql|query/.test(k))
        return 'sql';
    if (/html|markup/.test(k))
        return 'xml';
    if (/css|style/.test(k))
        return 'css';
    if (/(^|_)json($|_)/.test(k))
        return 'json';
    if (/bash|shell|cmd|command/.test(k))
        return 'bash';
    if (/(^|_)(yaml|yml)($|_)/.test(k))
        return 'yaml';
    return null;
}
function looksLikeCodeValue(v) {
    return v.includes('\n') || v.length > 160;
}
function makeStructuredInputBody(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return makeHighlightedPre(JSON.stringify(input, null, 2), 'json');
    }
    const obj = input;
    const keys = Object.keys(obj);
    const hasCodeValue = keys.some((k) => typeof obj[k] === 'string' && looksLikeCodeValue(obj[k]));
    if (!hasCodeValue) {
        return makeHighlightedPre(JSON.stringify(input, null, 2), 'json');
    }
    const container = document.createElement('div');
    container.className = 'tool-input-structured';
    for (const key of keys) {
        const value = obj[key];
        const label = document.createElement('div');
        label.className = 'tool-input-key';
        label.textContent = key;
        container.appendChild(label);
        if (typeof value === 'string' && looksLikeCodeValue(value)) {
            container.appendChild(makeHighlightedPre(value, guessLangFromKey(key)));
        }
        else if (typeof value === 'string') {
            container.appendChild(makeHighlightedPre(value, null));
        }
        else {
            container.appendChild(makeHighlightedPre(JSON.stringify(value, null, 2), 'json'));
        }
    }
    return container;
}
// ``` lang\n ... \n``` 内の JSON を pretty-print。marked 側のハイライトは流用する。
function prettyPrintFencedJson(text) {
    return text.replace(/```json\s*\n([\s\S]*?)\n```/g, (match, body) => {
        try {
            return '```json\n' + JSON.stringify(JSON.parse(body), null, 2) + '\n```';
        }
        catch {
            return match;
        }
    });
}
export function renderToolBlocks(tools, externalResultMap, createEl, renderMarkdown) {
    const els = [];
    const resultMap = { ...(externalResultMap || {}) };
    tools.filter((t) => t.name === '_result').forEach((t) => { resultMap[t.id] = t; });
    tools.filter((t) => t.name !== '_result').forEach((tool) => {
        const result = resultMap[tool.id];
        const block = document.createElement('div');
        block.className = 'tool-block';
        let summary = '';
        let bodyEl = null;
        let isDiff = false;
        let diffFile = '';
        let diffOld = '';
        let diffNew = '';
        let lang = null;
        if (tool.name === 'Bash') {
            summary = tool.description || tool.command || '(bash)';
            if (tool.command)
                bodyEl = makeHighlightedPre('$ ' + tool.command, 'bash');
        }
        else if (tool.name === 'Edit') {
            const fname = (tool.file || '').split('/').pop() || '';
            summary = 'Edit ' + fname;
            isDiff = true;
            diffFile = tool.file || fname;
            diffOld = tool.old || '';
            diffNew = tool.new || '';
        }
        else if (tool.name === 'Write') {
            const fname = (tool.file || '').split('/').pop() || '';
            summary = 'Write ' + fname;
            lang = guessLang(tool.file);
            bodyEl = makeHighlightedPre(tool.content || '', lang);
        }
        else if (tool.name === 'Read') {
            const fname = (tool.file || '').split('/').pop() || '';
            summary = 'Read ' + fname;
        }
        else if (tool.name === 'Glob' || tool.name === 'Grep') {
            summary = tool.name + ' ' + (tool.pattern || '');
        }
        else {
            summary = tool.name;
            if (tool.input !== undefined)
                bodyEl = makeStructuredInputBody(tool.input);
        }
        const icon = toolIcon(tool.name);
        const chevron = createEl('span', { className: 'tool-chevron', textContent: '\u25B6' });
        const label = createEl('span', { className: 'tool-label', textContent: tool.name });
        const desc = createEl('span', { className: 'tool-desc', textContent: summary });
        const header = createEl('div', { className: 'tool-header' }, [chevron, icon, label, desc]);
        const body = document.createElement('div');
        body.className = 'tool-body';
        let hasBody = false;
        if (isDiff) {
            const unifiedPatch = Diff.createPatch(diffFile, diffOld, diffNew, '', '', { context: 3 });
            const diffContainer = document.createElement('div');
            const diffHtml = Diff2Html.html(unifiedPatch, {
                drawFileList: false,
                outputFormat: 'side-by-side',
                matching: 'words',
                highlight: true,
            });
            diffContainer.innerHTML = DOMPurify.sanitize(diffHtml);
            body.appendChild(diffContainer);
            hasBody = true;
        }
        else if (bodyEl) {
            body.appendChild(bodyEl);
            hasBody = true;
        }
        if (result && result.output) {
            if (hasBody) {
                const sep = document.createElement('hr');
                sep.style.cssText = 'border:none;border-top:1px solid var(--code-border);margin:4px 0;';
                body.appendChild(sep);
            }
            const useMarkdown = renderMarkdown &&
                (MARKDOWN_RESULT_TOOLS.has(tool.name) || looksLikeMarkdown(result.output));
            if (useMarkdown) {
                const mdDiv = document.createElement('div');
                mdDiv.className = 'md-content tool-result-markdown';
                // renderMarkdown already applies DOMPurify.sanitize() internally
                mdDiv.innerHTML = renderMarkdown(prettyPrintFencedJson(result.output));
                body.appendChild(mdDiv);
            }
            else {
                const outputPre = makeHighlightedPre(result.output, 'bash');
                outputPre.className += ' tool-result-output';
                body.appendChild(outputPre);
            }
            hasBody = true;
        }
        header.addEventListener('click', () => {
            chevron.classList.toggle('open');
            body.classList.toggle('open');
        });
        block.appendChild(header);
        if (hasBody)
            block.appendChild(body);
        els.push(block);
    });
    return els;
}
