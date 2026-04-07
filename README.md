# Claude Session Manager

A desktop app to browse, search, and resume Claude Code sessions across projects.

Claude Session Manager reads your local `~/.claude` history and gives you a fast UI for session discovery, full-text search, and resume workflows.

## Features

- Cross-project session list with grouping and archive support
- Full-text search powered by Tantivy (Rust)
- Chat detail view with Markdown rendering and code highlighting
- Tool block rendering (Bash/Edit/Write/Read/Glob/Grep + results)
- Quick resume actions for Terminal / iTerm2 / Warp / Ghostty / cmux
- Theme support (Light / Dark / System) and language switch (ja / en)

## Platform

- macOS (current primary target)

## Requirements

- Node.js 18+
- npm
- Rust (stable)
- Xcode Command Line Tools

## Quick Start

```bash
npm install
npm run tauri:dev
```

## Build

```bash
npm run tauri:build
```

## Development

```bash
# Type check frontend TS
npm run check:types

# Build frontend assets
npm run build:frontend

# Run Rust tests
cd src-tauri && cargo test
```

## Data Sources

### Read

- `~/.claude/history.jsonl`
- `~/.claude/projects/**/{sessionId}.jsonl`

### Write

- `~/Library/Application Support/com.cyocun.claude-session-manager/archive.json`
- `~/Library/Application Support/com.cyocun.claude-session-manager/settings.json`
- `~/Library/Application Support/com.cyocun.claude-session-manager/search-index/`

## Notes

- This app works on local files only.
- On startup, the app clears WebView cache to avoid stale rendering.

## Tech Stack

- Desktop: Tauri v2 (Rust)
- Frontend: Single-page HTML + TypeScript (compiled to JS)

## License

Private
