export function normalizeSearchQuery(query: string): string {
  return query
    .replace(/[+\-=&|><!(){}[\]^"~*?:\\/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function getSearchVariants(query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const normalized = normalizeSearchQuery(trimmed);
  if (!normalized || normalized === trimmed) return [trimmed];
  return [trimmed, normalized];
}

export function getSearchTokenFallback(query: string): string[] {
  const normalized = normalizeSearchQuery(query);
  if (!normalized) return [];
  return Array.from(new Set(normalized.split(' ').filter(Boolean)));
}

export function sanitizeSnippet(raw: string): string {
  const sanitized = DOMPurify.sanitize(raw, { ALLOWED_TAGS: ['b'] })
    .replace(/<b>/g, '<mark style="background:var(--hit-bg);color:inherit;border-radius:2px;padding:0 1px;">')
    .replace(/<\/b>/g, '</mark>');
  return DOMPurify.sanitize(sanitized, { ALLOWED_TAGS: ['mark'], ALLOWED_ATTR: ['style'] });
}

export function isVisibleTextNode(node: Text): boolean {
  let el: HTMLElement | null = node.parentElement;
  while (el) {
    const tag = el.tagName;
    if (tag === 'IMG' || tag === 'VIDEO' || tag === 'AUDIO' || tag === 'SOURCE') return false;
    if (el.style.display === 'none' || el.style.visibility === 'hidden') return false;
    if (el.style.height === '0' || el.style.height === '0px') return false;
    if (el.offsetHeight === 0 && el.offsetWidth === 0) return false;
    if (el.classList.contains('md-content')) break;
    el = el.parentElement;
  }
  return true;
}

export function filterRootsContainingAllTokens(roots: HTMLElement[], tokens: string[]): HTMLElement[] {
  if (tokens.length <= 1) return roots;
  const lowerTokens = tokens.map((t) => t.toLocaleLowerCase());
  return roots.filter((root) => {
    const text = (root.textContent || '').toLocaleLowerCase();
    return lowerTokens.every((token) => text.includes(token));
  });
}
