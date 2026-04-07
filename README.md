# Claude Session Manager

Claude Session Manager is a macOS desktop app for browsing, searching, and resuming Claude Code sessions across projects, based on local `~/.claude` history.

## Main features

- Cross-project session list with archive support
- Full-text search (Tantivy index)
- Similar issue search and context preview
- Session detail view with Markdown/code highlighting and tool block rendering
- Resume workflow (Terminal / iTerm / Warp / Ghostty / cmux)
- Token dashboard
  - totals (input/output/cache/estimated cost)
  - trends by **hour/day/week/month**
  - comparison by project and recent sessions
  - local usage limits
- Project summary and decision-history view
- Theme (Light/Dark/System) and language (ja/en)

## Platform

- macOS (primary target)

## Requirements

- Node.js 18+
- npm
- Rust (stable)
- Xcode Command Line Tools

## Setup

```bash
npm install
```

## Run (development)

```bash
npm run tauri:dev
```

## Build

```bash
npm run tauri:build
```

Build artifacts are generated under:

- `src-tauri/target/release/bundle/macos/Claude Sessions.app`
- `src-tauri/target/release/bundle/dmg/Claude Sessions_*.dmg`

## Useful commands

```bash
# Frontend type check
npm run check:types

# Frontend build
npm run build:frontend

# Rust tests
cd src-tauri && cargo test
```

## Data access

### Reads

- `~/.claude/history.jsonl`
- `~/.claude/projects/**/{sessionId}.jsonl`

### Writes

- `~/Library/Application Support/com.cyocun.claude-session-manager/archive.json`
- `~/Library/Application Support/com.cyocun.claude-session-manager/settings.json`
- `~/Library/Application Support/com.cyocun.claude-session-manager/search-index/`

## Notes

- Local files only (no cloud sync).
- Clipboard copy actions are handled via Tauri native clipboard.
- On startup, WebView cache is cleared to avoid stale UI rendering.

## Stack

- Tauri v2 (Rust)
- TypeScript + plain HTML/CSS frontend

## License

Private
