# Claude Session Manager

## 残タスク

### トークン機能
- [ ] トークン使用量の表示 — セッション毎のinput/output tokens数、概算コストをUI上に表示
- [ ] トークン使用量分析 — プロジェクト別・日別・週別のトークン消費トレンド、操作種別ごとの内訳、コンテキスト圧縮回数などの分析ダッシュボード

### セッション横断の知識発見
- [ ] 過去セッションからの類似問題検索 — 「このエラーを前にも解決したか」をセッション横断で引ける
- [ ] トークン消費と成果物の相関分析 — どのセッションが効率的だったかを可視化

### UI改善
- [x] detailHeaderを2行レイアウトに整理 — Row1: プロジェクト名・セッションタイトル（titlebar内）、Row2: フィルタ＋検索（操作行）
- [ ] ダークモードでのテーブル縞模様・ツールブロックの見え方を検証
- [ ] セッション一覧の30秒自動更新を差分更新に最適化（現在は全DOM再構築）
- [ ] プレビューポップオーバーのレンダリングもIntersectionObserverで最適化可能
- [ ] セッション未選択→選択時のレイアウト遷移（1カラム→3カラム）のアニメーション検討

### 既知の制限
- （修正済み）全文検索ヒット→右カラムハイライトのインデックスずれ — `msgDescs` で全メッセージの `origIdx` を保持し、描画要素がないメッセージにも `data-msg-idx` アンカーを置くことで解消
- `clear_webview_cache()` は起動時にキャッシュを全削除する力技。Tauri v2のWebView APIでの制御が理想
- リモート環境（Claude Code web等）では `libgtk-3-dev` / `libwebkit2gtk-4.1-dev` 等のシステム依存パッケージがインストールできず `cargo build` が通らない。Rustバックエンドのビルド確認はローカルで行うこと

### アーキテクチャ方針
- フレームワーク（Nuxt/Vite等）は現状の規模では不要。レンダリング問題の本質はフレームワークでは解決しない
- Web Components（Custom Elements）も現時点ではオーバーヘッドに見合わない。再利用するコンポーネントが少なく、Shadow DOMを使わないならカプセル化の恩恵も薄い
- コードの整理が必要になった場合はES Modulesでのファイル分割が最優先。グローバル変数の整理と合わせて行う

## 技術メモ

### レンダリング最適化
- チャットメッセージ: 末尾100件を即時描画、残りをrequestIdleCallbackでDocumentFragmentに構築→一括挿入。検索時は未描画分を同期フラッシュ
- セッション一覧: 即時レンダリング（軽量なため遅延のオーバーヘッドが逆効果）
- セッション詳細データ: previewCache（ホバー時取得）をクリック時に再利用
- 検索: 150msデバウンス

### レイアウト
- メインレイアウトはCSS Gridベース（body, sessionListPane, detailPane, chatContainer, headerRow等）
- セッション未選択時: `grid-template-columns: 1fr`（左カラム全幅）
- セッション選択時: `grid-template-columns: 300px 1px 1fr`（3カラム）
- grid子要素のスクロールには `min-height: 0` が必須（デフォルトの `min-height: auto` だとoverflowが効かない）
- ツールブロックは `overflow: hidden` を使わない（高さが0になる問題）

### アイコン
- Tabler Icons（https://tabler.io/icons）を使用。24x24 viewBox、stroke-width:2のストロークベース
- 既存アイコンは `frontend/icons/` にSVGファイルとして配置
- 動的生成が必要な場合は `svgEl()` ヘルパーでDOM APIを使って構築（innerHTML禁止）
