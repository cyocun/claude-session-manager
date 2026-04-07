# Claude Session Manager

## 残タスク

### UI改善
- [ ] detailHeaderの2行目（空div h=22px）を活用する — セッションメタ情報やアクションを配置する候補
- [ ] ダークモードでのテーブル縞模様・ツールブロックの見え方を検証
- [ ] セッション一覧の30秒自動更新を差分更新に最適化（現在は全DOM再構築）
- [ ] プレビューポップオーバーのレンダリングもIntersectionObserverで最適化可能
- [ ] セッション未選択→選択時のレイアウト遷移（1カラム→3カラム）のアニメーション検討

### 既知の制限
- チャットメッセージの遅延レンダリングのプレースホルダ高さ(32px)は推定値。スクロール位置が実際の内容と若干ズレる可能性あり
- `clear_webview_cache()` は起動時にキャッシュを全削除する力技。Tauri v2のWebView APIでの制御が理想

## 技術メモ

### レンダリング最適化
- チャットメッセージ: IntersectionObserverで遅延レンダリング（最後10件のみ即時、残りはビューポート200px手前で描画）
- セッション一覧: 即時レンダリング（軽量なため遅延のオーバーヘッドが逆効果）
- セッション詳細データ: previewCache（ホバー時取得）をクリック時に再利用
- 検索: 150msデバウンス

### レイアウト
- メインレイアウトはCSS Gridベース（body, sessionListPane, detailPane, chatContainer, headerRow等）
- セッション未選択時: `grid-template-columns: 1fr`（左カラム全幅）
- セッション選択時: `grid-template-columns: 300px 1px 1fr`（3カラム）
- grid子要素のスクロールには `min-height: 0` が必須（デフォルトの `min-height: auto` だとoverflowが効かない）
- ツールブロックは `overflow: hidden` を使わない（高さが0になる問題）
