# Claude Session Manager

[🇬🇧 English](./README.md) | **🇯🇵 日本語** | [🇨🇳 简体中文](./README.zh-CN.md)

![status](https://img.shields.io/badge/status-private%20%2F%20WIP-orange)
![platform](https://img.shields.io/badge/platform-macOS%20(Apple%20Silicon)-lightgrey)
![license](https://img.shields.io/badge/license-Private-red)

Claude Code のローカル履歴 (`~/.claude`) を横断的に閲覧・検索・再開できる macOS デスクトップアプリ。プロジェクトごとに散らばったセッションを一箇所から眺め、過去の会話を掘り起こし、任意のセッションを任意のターミナルで再開できる。

> **ステータス** — 個人用途向けの実験的プロジェクトで、現在も開発中。macOS (Apple Silicon) のみ動作確認。公開サポートや安定保証はありません。

---

## なぜ作ったか

Claude Code CLI は会話をすべてローカルに残すが、それらを横断的に検索する手段は提供されない。セッションが数百に達した時点で履歴は「書き込み専用」になる。このアプリはその履歴をクエリ可能な第一級アーカイブとして扱う。

- **実履歴で効くハイブリッド検索** — BM25（語彙）とベクトル（意味）を Reciprocal Rank Fusion で融合、ノイズの多いチャットログ向けに調整
- **日本語ファーストのトークン化** — lindera + IPAdic、phrase-slop で助詞や複合語による再現率低下を回避
- **ローカル完結** — 会話はマシンから出ない。外部通信はアップデート確認のみ
- **コストの可視化** — 入力 / 出力 / キャッシュ別のトークン推移とモデル別 USD 推算を、プロジェクト／セッション単位で
- **ツール呼び出しの構造化描画** — `Bash` / `Edit` / `Read` / `Grep` などを JSON の壁ではなく、diff ハイライトと言語別シンタックス付きのブロックとして表示

## 差別化

| | 公式 Claude Code CLI | 一般的なセッションビューア | **Claude Session Manager** |
|---|---|---|---|
| クロスプロジェクト閲覧 | 手動 | 部分的 | 自動スキャン、最終更新順 |
| 全文検索 | なし | 部分文字列のみ | Tantivy BM25 + phrase slop |
| 意味検索 | なし | なし | Multilingual-E5-Large + RRF 融合 |
| 日本語トークン化 | なし | なし | lindera IPAdic |
| ツール呼び出し描画 | 素のテキスト | 素のテキスト | ブロック化 + diff + シンタックス |
| トークン / コスト分析 | なし | なし | フルダッシュボード（推移・heatmap・ワードクラウド） |
| ターミナル再開 | CLI のみ | — | Terminal / iTerm / Warp / Ghostty / cmux を起動 |
| プライバシー | ローカル | 様々 | ローカル完結。外部通信はアップデート確認のみ |
| 自動アップデート | 手動 | 様々 | 署名付き GitHub Releases、バックグラウンド確認 |

---

## 機能

### 閲覧

- クロスプロジェクトのセッション一覧、最終更新順
- メッセージ単位の詳細表示、ツールブロックは構造化描画
- サイドバーのプロジェクト統計（直近セッション、総数、最終更新）
- アーカイブ（トーストから undo 可）

### 検索

- **全文検索 (BM25)** — Tantivy + lindera (IPAdic)、フレーズ一致・Fuzzy・Prefix、助詞吸収の slop 対応
- **意味検索 (Vector)** — Multilingual-E5-Large 埋め込み、ユーザーターン単位で chunk 化
- **ハイブリッド** — BM25 とベクトルを RRF (K=60) で融合、どの経路でヒットしたかをバッジ表示
- フィルタ：時間範囲・メッセージタイプ、ソート：関連度 / 新しい順 / 古い順
- セッション内検索 (`⌘F`) と全文検索 (`⌘⇧F`)

### 分析

- 入力 / 出力 / キャッシュ別のトークン推移（時間・日・週・月）
- モデル別コスト推算 (USD)
- ツール使用頻度ランキング
- アクティビティ heatmap
- 頻出語のワードクラウド

### ターミナル統合

- ワンキー resume (`⌘↵`) で Terminal.app / iTerm / Warp / Ghostty / cmux を起動
- `claude --resume` を自動生成し実行
- プロジェクトルートから新規セッション (`⌘N`)

### システム

- 署名付き GitHub Releases 経由の自動アップデート（起動時 + 6 時間ごと）
- テーマ選択（システム / ライト / ダーク）
- macOS ネイティブ挙動：メニューバー、トレイ、`⌘Tab`、常に最前面

---

## インストール

### DMG から（推奨）

1. [Releases](https://github.com/cyocun/claude-session-manager/releases/latest) から `Claude.Sessions_*_aarch64.dmg` をダウンロード
2. DMG を開いて Applications にドラッグ
3. 初回起動時は未ノータライズのため「開発元を確認できません」と出る → **右クリック → 開く** で突破

### ソースから

前提：Node.js 18+、Rust stable、Xcode Command Line Tools。

```bash
git clone https://github.com/cyocun/claude-session-manager.git
cd claude-session-manager
npm install
npm run tauri:build
```

ビルド成果物：

- `src-tauri/target/release/bundle/macos/Claude Sessions.app`
- `src-tauri/target/release/bundle/dmg/Claude Sessions_*.dmg`

---

## キーバインド

| ショートカット | 動作 |
|---|---|
| `⌘F` | 現在セッション内の検索 |
| `⌘⇧F` | 全セッション横断の全文検索 |
| `⌘↵` | 選択セッションを設定済みターミナルで resume |
| `⌘N` | プロジェクトルートから新規セッション |
| `⌘⌫` | 選択セッションをアーカイブ（トーストから undo 可） |
| `⌘,` | 設定（テーマ / 言語 / ターミナル） |

---

## アーキテクチャ

```
claude-session-manager/
├── src-tauri/            # Tauri (Rust) アプリケーション層
│   ├── src/commands/     # ドメイン別 #[tauri::command] ハンドラ
│   └── tauri.conf.json
├── crates/
│   ├── csm-core/         # Tauri 非依存のコア（検索 / セッション解析 / 埋め込み）
│   └── csm-mcp/          # MCP サーバー、別バイナリとしてバンドル
└── frontend/             # 素の TypeScript + HTML + CSS（バンドラなし）
    ├── ts/               # ソース。tsc で js/ に出力
    ├── js/               # 生成物（コミット対象）
    └── index.html
```

**設計方針**

- フロントエンドフレームワークを載せない（Vite / Nuxt / React）。現状の規模では不要で、レンダリング問題はフレームワークでは解決しない
- Web Components も入れない。Shadow DOM の恩恵より書き味のコストが勝る
- 検索は Rust 側（Tantivy + lindera）。ブラウザでやる場所ではない

### データパス

| 種別 | パス |
|---|---|
| 読み込み | `~/.claude/history.jsonl`, `~/.claude/projects/**/{sessionId}.jsonl` |
| 書き込み | `~/Library/Application Support/com.cyocun.claude-session-manager/archive.json` |
| 設定 | `~/Library/Application Support/com.cyocun.claude-session-manager/settings.json` |
| 検索 index | `~/Library/Application Support/com.cyocun.claude-session-manager/search-index/` |

クラウド同期は一切行わない。外部通信は **アップデート確認のみ**。

---

## 開発

```bash
npm install
npm run tauri:dev          # Tauri dev モードで起動
npm run check:types        # フロントエンド型チェック
npm run build:frontend     # TS → JS のみビルド
cd src-tauri && cargo test # Rust テスト
```

TypeScript を触ったら `npm run build:frontend` を走らせる。生成物 `frontend/js/**` は Git 管理下なのでコミットに含める。

## リリース

1. `src-tauri/Cargo.toml` と `src-tauri/tauri.conf.json` の `version` を揃えて bump
2. `git commit -am "Bump version to X.Y.Z"`
3. `git tag vX.Y.Z && git push --follow-tags`
4. `.github/workflows/release.yml` が macOS arm64 ビルド・署名・GitHub Releases への公開を自動化（8〜10 分）

詳細な仕組みは [`CLAUDE.md`](CLAUDE.md) を参照。

## ライセンス

Private（個人プロジェクト）。公開利用・再配布は想定していません。
