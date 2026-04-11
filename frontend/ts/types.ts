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
};

export type SearchMode = 'fulltext' | 'similar';
