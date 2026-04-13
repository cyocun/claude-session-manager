export function normalizeSearchQuery(query) {
    return query
        .replace(/[+\-=&|><!(){}[\]^"~*?:\\/]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
const PROJECT_FILTER_RE = /(?:^|\s)project:(?:"([^"]*)"|(\S+))/;
export function parseSearchQuery(input) {
    const m = input.match(PROJECT_FILTER_RE);
    if (!m)
        return { project: null, query: input };
    const project = (m[1] ?? m[2] ?? '').trim() || null;
    const rest = input.replace(PROJECT_FILTER_RE, ' ').replace(/\s+/g, ' ').trim();
    return { project, query: rest };
}
export function getSearchVariants(query) {
    const trimmed = query.trim();
    if (!trimmed)
        return [];
    const normalized = normalizeSearchQuery(trimmed);
    if (!normalized || normalized === trimmed)
        return [trimmed];
    return [trimmed, normalized];
}
export function getSearchTokenFallback(query) {
    const normalized = normalizeSearchQuery(query);
    if (!normalized)
        return [];
    return Array.from(new Set(normalized.split(' ').filter(Boolean)));
}
export function sanitizeSnippet(raw) {
    const sanitized = DOMPurify.sanitize(raw, { ALLOWED_TAGS: ['b'] })
        .replace(/<b>/g, '<mark style="background:var(--hit-bg);color:inherit;border-radius:2px;padding:0 1px;">')
        .replace(/<\/b>/g, '</mark>');
    return DOMPurify.sanitize(sanitized, { ALLOWED_TAGS: ['mark'], ALLOWED_ATTR: ['style'] });
}
export function isVisibleTextNode(node) {
    let el = node.parentElement;
    while (el) {
        const tag = el.tagName;
        if (tag === 'IMG' || tag === 'VIDEO' || tag === 'AUDIO' || tag === 'SOURCE')
            return false;
        if (el.style.display === 'none' || el.style.visibility === 'hidden')
            return false;
        if (el.style.height === '0' || el.style.height === '0px')
            return false;
        if (el.offsetHeight === 0 && el.offsetWidth === 0)
            return false;
        if (el.classList.contains('md-content'))
            break;
        el = el.parentElement;
    }
    return true;
}
export function filterRootsContainingAllTokens(roots, tokens) {
    if (tokens.length <= 1)
        return roots;
    const lowerTokens = tokens.map((t) => t.toLocaleLowerCase());
    return roots.filter((root) => {
        const text = (root.textContent || '').toLocaleLowerCase();
        return lowerTokens.every((token) => text.includes(token));
    });
}
