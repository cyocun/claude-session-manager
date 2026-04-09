# Claude Session Manager — 公開戦略

## 概要

Claude Code のセッション履歴を管理・検索・分析するデスクトップアプリ（Tauri v2）。
全機能OSS（MIT）+ GitHub Sponsorsの寄付型で公開する。

### 方針決定の背景

- Claude Code ユーザーは開発者 = CLI に慣れており、GUI への需要は限定的
- 競合の大半は無料 OSS。有料ティアの複雑さに見合う収益が見込めない
- ライト CLI ユーザー向けツールとして、認知・実績・技術力の証明が主目的
- 収益化は目的ではなく、副次的な寄付を受け入れる形とする

---

## 競合分析

| ツール | 形態 | 特徴 |
|--------|------|------|
| CCManager | OSS CLI | 複数AIツール対応（Claude/Gemini/Codex/Cursor等） |
| Confabulous | OSS Web(Docker) | 分析・AI要約・チーム共有 |
| Claude Code History Viewer | OSS Desktop | 複数AI対応・リアルタイム更新 |
| Opcode | 商用 Desktop | GUI・タイムライン・チェックポイント |
| Nimbalyst | 商用 Desktop | カンバン・git worktree連携 |
| claude-history | OSS CLI | fuzzy検索 |
| VS Code拡張 | 複数あり | 履歴閲覧・検索 |

### 差別化ポイント

- **Tantivy全文検索 + Lindera日本語トークナイザ**: fuzzyマッチ・prefix検索・スニペット生成。他ツールにこのレベルの検索エンジンはない
- **トークン分析ダッシュボード**: 時系列チャート・モデル別コスト・ツール使用量・ヒートマップ・ワードクラウド
- **ネイティブmacOS体験**: Tauri v2、サイドバー、トレイ、キーボードショートカット
- **日本語ファースト**: i18n完備、日本語トークナイズ対応
- **MCP Server（計画中）**: Claude Codeセッション中から過去セッションを検索。**最大の差別化要因**
  - 既存ツールはすべて「GUIで過去を振り返る」もの
  - MCP Serverは「AIが作業中に過去の知識を能動的に活用する」という新カテゴリ

---

## モデル: 全機能OSS + GitHub Sponsors

### 選定理由

| モデル | 判定 | 理由 |
|--------|------|------|
| **OSS + GitHub Sponsors** | **◎** | **実装コストゼロ、認知最大化、コミュニティ貢献を受けられる** |
| Open Core + 買い切り | △ | ティア分割・ライセンス基盤の実装コストに見合う収益が不確実 |
| 完全有料 | × | 無料競合が多すぎて発見されない |
| サブスクリプション | × | ローカルアプリにサーバコストがなく正当化しにくい |

### 収益の現実的見通し

- GitHub Sponsors: 月$0〜200程度（楽観的見積もり）
- **収益化は目的ではない** — 認知・実績・技術力の証明が主目的
- 将来的にユーザーベースが成長した場合の選択肢は残しておく

---

## Go-to-Market

### Phase 1: OSS公開準備

- [ ] MITライセンス追加
- [ ] README.md（英語メイン + 日本語セクション）
- [ ] GitHub Sponsors設定（`.github/FUNDING.yml`）
- [ ] CI/CD（GitHub Actions: lint, build, .dmg生成）
- [ ] `brew install --cask claude-session-manager` 対応

### Phase 2: 告知

- [ ] **Zenn/Qiitaに技術記事**: 「TantivyとLinderaでClaude Codeセッションの日本語全文検索を作った」
- [ ] **dev.toに英語記事**: 「Give Claude Code a Memory: MCP Server for Cross-Session Search」
- [ ] **Show HN投稿**: MCP Server推しの英語エントリ
- [ ] r/ClaudeAI、Claude Code Discord投稿

### Phase 3: MCP Server公開

- [ ] MCP Server実装（Tantivy検索をMCP toolとして公開）
- [ ] 「CLIから過去セッションを検索」をフックに認知拡大
- [ ] **これが最大の差別化** — GUIビューアではなく開発ワークフローへの統合

---

## リスク評価

| リスク | 確率 | 影響 | 対策 |
|--------|------|------|------|
| Claude Code本体がセッション管理を追加 | 高 | 大 | MCP Serverはエコシステム拡張として共存可能 |
| 無料競合が検索・分析で追いつく | 中 | 中 | 先行公開 + 日本語対応の組み合わせで差別化維持 |
| 市場が小さい | 中 | 中 | 収益を期待しないことで精神的負荷なし |
| macOS限定 | 中 | 中 | Tauri v2はLinux対応可能。resume AppleScript以外はクロスプラットフォーム |
| ソロ開発のバーンアウト | 中 | 中 | 収益への期待値を下げ、コミュニティに委ねる |
