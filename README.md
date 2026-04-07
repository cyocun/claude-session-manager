# Claude Session Manager

Claude Code の会話履歴を一元管理する **Tauri デスクトップアプリ**。複数ディレクトリで実行されたセッションを横断的に閲覧・検索・再開できます。

## Features

- **プロジェクト横断管理** — `~/.claude/` の全セッションをプロジェクトごとに表示
- **全文検索** — Tantivy ベースのセッション横断検索
- **チャット表示** — Markdown / シンタックスハイライト / ツール実行ブロック表示
- **Resume** — Terminal / iTerm2 / Warp / Ghostty / cmux で即再開
- **アーカイブ** — セッション/プロジェクト単位で非表示化
- **テーマ / i18n** — ライト・ダーク・システム / 日本語・English

## Requirements

- Node.js 18+
- Rust (stable)
- Xcode Command Line Tools (macOS)

## Setup

```bash
cd claude-session-manager
npm install
npm run tauri:dev
```

## Build

```bash
npm run tauri:build
```

## Data

読み取り元:
- `~/.claude/history.jsonl`
- `~/.claude/projects/{encoded-path}/{sessionId}.jsonl`

書き込み:
- `~/Library/Application Support/com.cyocun.claude-session-manager/archive.json`
- `~/Library/Application Support/com.cyocun.claude-session-manager/settings.json`
- `~/Library/Application Support/com.cyocun.claude-session-manager/search-index/`

## Stack

- **Desktop**: Tauri v2 (Rust)
- **Frontend**: Single-page HTML + vanilla JavaScript

## License

Private
