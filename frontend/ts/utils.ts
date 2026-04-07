export function shortPath(p: string): string {
  return p.replace(/^\/Users\/[^/]+\//, '~/').replace(/^~\/Dropbox\/__WORKS\//, '');
}

export function shortPathElements(p: string): [string | null, string] {
  const short = shortPath(p);
  const lastSlash = short.lastIndexOf('/');
  if (lastSlash === -1) return [null, short];
  return [short.slice(0, lastSlash + 1), short.slice(lastSlash + 1)];
}

export function isRemoteHost(hostname: string): boolean {
  return hostname !== 'localhost' && hostname !== '127.0.0.1';
}

export function timeAgo(ts: number | null | undefined, lang: string, t: (key: string) => string): string {
  if (!ts) return '';
  const now = new Date();
  const date = new Date(ts);
  const locale = lang === 'ja' ? 'ja-JP' : 'en-US';
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86400000;
  const daysSinceMonday = (now.getDay() + 6) % 7;
  const startOfWeek = startOfToday - daysSinceMonday * 86400000;

  if (ts >= startOfToday) return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  if (ts >= startOfYesterday) return t('yesterday');
  if (ts >= startOfWeek) return date.toLocaleDateString(locale, { weekday: lang === 'ja' ? 'short' : 'long' });
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString(locale, { month: lang === 'ja' ? 'numeric' : 'short', day: 'numeric' });
  }
  return date.toLocaleDateString(locale, {
    year: 'numeric',
    month: lang === 'ja' ? 'numeric' : 'short',
    day: 'numeric',
  });
}
