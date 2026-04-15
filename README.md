# Claude Session Manager

**🇬🇧 English** | [🇯🇵 日本語](./README.ja.md) | [🇨🇳 简体中文](./README.zh-CN.md)

![status](https://img.shields.io/badge/status-private%20%2F%20WIP-orange)
![platform](https://img.shields.io/badge/platform-macOS%20(Apple%20Silicon)-lightgrey)
![license](https://img.shields.io/badge/license-Private-red)

A native macOS desktop app for browsing, searching, and resuming your local Claude Code history (`~/.claude`). Sessions scattered across dozens of projects become one unified, searchable, shippable surface.

> **Status** — Private, experimental project under active development. macOS on Apple Silicon only. No public support, no stability guarantees.

---

## Why this exists

The Claude Code CLI stores every conversation locally, but gives you no real way to search across them. Once you have hundreds of sessions, the history becomes write-only. This app treats that history as a first-class, queryable archive:

- **Hybrid search that actually works on real history** — lexical (BM25) and semantic (vector) results fused with Reciprocal Rank Fusion, tuned for noisy chat logs
- **Japanese-first tokenization** — lindera + IPAdic, with phrase-slop matching so particles and compound words do not wreck recall
- **Local-only by design** — conversations never leave your machine; the only outbound traffic is update checks
- **Cost transparency** — input / output / cache token trends and per-model USD estimates, per project or per session
- **Structured tool-call rendering** — `Bash`, `Edit`, `Read`, `Grep` and friends displayed as blocks with diff highlighting and language-aware syntax, rather than a wall of JSON

## Differentiation

| | Official Claude Code CLI | Generic session viewers | **Claude Session Manager** |
|---|---|---|---|
| Cross-project browsing | Manual | Partial | Auto-scan, sorted by recency |
| Full-text search | None | substring only | Tantivy BM25 with phrase slop |
| Semantic search | None | None | Multilingual-E5-Large + RRF fusion |
| Japanese tokenization | None | None | lindera IPAdic |
| Tool-call rendering | Raw text | Raw text | Structured blocks + diff + syntax |
| Token / cost analytics | None | None | Full dashboard (trends, heatmaps, word clouds) |
| Terminal resume | CLI only | — | Launches Terminal / iTerm / Warp / Ghostty / cmux |
| Privacy | Local | Varies | Local-only; outbound = update check |
| Auto-update | Manual | Varies | Signed GitHub Releases, background check |

---

## Features

### Browse

- Cross-project session list, sorted by last update
- Detail view with per-message rendering and structured tool blocks
- Project stats in the sidebar (recent sessions, totals, last update)
- Archive with undo-from-toast

### Search

- **Full-text (BM25)** via Tantivy + lindera (IPAdic) — phrase match, fuzzy, prefix, slop-tolerant for particles
- **Semantic (vector)** via Multilingual-E5-Large embeddings, chunked per user turn
- **Hybrid** — BM25 and vector results fused with Reciprocal Rank Fusion (K=60); each hit is tagged with which source surfaced it
- Filters: time range, message type, sort by relevance / newest / oldest
- In-session chat search (`⌘F`) and cross-session full-text search (`⌘⇧F`)

### Analytics

- Input / output / cache token trends across hour / day / week / month
- Per-model cost estimates (USD)
- Tool usage ranking
- Activity heatmap
- Word cloud over frequent terms

### Terminal integration

- One-key resume (`⌘↵`) into Terminal.app / iTerm / Warp / Ghostty / cmux
- `claude --resume` generated and dispatched natively
- New session from project root (`⌘N`)

### System

- Auto-update via signed GitHub Releases (checked on launch and every 6 hours)
- Theme selection (system / light / dark)
- Native macOS behaviors: menu bar, tray, `⌘Tab`, always-on-top

---

## Install

### From DMG (recommended)

1. Download `Claude.Sessions_*_aarch64.dmg` from [Releases](https://github.com/cyocun/claude-session-manager/releases/latest)
2. Open the DMG and drag the app to Applications
3. First launch is unnotarized — right-click → **Open** to bypass Gatekeeper

### From source

Requires Node.js 18+, Rust stable, Xcode Command Line Tools.

```bash
git clone https://github.com/cyocun/claude-session-manager.git
cd claude-session-manager
npm install
npm run tauri:build
```

Build artifacts:

- `src-tauri/target/release/bundle/macos/Claude Sessions.app`
- `src-tauri/target/release/bundle/dmg/Claude Sessions_*.dmg`

---

## Keybindings

| Shortcut | Action |
|---|---|
| `⌘F` | Search within current session |
| `⌘⇧F` | Cross-session full-text search |
| `⌘↵` | Resume selected session in configured terminal |
| `⌘N` | New session from project root |
| `⌘⌫` | Archive selected session (undo from toast) |
| `⌘,` | Settings (theme / language / terminal) |

---

## Architecture

```
claude-session-manager/
├── src-tauri/            # Tauri (Rust) application layer
│   ├── src/commands/     # domain-split #[tauri::command] handlers
│   └── tauri.conf.json
├── crates/
│   ├── csm-core/         # Tauri-independent core (search / sessions / embedding)
│   └── csm-mcp/          # MCP server, bundled as a separate binary
└── frontend/             # plain TypeScript + HTML + CSS, no bundler
    ├── ts/               # source, compiled to js/ via tsc
    ├── js/               # generated output, checked in
    └── index.html
```

**Design principles**

- No frontend framework (Vite / Nuxt / React). At this scale they buy nothing, and rendering problems are not framework problems.
- No Web Components. Shadow DOM costs more than it returns here.
- Search stays on the Rust side (Tantivy + lindera). The browser is not the right place for it.

### Data paths

| Kind | Path |
|---|---|
| Read | `~/.claude/history.jsonl`, `~/.claude/projects/**/{sessionId}.jsonl` |
| Write | `~/Library/Application Support/com.cyocun.claude-session-manager/archive.json` |
| Settings | `~/Library/Application Support/com.cyocun.claude-session-manager/settings.json` |
| Search index | `~/Library/Application Support/com.cyocun.claude-session-manager/search-index/` |

No cloud sync. The only outbound traffic is the update check.

---

## Development

```bash
npm install
npm run tauri:dev          # launch in Tauri dev mode
npm run check:types        # frontend type-check
npm run build:frontend     # compile TS → JS only
cd src-tauri && cargo test # Rust tests
```

Rebuild the frontend (`npm run build:frontend`) whenever you touch TypeScript. The generated `frontend/js/**` is tracked in git and must be committed.

## Release

1. Bump `version` in both `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`
2. `git commit -am "Bump version to X.Y.Z"`
3. `git tag vX.Y.Z && git push --follow-tags`
4. `.github/workflows/release.yml` builds, signs, and publishes the macOS arm64 bundle (~8–10 min)

See [`CLAUDE.md`](CLAUDE.md) for the full contributor notes.

## License

Private (personal project). Not open for public use or redistribution.
