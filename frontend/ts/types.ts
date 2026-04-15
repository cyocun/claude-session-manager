export type SessionSummary = {
  sessionId: string;
  project: string;
  firstDisplay: string;
  lastDisplay?: string;
  lastTimestamp: number;
  messageCount: number;
  archived?: boolean;
};

export type ProjectInfo = {
  path: string;
  name?: string;
  lastSessionId?: string;
  sessionCount?: number;
  lastTimestamp?: number;
};

export type ProjectGroup = { path: string; sessions: SessionSummary[] };

export type ToolEntry = {
  id: string;
  name: string;
  output?: string;
};

export type DetailMessage = {
  type: string;
  content?: string;
  timestamp?: string | number | null;
  tools?: ToolEntry[];
  images?: Array<{ sourceType: string; mediaType: string; data: string }>;
};

export type SessionDetail = {
  project: string;
  messages: DetailMessage[];
};

export type ServerSettings = {
  terminalApp?: string;
  [key: string]: unknown;
};

export type SearchHit = {
  project: string;
  sessionId: string;
  msgType: string;
  snippet: string;
  messageIndex: number;
  timestamp?: number;
  score?: number;
  // Phase 2: 1-message context above/below the hit, returned by the backend
  // so the result row can show surrounding text without an extra round-trip.
  contextBefore?: string;
  contextAfter?: string;
};

export type SearchMode = 'fulltext' | 'similar';

// Optional filter/sort params accepted by the search_sessions Tauri command.
// Wired by Phase 3 UI; Phase 2 just makes the API surface available.
export type SearchTimeRange = {
  from?: number;
  to?: number;
};

export type SearchSort = 'relevance' | 'newest' | 'oldest' | 'relevance_recent';
