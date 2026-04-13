# Contributor / AI Notes

## コード規約

- フロントエンドはバンドラを入れず `tsc` のみでコンパイル（`npm run build:frontend`）。ES Modules でファイル分割する前提で、新規 `.ts` を書いたら `import ... from './foo.js'` の形で参照する
- DOM は `innerHTML` を使わず、`createEl()` / `svgEl()` などの DOM API ヘルパー経由で構築する
- アイコンは Tabler Icons を踏襲（24x24 viewBox、stroke-width:2）。`frontend/icons/` に SVG を追加し、`frontend/ts/icons.ts` で参照する
- 日本語コメント可。ただしコードで語れる内容は書かない — コメントは「なぜ」だけに絞る

## レイアウト規約

- メインレイアウトは CSS Grid（`body` / `sessionListPane` / `detailPane` / `chatContainer` など）
- Grid 子要素の overflow は `min-height: 0` を明示しないと効かない
- ツールブロックは `overflow: hidden` を避ける（高さが 0 になる既知問題）

## バックエンド規約

- Tauri コマンドは `src-tauri/src/commands/{domain}.rs` にドメインごとに分割
- フロントがバンドラレスで Tauri プラグインの JS API を直接 import できないため、プラグインを使う機能は **Rust 側でラップした `#[tauri::command]` を追加し、JS からは `invoke('...')` で呼び出す** 設計にする（例: `commands/updater.rs`）

## リリース / 自動アップデート

- タグ `v*` を push すると `.github/workflows/release.yml` が macOS arm64 ビルドを作り、署名付きで GitHub Releases に上げる
- リリースを作る際は **`src-tauri/Cargo.toml` と `src-tauri/tauri.conf.json` の version を必ず揃えて bump** する
- 署名鍵 (`~/.tauri/claude-session-manager.key`) と GitHub Secrets (`TAURI_SIGNING_PRIVATE_KEY*`) は失うと既存ユーザーへのアップデート配信が不可能になる
