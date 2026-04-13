# Claude Session Manager

Claude Code のローカル履歴 (`~/.claude`) を横断的に閲覧・検索・再開できる macOS デスクトップアプリ。プロジェクトごとに散らばったセッションを一箇所から眺め、過去の会話を掘り起こし、任意のセッションを任意のターミナルで再開できる。

> **ステータス**: 個人用途向けの実験的プロジェクト。macOS (Apple Silicon) のみ動作確認。

---

## ハイライト

- **クロスプロジェクト一覧** — `~/.claude/projects/` 配下を自動スキャンし、最終更新で並び替え
- **全文検索** — Tantivy + lindera (IPAdic) による日本語対応インデックス。フレーズ一致 + Fuzzy/Prefix
- **ツールブロック描画** — `Bash` / `Edit` / `Read` / `Grep` 等のツール呼び出しをブロック単位で見やすく整形（diff ハイライト、言語別シンタックス含む）
- **トークンダッシュボード** — 入出力/キャッシュ別の推移、モデル別コスト、ツール使用頻度、アクティビティ heatmap、ワードクラウドなど
- **ターミナル再開** — Terminal.app / iTerm / Warp / Ghostty / cmux から選んで `claude --resume` を起動
- **プロジェクト統計** — サイドバーからプロジェクト単位で直近セッションを一覧、Finder / ターミナルでのディレクトリオープン
- **自動アップデート** — GitHub Releases 経由、起動時に確認

---

## インストール

### DMG から（推奨）

1. [Releases](https://github.com/cyocun/claude-session-manager/releases/latest) から `Claude.Sessions_*_aarch64.dmg` をダウンロード
2. DMG を開いて Applications にドラッグ
3. 初回起動時は未ノータライズのため「開発元を確認できません」と出る → **右クリック → 開く** で突破

### ソースから

前提: Node.js 18+, Rust stable, Xcode Command Line Tools。

```bash
git clone https://github.com/cyocun/claude-session-manager.git
cd claude-session-manager
npm install
npm run tauri:build
```

ビルド成果物:

- `src-tauri/target/release/bundle/macos/Claude Sessions.app`
- `src-tauri/target/release/bundle/dmg/Claude Sessions_*.dmg`

---

## 使い方

起動するとサイドバーに直近セッションが並ぶ。

- **セッションをクリック** — 右カラムに会話詳細を表示
- **⌘F** — チャット内検索（現在セッション）
- **⌘⇧F** — 全文検索（全セッション横断）
- **⌘↵** — 選択中のセッションを設定済みターミナルで resume
- **⌘N** — プロジェクトルートから新規セッション開始
- **⌘⌫** — 選択中セッションをアーカイブ（トーストから undo 可）
- **⌘,** — 設定（テーマ / 言語 / ターミナル選択）

起動時の「最近のプロジェクト」カードから直接新規セッションを開いたり、トークンダッシュボードを開いたりできる。

---

## 自動アップデート

アプリ起動 5 秒後と 6 時間ごとにバックグラウンドで新バージョンの有無をチェックする。新しいバージョンが見つかると確認ダイアログが出て、承認するとダウンロード → 署名検証 → 再起動で差し替わる。

---

## アーキテクチャ

```
claude-session-manager/
├── src-tauri/            # Tauri (Rust) アプリケーション層
│   ├── src/
│   │   ├── commands/     # ドメイン別 #[tauri::command] ハンドラ
│   │   ├── menu.rs       # メニューバー
│   │   └── tray.rs       # ステータスアイコン
│   └── tauri.conf.json
├── crates/
│   ├── csm-core/         # Tauri に依存しないコア (検索 / セッション解析)
│   └── csm-mcp/          # MCP サーバー（別途外部バイナリとしてバンドル）
└── frontend/             # 素の TypeScript + HTML + CSS（バンドラなし）
    ├── ts/               # ソース。`tsc` で `js/` に出力
    ├── js/               # 生成物（コミット対象）
    ├── styles/
    └── index.html
```

設計方針:

- フロントエンドに Vite / Nuxt のようなフレームワークを載せない。現状の規模では不要で、レンダリング問題の本質はフレームワークでは解決しない
- Web Components も導入しない。Shadow DOM の恩恵より書き味のコストが勝る
- 検索は Rust 側の tantivy + lindera。Web/JS 側ではやらない

### データパス

| 種別 | パス |
|---|---|
| 読み込み | `~/.claude/history.jsonl`, `~/.claude/projects/**/{sessionId}.jsonl` |
| 書き込み | `~/Library/Application Support/com.cyocun.claude-session-manager/archive.json` |
| 設定 | `~/Library/Application Support/com.cyocun.claude-session-manager/settings.json` |
| 検索 index | `~/Library/Application Support/com.cyocun.claude-session-manager/search-index/` |

クラウド同期は一切行わない。アプリが外部通信するのは **アップデート確認のみ**。

---

## 開発

```bash
# 依存インストール
npm install

# 開発起動（Tauri dev モード）
npm run tauri:dev

# フロントエンド型チェック
npm run check:types

# フロントエンドのみビルド
npm run build:frontend

# Rust テスト
cd src-tauri && cargo test
```

フロントエンドの TS を書き換えたら `npm run build:frontend` を走らせる（または `npm run tauri:dev` が裏で行う）。生成物 `frontend/js/**` は Git 管理下なのでコミットに含める。

## リリース

1. `src-tauri/Cargo.toml` と `src-tauri/tauri.conf.json` の `version` を揃えて bump
2. `git commit -am "Bump version to X.Y.Z"`
3. `git tag vX.Y.Z && git push --follow-tags`
4. `.github/workflows/release.yml` が macOS arm64 ビルド・署名・GitHub Releases への公開を自動化（8〜10 分）

詳細な仕組みは [`CLAUDE.md`](CLAUDE.md) を参照。

## ライセンス

Private (個人プロジェクト)
