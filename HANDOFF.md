# セッション横断検索機能 — 引き継ぎ

## PR

- **PR**: https://github.com/cyocun/claude-session-manager/pull/2
- **ブランチ**: `claude/refine-local-plan-lW1OE` → `main`
- **ステータス**: コード実装済み、ビルド未検証（CI環境にGTK devパッケージなし）

## 変更ファイル一覧

| ファイル | 内容 |
|---------|------|
| `src-tauri/Cargo.toml` | `tantivy = "0.22"`, `rayon = "1"` 追加 |
| `src-tauri/src/search.rs` | **新規** SearchIndex構造体（Tantivyインデックス管理） |
| `src-tauri/src/commands/search.rs` | **新規** Tauriコマンド3つ |
| `src-tauri/src/commands/mod.rs` | `pub mod search;` 追加 |
| `src-tauri/src/commands/sessions.rs` | `claude_dir`, `find_session_file` を `pub` 化 |
| `src-tauri/src/models.rs` | `SearchHit`, `SearchIndexStatus` 型追加 |
| `src-tauri/src/main.rs` | `Arc<SearchIndex>`状態管理、バックグラウンドインデックス、`Emitter` import |
| `frontend/index.html` | 検索モードUI、結果表示、i18n、インクリメンタル更新（+191行） |

## ローカルでの確認手順

```bash
git fetch origin claude/refine-local-plan-lW1OE
git checkout claude/refine-local-plan-lW1OE
cd src-tauri && cargo build
```

## 動作確認チェックリスト

- [ ] `cargo build` 成功
- [ ] アプリ起動 → stderrに `Search index: N sessions to index out of M` ログ
- [ ] 起動完了後 `Search index: build complete` ログ
- [ ] 検索バー横の虫眼鏡ボタンクリック → ボタンがアクセントカラーに変化、プレースホルダが「内容検索」に
- [ ] キーワード入力 → 300ms後に検索結果がセッション一覧エリアに表示
- [ ] 結果にスニペット（ハイライト付き）が表示される
- [ ] 結果クリック → セッション詳細が開き該当メッセージ位置にスクロール
- [ ] 虫眼鏡ボタン再クリック → フィルタモードに戻り通常のセッション一覧表示
- [ ] 30秒自動更新後、新規/変更セッションがインデックスに追加される
- [ ] `~/Library/Application Support/com.cyocun.claude-session-manager/search-index/` にインデックスファイルが生成される
- [ ] `index-meta.json` にセッションID→ファイルサイズのマッピングが保存される

## 要注意ポイント

### ビルドエラーが出る可能性がある箇所

1. **Tantivy 0.22 API**
   - `TantivyDocument` — v0.22で`Document`から改名された型。もしエラーなら `tantivy::Document` に変更
   - `SnippetGenerator::create()` — シグネチャがバージョンで変わる可能性あり
   - `snippet.to_html()` — `<b>`タグでハイライトを返す前提。出力形式が違う場合はフロントの変換ロジック（`renderSearchResults`内の`replace`）を調整

2. **`IndexRecordOption::Basic`** — `tantivy::schema::IndexRecordOption`。glob importで取得しているが、パスが変わっていたら明示import

3. **Tauri v2 `Emitter` trait** — `main.rs`で`use tauri::Emitter;`を追加済み。`handle.emit("search-index-ready", ())`で使用

### 未使用依存

- `rayon` — Cargo.tomlに追加したが`search.rs`では未使用（インデックス構築を逐次処理に変更したため）。削除しても問題なし

### フロントエンドの粗い部分

1. **`scrollToMessageIndex`** — IntersectionObserverの遅延レンダリングとの連携で300ms固定waitを使用（`search.rs`のフロントエンド部分、`index.html`内`scrollToMessageIndex`関数）。MutationObserverで実際の描画完了を検知する方が正確
2. **スニペットのサニタイズ** — `<b>`タグのみを`<mark>`に変換する簡易処理。DOMPurifyを通すとより安全
3. **検索モードボタン** — テキストラベルなしのアイコンのみ。ツールチップ（title属性）はあるが、初見でわかりにくい可能性

## アーキテクチャ概要

```
Frontend (index.html)
  searchMode: 'filter' ←→ 'fulltext' トグル
       │                        │
  renderSessions()         invoke('search_sessions')
  (既存フィルタ)            → renderSearchResults()
                                │
  クリック → showDetail() + scrollToMessageIndex()

Rust Backend
  main.rs
    ├── setup: SearchIndex::new() → app.manage(Arc<SearchIndex>)
    ├── spawn: build_full_index (background thread)
    └── emit: "search-index-ready"

  search.rs ── SearchIndex
    ├── schema: session_id, project, content, msg_type, timestamp, message_index
    ├── index_session(): JSONL解析 → Tantivyドキュメント追加
    ├── search(): QueryParser → BooleanQuery → TopDocs → セッション単位集約
    ├── build_full_index(): history.jsonl走査 → 未インデックスセッション処理
    └── update_sessions(): 指定セッションの差分更新

  commands/search.rs
    ├── search_sessions(query, project, limit) → Vec<SearchHit>
    ├── get_search_index_status() → SearchIndexStatus
    └── update_search_index(session_ids) → ()
```

## 将来の改善候補

- インデックス構築の進捗をフロントエンドに逐次emit（現在は完了時のみ）
- 検索結果のページネーション（現在はlimit:50固定）
- ファジー検索/フレーズ検索のUI切り替え（Tantivy側は対応可能）
- インデックス破損時の自動復旧UI（現在はstderrログのみ）
