# Claude Session Manager

Claude Code の会話履歴を一元管理する Web UI。複数ディレクトリで実行されたセッションを横断的に閲覧・検索・再開できる。

## Features

- **プロジェクト横断管理** — `~/.claude/` の全セッションをプロジェクト(ディレクトリ)ごとにグループ表示
- **プロジェクト名自動解決** — `package.json`, git remote, `pyproject.toml` からプロジェクト名を取得
- **iMessage風チャットUI** — 会話をバブル表示、Markdown描画、シンタックスハイライト対応
- **ツール呼び出し詳細** — Bash/Edit/Read/Grep等のツール実行とその結果をアコーディオン表示
- **diff表示** — Edit操作を diff2html で side-by-side 差分表示
- **会話内検索** — ハイライト + 前後ジャンプ (Enter / Shift+Enter)
- **Resume** — ボタンクリックでターミナルアプリ (Terminal.app / iTerm2 / Warp / Ghostty / tmux) から直接再開。既に実行中のセッションがあればそのウィンドウをアクティブ化
- **アーカイブ** — セッション/プロジェクト単位でアーカイブ (GUI上非表示)
- **テーマ** — ライト / ダーク / システム追従
- **i18n** — 日本語 / English
- **リモートアクセス** — `0.0.0.0` でリッスン、Tailscale等経由で外部からアクセス可
- **更新検知** — 30秒ごとに自動リフレッシュ、更新されたセッションを青ドット+ハイライト
- **プレビュー** — セッションにホバーで直近のやりとりをポップオーバー表示
- **リサイズ** — セッション一覧と詳細パネルの幅をドラッグで調整

## Requirements

- Python 3.10+
- [FastAPI](https://fastapi.tiangolo.com/) + [Uvicorn](https://www.uvicorn.org/)

## Setup

```bash
cd claude-session-manager
pip install -r requirements.txt
python server.py
```

http://localhost:5533 でアクセス。

## Remote Access (Tailscale)

Tailscale が導入済みの環境であれば、他のマシンから `http://<tailscale-ip>:5533` でアクセス可能。VPN内で完結するため追加の認証は不要。

## Data

読み取り元:
- `~/.claude/history.jsonl` — セッションインデックス
- `~/.claude/projects/{encoded-path}/{sessionId}.jsonl` — 各セッションの全メッセージ

書き込み:
- `archive.json` — アーカイブ済みセッションID一覧
- `settings.json` — ターミナルアプリ設定等

Claude Code の会話データには一切書き込みを行わない (read-only)。

## Stack

- **Backend**: Python / FastAPI
- **Frontend**: 単一 HTML ファイル (Tailwind CSS CDN, markdown-it, DOMPurify, highlight.js, diff2html, jsdiff)

## License

Private
