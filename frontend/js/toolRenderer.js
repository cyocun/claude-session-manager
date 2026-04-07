const TOOL_ICONS = {
    Bash: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="2" width="13" height="12" rx="2"/><path d="M4.5 6l2.5 2-2.5 2"/><path d="M8.5 10h3"/></svg>',
    Edit: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M11 2.5l2.5 2.5L5.5 13H3v-2.5L11 2.5z"/></svg>',
    Write: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2H4.5A1.5 1.5 0 003 3.5v9A1.5 1.5 0 004.5 14h7a1.5 1.5 0 001.5-1.5V7"/><path d="M12 2v4h-4"/><path d="M12 2L8 6"/></svg>',
    Read: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2H4.5A1.5 1.5 0 003 3.5v9A1.5 1.5 0 004.5 14h7a1.5 1.5 0 001.5-1.5V7L9 2z"/><path d="M9 2v5h4"/></svg>',
    Glob: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 2H3.5A1.5 1.5 0 002 3.5v9A1.5 1.5 0 003.5 14h9a1.5 1.5 0 001.5-1.5V6.5L10 2H6.5z"/><path d="M6.5 2v3h-3"/></svg>',
    Grep: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>',
    Agent: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="5.5" r="3"/><path d="M2.5 14c0-3 2.5-5 5.5-5s5.5 2 5.5 5"/></svg>',
    WebSearch: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M2 8h12"/><ellipse cx="8" cy="8" rx="3" ry="6"/></svg>',
    WebFetch: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v7"/><path d="M5 7l3 3 3-3"/><path d="M3 12h10"/></svg>',
};
const TOOL_ICON_DEFAULT = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2L6 6.5l4 3-3.5 4.5"/></svg>';
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
export function renderToolBlocks(tools, externalResultMap, createEl) {
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
                bodyEl = makeHighlightedPre(JSON.stringify(tool.input, null, 2), 'json');
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
            const outputPre = makeHighlightedPre(result.output, 'bash');
            outputPre.className += ' tool-result-output';
            body.appendChild(outputPre);
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
