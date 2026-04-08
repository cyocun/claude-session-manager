export function normalizeSearchQuery(query) {
    return query
        .replace(/[+\-=&|><!(){}[\]^"~*?:\\/]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
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
