// Phase 4: local-only search telemetry.
//
// Goal: collect enough signal on real-world search failures to decide whether
// Phase 5 (semantic search) is worth the complexity. All data stays in
// localStorage — nothing is sent anywhere, and the feature is opt-in.
//
// Events logged:
// - `search`: a backend query completed. Captures the query verbatim, applied
//   filters, result count, and wall-clock duration.
// - `open_result`: user opened a result (Enter/double-click). Paired with a
//   prior `search` event via `queryId`, records the 0-indexed position.
// - `escape_no_open`: search was dismissed (Esc / clear) without any result
//   being opened first. Treated as an implicit failure signal.
// - `cleared_input`: user cleared the query manually; subset of
//   `escape_no_open` but useful for distinguishing intent.
//
// The log is a ring buffer capped at MAX_EVENTS; older events drop off. The
// user can export to JSON for analysis (saved as text via clipboard), clear
// the log, or toggle logging off entirely.

import type { SearchFilterPayload } from './fullTextSearch.js';

const LOG_KEY = 'csm-search-log';
const ENABLED_KEY = 'csm-search-log-enabled';
const MAX_EVENTS = 500;

export type TelemetryEvent =
  | {
      type: 'search';
      queryId: string;
      query: string;
      mode: string;
      filters: SearchFilterPayload;
      resultCount: number;
      durationMs: number;
      indexReady: boolean;
      timestamp: number;
    }
  | {
      type: 'open_result';
      queryId: string;
      position: number;
      msgType: string;
      timestamp: number;
    }
  | {
      type: 'escape_no_open';
      queryId: string;
      timestamp: number;
    }
  | {
      type: 'cleared_input';
      queryId: string;
      timestamp: number;
    };

function isEnabled(): boolean {
  return localStorage.getItem(ENABLED_KEY) === 'true';
}

function setEnabled(enabled: boolean): void {
  if (enabled) {
    localStorage.setItem(ENABLED_KEY, 'true');
  } else {
    localStorage.removeItem(ENABLED_KEY);
  }
}

function loadLog(): TelemetryEvent[] {
  try {
    const raw = localStorage.getItem(LOG_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TelemetryEvent[]) : [];
  } catch {
    return [];
  }
}

function saveLog(events: TelemetryEvent[]): void {
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(events));
  } catch {
    // Quota exceeded — drop the oldest half and retry once.
    try {
      const trimmed = events.slice(Math.floor(events.length / 2));
      localStorage.setItem(LOG_KEY, JSON.stringify(trimmed));
    } catch {
      // Give up silently — telemetry is best-effort.
    }
  }
}

function append(event: TelemetryEvent): void {
  if (!isEnabled()) return;
  const events = loadLog();
  events.push(event);
  if (events.length > MAX_EVENTS) {
    events.splice(0, events.length - MAX_EVENTS);
  }
  saveLog(events);
}

function clear(): void {
  localStorage.removeItem(LOG_KEY);
}

function snapshot(): TelemetryEvent[] {
  return loadLog();
}

// Summary stats helper — used by the telemetry popover to show a quick
// at-a-glance health number without the user having to export the log.
function summarize(): {
  totalSearches: number;
  zeroHitRate: number;
  openRate: number;
  avgDurationMs: number;
} {
  const events = loadLog();
  const searches = events.filter((e) => e.type === 'search') as Extract<
    TelemetryEvent,
    { type: 'search' }
  >[];
  if (searches.length === 0) {
    return { totalSearches: 0, zeroHitRate: 0, openRate: 0, avgDurationMs: 0 };
  }
  const zeroHits = searches.filter((e) => e.resultCount === 0).length;
  const opensByQuery = new Set(
    events.filter((e) => e.type === 'open_result').map((e) => e.queryId),
  );
  const opens = searches.filter((s) => opensByQuery.has(s.queryId)).length;
  const avgDurationMs = searches.reduce((sum, e) => sum + e.durationMs, 0) / searches.length;
  return {
    totalSearches: searches.length,
    zeroHitRate: zeroHits / searches.length,
    openRate: opens / searches.length,
    avgDurationMs,
  };
}

// Generate a monotonic ID for correlating search -> open/escape events.
// Prefer randomUUID when available; fall back to a timestamp-based hash so
// older webviews don't break.
function newQueryId(): string {
  try {
    const cryptoObj = (globalThis as unknown as { crypto?: { randomUUID?: () => string } }).crypto;
    if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  } catch {
    // fall through
  }
  return `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const searchTelemetry = {
  isEnabled,
  setEnabled,
  append,
  clear,
  snapshot,
  summarize,
  newQueryId,
};

export type SearchTelemetry = typeof searchTelemetry;
