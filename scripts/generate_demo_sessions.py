#!/usr/bin/env python3
"""README動画用のダミーセッションを ~/.claude/projects/ 配下に生成するスクリプト"""

import json
import uuid
import os
from datetime import datetime, timedelta, timezone

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
DEMO_DIR = os.path.join(PROJECT_ROOT, "demo-data")
DEMO_PROJECTS = os.path.join(DEMO_DIR, "projects")
DEMO_PROJECT_PREFIX = "-Users-demo-projects-"

# ダミープロジェクト定義
PROJECTS = [
    {
        "dir_name": f"{DEMO_PROJECT_PREFIX}webapp-nextjs-dashboard",
        "cwd": "/Users/demo/projects/webapp-nextjs-dashboard",
        "sessions": [
            {
                "title": "ダッシュボードのグラフコンポーネント実装",
                "branch": "feature/dashboard-charts",
                "messages": [
                    {"role": "user", "text": "ダッシュボードにリアルタイムのグラフコンポーネントを追加したい。Chart.jsを使って売上推移と月別比較を表示するコンポーネントを作って"},
                    {"role": "assistant_text", "text": "まず現在のダッシュボードの構成を確認します。"},
                    {"role": "assistant_tool", "name": "Read", "input": {"file_path": "/Users/demo/projects/webapp-nextjs-dashboard/src/app/dashboard/page.tsx"}, "result": "import { Suspense } from 'react'\nimport { SalesOverview } from '@/components/sales-overview'\nimport { RecentOrders } from '@/components/recent-orders'\n\nexport default function DashboardPage() {\n  return (\n    <div className=\"grid grid-cols-12 gap-6 p-6\">\n      <div className=\"col-span-8\">\n        <Suspense fallback={<div>Loading...</div>}>\n          <SalesOverview />\n        </Suspense>\n      </div>\n      <div className=\"col-span-4\">\n        <RecentOrders />\n      </div>\n    </div>\n  )\n}"},
                    {"role": "assistant_tool", "name": "Bash", "input": {"command": "ls /Users/demo/projects/webapp-nextjs-dashboard/src/components/"}, "result": "recent-orders.tsx\nsales-overview.tsx\nheader.tsx\nsidebar.tsx\nui/"},
                    {"role": "assistant_text", "text": "既存の構成を把握しました。Chart.jsとreact-chartjs-2をインストールし、グラフコンポーネントを作成します。"},
                    {"role": "assistant_tool", "name": "Bash", "input": {"command": "cd /Users/demo/projects/webapp-nextjs-dashboard && npm install chart.js react-chartjs-2"}, "result": "added 2 packages in 3.2s"},
                    {"role": "assistant_tool", "name": "Write", "input": {"file_path": "/Users/demo/projects/webapp-nextjs-dashboard/src/components/charts/sales-chart.tsx", "content": "'use client'\n\nimport { Line } from 'react-chartjs-2'\nimport { Chart, registerables } from 'chart.js'\n\nChart.register(...registerables)\n\ninterface SalesChartProps {\n  data: { month: string; revenue: number }[]\n}\n\nexport function SalesChart({ data }: SalesChartProps) {\n  const chartData = {\n    labels: data.map(d => d.month),\n    datasets: [{\n      label: '売上',\n      data: data.map(d => d.revenue),\n      borderColor: 'rgb(59, 130, 246)',\n      tension: 0.3,\n    }],\n  }\n  return <Line data={chartData} options={{ responsive: true }} />\n}"}, "result": ""},
                    {"role": "assistant_tool", "name": "Write", "input": {"file_path": "/Users/demo/projects/webapp-nextjs-dashboard/src/components/charts/monthly-comparison.tsx", "content": "'use client'\n\nimport { Bar } from 'react-chartjs-2'\nimport { Chart, registerables } from 'chart.js'\n\nChart.register(...registerables)\n\nexport function MonthlyComparison({ current, previous }: { current: number[]; previous: number[] }) {\n  const chartData = {\n    labels: ['1月','2月','3月','4月','5月','6月'],\n    datasets: [\n      { label: '今年', data: current, backgroundColor: 'rgba(59,130,246,0.7)' },\n      { label: '昨年', data: previous, backgroundColor: 'rgba(156,163,175,0.5)' },\n    ],\n  }\n  return <Bar data={chartData} />\n}"}, "result": ""},
                    {"role": "assistant_tool", "name": "Edit", "input": {"file_path": "/Users/demo/projects/webapp-nextjs-dashboard/src/app/dashboard/page.tsx", "old_string": "<SalesOverview />", "new_string": "<SalesOverview />\n        <SalesChart data={salesData} />\n        <MonthlyComparison current={currentYear} previous={lastYear} />"}, "result": ""},
                    {"role": "assistant_text", "text": "グラフコンポーネントを作成し、ダッシュボードに組み込みました。\n\n- `SalesChart`: 売上推移の折れ線グラフ（Chart.js Line）\n- `MonthlyComparison`: 月別比較の棒グラフ（Chart.js Bar）\n\n型安全なpropsを受け取り、`'use client'`でクライアントサイドレンダリングしています。"},
                ],
                "date_offset_days": -2,
            },
            {
                "title": "認証ミドルウェアのリダイレクトバグ修正",
                "branch": "fix/auth-redirect",
                "messages": [
                    {"role": "user", "text": "ログインしてないユーザーが /dashboard にアクセスすると無限リダイレクトループになるバグがある。ミドルウェアを見てほしい"},
                    {"role": "assistant_text", "text": "ミドルウェアのリダイレクト処理を確認します。"},
                    {"role": "assistant_tool", "name": "Read", "input": {"file_path": "/Users/demo/projects/webapp-nextjs-dashboard/src/middleware.ts"}, "result": "import { NextResponse } from 'next/server'\nimport type { NextRequest } from 'next/server'\n\nexport function middleware(request: NextRequest) {\n  const token = request.cookies.get('auth-token')\n  if (!token) {\n    return NextResponse.redirect(new URL('/login', request.url))\n  }\n  return NextResponse.next()\n}\n\nexport const config = {\n  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],\n}"},
                    {"role": "assistant_text", "text": "原因がわかりました。`matcher`パターンが `/login` ページ自体にもマッチしています。未認証ユーザーが `/login` にアクセス → トークンなし → `/login` にリダイレクト → 繰り返し、で無限ループです。\n\n`/login`をmatcherの除外パターンに追加します。"},
                    {"role": "assistant_tool", "name": "Edit", "input": {"file_path": "/Users/demo/projects/webapp-nextjs-dashboard/src/middleware.ts", "old_string": "matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)']", "new_string": "matcher: ['/((?!api|_next/static|_next/image|favicon.ico|login).*)']"}, "result": ""},
                    {"role": "assistant_text", "text": "修正しました。`/login`パスをmatcherの除外パターンに追加したので、ログインページはミドルウェアをスキップします。これで無限リダイレクトが解消されます。"},
                ],
                "date_offset_days": -1,
            },
        ],
    },
    {
        "dir_name": f"{DEMO_PROJECT_PREFIX}api-rust-microservice",
        "cwd": "/Users/demo/projects/api-rust-microservice",
        "sessions": [
            {
                "title": "REST APIのページネーション実装",
                "branch": "feature/pagination",
                "messages": [
                    {"role": "user", "text": "GET /api/items エンドポイントにカーソルベースのページネーションを追加して。1ページ20件で"},
                    {"role": "assistant_text", "text": "現在のハンドラを確認します。"},
                    {"role": "assistant_tool", "name": "Read", "input": {"file_path": "/Users/demo/projects/api-rust-microservice/src/handlers/items.rs"}, "result": "use axum::{Json, extract::State};\nuse crate::{AppState, models::Item};\n\npub async fn list_items(\n    State(state): State<AppState>,\n) -> Json<Vec<Item>> {\n    let items = sqlx::query_as!(Item, \"SELECT * FROM items ORDER BY created_at DESC\")\n        .fetch_all(&state.pool)\n        .await\n        .unwrap();\n    Json(items)\n}"},
                    {"role": "assistant_tool", "name": "Grep", "input": {"pattern": "struct Item", "path": "/Users/demo/projects/api-rust-microservice/src/models/"}, "result": "src/models/item.rs:5:pub struct Item {\nsrc/models/item.rs:6:    pub id: i64,\nsrc/models/item.rs:7:    pub name: String,\nsrc/models/item.rs:8:    pub description: Option<String>,\nsrc/models/item.rs:9:    pub created_at: chrono::DateTime<chrono::Utc>,\nsrc/models/item.rs:10:}"},
                    {"role": "assistant_tool", "name": "Edit", "input": {"file_path": "/Users/demo/projects/api-rust-microservice/src/handlers/items.rs", "old_string": "pub async fn list_items", "new_string": "#[derive(Deserialize)]\npub struct PaginationParams {\n    pub cursor: Option<i64>,\n    pub limit: Option<i64>,\n}\n\n#[derive(Serialize)]\npub struct PaginatedResponse<T> {\n    pub items: Vec<T>,\n    pub next_cursor: Option<i64>,\n    pub has_more: bool,\n}\n\npub async fn list_items"}, "result": ""},
                    {"role": "assistant_text", "text": "カーソルベースのページネーションを実装しました。\n\n- `cursor`: 前回の最後のIDを指定（省略時は先頭から）\n- `limit`: 1ページの件数（デフォルト20、最大100）\n- レスポンスに `next_cursor` と `has_more` を含む"},
                ],
                "date_offset_days": -5,
            },
            {
                "title": "SQLインジェクション脆弱性の修正",
                "branch": "fix/sql-injection",
                "messages": [
                    {"role": "user", "text": "セキュリティレビューでsearch endpointにSQLインジェクションの指摘があった。修正して"},
                    {"role": "assistant_tool", "name": "Read", "input": {"file_path": "/Users/demo/projects/api-rust-microservice/src/handlers/search.rs"}, "result": "use axum::{Json, extract::{State, Query}};\nuse crate::AppState;\n\n#[derive(Deserialize)]\npub struct SearchParams {\n    pub q: String,\n}\n\npub async fn search(\n    State(state): State<AppState>,\n    Query(params): Query<SearchParams>,\n) -> Json<Vec<serde_json::Value>> {\n    let query = format!(\"SELECT * FROM items WHERE name LIKE '%{}%'\", params.q);\n    let rows = sqlx::query(&query)\n        .fetch_all(&state.pool)\n        .await\n        .unwrap();\n    Json(rows.into_iter().map(|r| serde_json::json!(r)).collect())\n}"},
                    {"role": "assistant_text", "text": "明確なSQLインジェクション脆弱性です。`format!`でユーザー入力を直接SQL文に展開しています。`sqlx::query!`マクロのバインドパラメータに置き換えます。"},
                    {"role": "assistant_tool", "name": "Edit", "input": {"file_path": "/Users/demo/projects/api-rust-microservice/src/handlers/search.rs", "old_string": "let query = format!(\"SELECT * FROM items WHERE name LIKE '%{}%'\", params.q);\n    let rows = sqlx::query(&query)", "new_string": "let pattern = format!(\"%{}%\", params.q);\n    let rows = sqlx::query!(\"SELECT * FROM items WHERE name LIKE $1\", pattern)"}, "result": ""},
                    {"role": "assistant_tool", "name": "Bash", "input": {"command": "cd /Users/demo/projects/api-rust-microservice && cargo test test_search -- --nocapture"}, "result": "running 3 tests\ntest test_search_basic ... ok\ntest test_search_special_chars ... ok\ntest test_search_empty ... ok\n\ntest result: ok. 3 passed; 0 failed"},
                    {"role": "assistant_text", "text": "修正完了。`format!`による文字列結合を`sqlx`のバインドパラメータ（`$1`）に置き換えました。テストも全て通過しています。"},
                ],
                "date_offset_days": -3,
            },
        ],
    },
    {
        "dir_name": f"{DEMO_PROJECT_PREFIX}mobile-react-native",
        "cwd": "/Users/demo/projects/mobile-react-native",
        "sessions": [
            {
                "title": "プッシュ通知のPermission処理実装",
                "branch": "feature/push-notifications",
                "messages": [
                    {"role": "user", "text": "iOS/Android両対応のプッシュ通知Permission処理を追加して。expo-notificationsを使う"},
                    {"role": "assistant_tool", "name": "Bash", "input": {"command": "cd /Users/demo/projects/mobile-react-native && npx expo install expo-notifications expo-device expo-constants"}, "result": "Installing 3 SDK 52 compatible native modules\n✓ Installed expo-notifications, expo-device, expo-constants"},
                    {"role": "assistant_tool", "name": "Glob", "input": {"pattern": "src/hooks/*.ts"}, "result": "src/hooks/useAuth.ts\nsrc/hooks/useTheme.ts"},
                    {"role": "assistant_tool", "name": "Write", "input": {"file_path": "/Users/demo/projects/mobile-react-native/src/hooks/usePushNotifications.ts", "content": "import { useState, useEffect, useRef } from 'react'\nimport * as Notifications from 'expo-notifications'\nimport * as Device from 'expo-device'\nimport { Platform } from 'react-native'\n\nexport function usePushNotifications() {\n  const [expoPushToken, setExpoPushToken] = useState<string | null>(null)\n  const [permission, setPermission] = useState<'granted' | 'denied' | 'undetermined'>('undetermined')\n  const notificationListener = useRef<Notifications.Subscription>()\n\n  useEffect(() => {\n    registerForPushNotifications().then(token => setExpoPushToken(token ?? null))\n    notificationListener.current = Notifications.addNotificationReceivedListener(notification => {\n      console.log('Notification received:', notification)\n    })\n    return () => { notificationListener.current?.remove() }\n  }, [])\n\n  async function registerForPushNotifications() {\n    if (!Device.isDevice) { console.warn('Push notifications require a physical device'); return }\n    const { status: existing } = await Notifications.getPermissionsAsync()\n    let finalStatus = existing\n    if (existing !== 'granted') {\n      const { status } = await Notifications.requestPermissionsAsync()\n      finalStatus = status\n    }\n    setPermission(finalStatus as any)\n    if (finalStatus !== 'granted') return\n    if (Platform.OS === 'android') {\n      await Notifications.setNotificationChannelAsync('default', {\n        name: 'default', importance: Notifications.AndroidImportance.MAX,\n      })\n    }\n    const token = (await Notifications.getExpoPushTokenAsync()).data\n    return token\n  }\n\n  return { expoPushToken, permission, registerForPushNotifications }\n}"}, "result": ""},
                    {"role": "assistant_text", "text": "`usePushNotifications` hookを作成しました。\n\n- iOS/Androidのパーミッション処理を統一的に管理\n- Androidではnotification channelを自動セットアップ\n- シミュレータでは警告を出して早期リターン\n- リスナーのクリーンアップもuseEffectで処理"},
                ],
                "date_offset_days": -4,
            },
        ],
    },
    {
        "dir_name": f"{DEMO_PROJECT_PREFIX}infra-terraform",
        "cwd": "/Users/demo/projects/infra-terraform",
        "sessions": [
            {
                "title": "本番環境のAuto Scaling設定",
                "branch": "feature/prod-autoscaling",
                "messages": [
                    {"role": "user", "text": "本番環境のECSサービスにAuto Scalingを設定したい。CPU使用率70%をターゲットにして、min 2 max 10で"},
                    {"role": "assistant_tool", "name": "Read", "input": {"file_path": "/Users/demo/projects/infra-terraform/modules/ecs/main.tf"}, "result": "resource \"aws_ecs_service\" \"app\" {\n  name            = \"${var.project}-${var.environment}\"\n  cluster         = aws_ecs_cluster.main.id\n  task_definition = aws_ecs_task_definition.app.arn\n  desired_count   = var.desired_count\n  launch_type     = \"FARGATE\"\n\n  network_configuration {\n    subnets         = var.private_subnet_ids\n    security_groups = [aws_security_group.ecs.id]\n  }\n\n  load_balancer {\n    target_group_arn = var.target_group_arn\n    container_name   = \"app\"\n    container_port   = 8080\n  }\n}"},
                    {"role": "assistant_tool", "name": "Write", "input": {"file_path": "/Users/demo/projects/infra-terraform/modules/ecs/autoscaling.tf", "content": "resource \"aws_appautoscaling_target\" \"ecs\" {\n  max_capacity       = var.autoscaling_max\n  min_capacity       = var.autoscaling_min\n  resource_id        = \"service/${aws_ecs_cluster.main.name}/${aws_ecs_service.app.name}\"\n  scalable_dimension = \"ecs:service:DesiredCount\"\n  service_namespace  = \"ecs\"\n}\n\nresource \"aws_appautoscaling_policy\" \"cpu\" {\n  name               = \"${var.project}-${var.environment}-cpu-scaling\"\n  policy_type        = \"TargetTrackingScaling\"\n  resource_id        = aws_appautoscaling_target.ecs.resource_id\n  scalable_dimension = aws_appautoscaling_target.ecs.scalable_dimension\n  service_namespace  = aws_appautoscaling_target.ecs.service_namespace\n\n  target_tracking_scaling_policy_configuration {\n    predefined_metric_specification {\n      predefined_metric_type = \"ECSServiceAverageCPUUtilization\"\n    }\n    target_value       = var.cpu_target_value\n    scale_in_cooldown  = 300\n    scale_out_cooldown = 60\n  }\n}"}, "result": ""},
                    {"role": "assistant_tool", "name": "Bash", "input": {"command": "cd /Users/demo/projects/infra-terraform && terraform plan -target=module.ecs 2>&1 | tail -20"}, "result": "Plan: 2 to add, 0 to change, 0 to destroy.\n\nChanges to Outputs:\n  + autoscaling_target_id = (known after apply)\n  + scaling_policy_arn    = (known after apply)"},
                    {"role": "assistant_text", "text": "Auto Scaling設定を追加しました。`terraform plan`で2リソース追加を確認済み。\n\n- `aws_appautoscaling_target`: min=2, max=10\n- `aws_appautoscaling_policy`: CPU 70%ターゲット追跡\n- スケールアウト60秒/スケールイン300秒のクールダウン"},
                ],
                "date_offset_days": -6,
            },
        ],
    },
    {
        "dir_name": f"{DEMO_PROJECT_PREFIX}monorepo-fullstack",
        "cwd": "/Users/demo/projects/monorepo-fullstack",
        "sessions": [
            {
                "title": "shared typesパッケージの作成とフロント・バックエンド統合",
                "branch": "feature/shared-types",
                "messages": [
                    {"role": "user", "text": "フロントエンドとバックエンドで型定義が重複しまくってる。packages/shared-types を作って共通化したい"},
                    {"role": "assistant_tool", "name": "Bash", "input": {"command": "ls /Users/demo/projects/monorepo-fullstack/packages/"}, "result": "frontend/\nbackend/\neslint-config/"},
                    {"role": "assistant_tool", "name": "Grep", "input": {"pattern": "interface (User|Order|Product)", "path": "/Users/demo/projects/monorepo-fullstack/"}, "result": "packages/frontend/src/types/user.ts:3:interface User {\npackages/frontend/src/types/order.ts:5:interface Order {\npackages/backend/src/types/user.ts:3:interface User {\npackages/backend/src/types/order.ts:5:interface Order {\npackages/backend/src/types/product.ts:3:interface Product {"},
                    {"role": "assistant_text", "text": "User, Order が前後で重複、Product はバックエンドのみ。共通パッケージを作ります。"},
                    {"role": "assistant_tool", "name": "Bash", "input": {"command": "mkdir -p /Users/demo/projects/monorepo-fullstack/packages/shared-types/src"}, "result": ""},
                    {"role": "assistant_tool", "name": "Write", "input": {"file_path": "/Users/demo/projects/monorepo-fullstack/packages/shared-types/src/index.ts", "content": "export type { User } from './user'\nexport type { Order, OrderStatus } from './order'\nexport type { Product } from './product'\nexport type { ApiResponse, PaginatedResponse } from './api'"}, "result": ""},
                    {"role": "assistant_tool", "name": "Write", "input": {"file_path": "/Users/demo/projects/monorepo-fullstack/packages/shared-types/src/user.ts", "content": "export interface User {\n  id: string\n  email: string\n  name: string\n  role: 'admin' | 'member' | 'viewer'\n  createdAt: string\n  updatedAt: string\n}"}, "result": ""},
                    {"role": "assistant_tool", "name": "Bash", "input": {"command": "cd /Users/demo/projects/monorepo-fullstack && pnpm install && pnpm --filter frontend build && pnpm --filter backend build"}, "result": "Scope: all 4 workspace packages\npackages/shared-types build: tsc --build\npackages/frontend build: vite build ✓\npackages/backend build: tsc && node dist/index.js --dry-run ✓\n\nAll builds succeeded."},
                    {"role": "assistant_text", "text": "共通型パッケージ `@monorepo/shared-types` を作成し、frontend/backendの重複型定義を統合しました。ビルドも全パッケージ通過しています。"},
                ],
                "date_offset_days": -7,
            },
            {
                "title": "CI/CDパイプラインでのテスト並列化",
                "branch": "improve/ci-parallel-tests",
                "messages": [
                    {"role": "user", "text": "GitHub ActionsのCIが遅い。テストを並列実行するように最適化して"},
                    {"role": "assistant_tool", "name": "Read", "input": {"file_path": "/Users/demo/projects/monorepo-fullstack/.github/workflows/ci.yml"}, "result": "name: CI\non:\n  push:\n    branches: [main]\n  pull_request:\n    branches: [main]\n\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: pnpm/action-setup@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 22\n          cache: 'pnpm'\n      - run: pnpm install\n      - run: pnpm lint\n      - run: pnpm test --filter frontend\n      - run: pnpm test --filter backend\n      - run: pnpm test:e2e"},
                    {"role": "assistant_text", "text": "現在は1ジョブで直列実行。lint/unit test/e2eをmatrix strategyで並列化します。"},
                    {"role": "assistant_tool", "name": "Write", "input": {"file_path": "/Users/demo/projects/monorepo-fullstack/.github/workflows/ci.yml", "content": "name: CI\non:\n  push:\n    branches: [main]\n  pull_request:\n    branches: [main]\n\njobs:\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: pnpm/action-setup@v4\n      - uses: actions/setup-node@v4\n        with: { node-version: 22, cache: 'pnpm' }\n      - run: pnpm install\n      - run: pnpm lint\n\n  test:\n    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        package: [frontend, backend]\n    steps:\n      - uses: actions/checkout@v4\n      - uses: pnpm/action-setup@v4\n      - uses: actions/setup-node@v4\n        with: { node-version: 22, cache: 'pnpm' }\n      - run: pnpm install\n      - run: pnpm test --filter ${{ matrix.package }}\n\n  e2e:\n    needs: [test]\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: pnpm/action-setup@v4\n      - uses: actions/setup-node@v4\n        with: { node-version: 22, cache: 'pnpm' }\n      - run: pnpm install\n      - run: pnpm test:e2e"}, "result": ""},
                    {"role": "assistant_text", "text": "CIパイプラインを3ジョブに分割しました。\n\n- **lint**: 独立実行\n- **test**: frontend/backendをmatrixで並列実行\n- **e2e**: unit test完了後に実行\n\nlintとtestが同時に走るので、CIの総実行時間は大幅に短縮されます。"},
                ],
                "date_offset_days": -8,
            },
        ],
    },
    {
        "dir_name": f"{DEMO_PROJECT_PREFIX}docs-site-astro",
        "cwd": "/Users/demo/projects/docs-site-astro",
        "sessions": [
            {
                "title": "ドキュメントサイトの全文検索機能",
                "branch": "feature/search",
                "messages": [
                    {"role": "user", "text": "Astroのドキュメントサイトにクライアントサイドの全文検索を追加したい。Pagefindを使って"},
                    {"role": "assistant_tool", "name": "Bash", "input": {"command": "cd /Users/demo/projects/docs-site-astro && npm install pagefind"}, "result": "added 1 package in 1.8s"},
                    {"role": "assistant_tool", "name": "Read", "input": {"file_path": "/Users/demo/projects/docs-site-astro/astro.config.mjs"}, "result": "import { defineConfig } from 'astro/config'\nimport mdx from '@astrojs/mdx'\nimport sitemap from '@astrojs/sitemap'\n\nexport default defineConfig({\n  site: 'https://docs.example.com',\n  integrations: [mdx(), sitemap()],\n})"},
                    {"role": "assistant_tool", "name": "Write", "input": {"file_path": "/Users/demo/projects/docs-site-astro/src/components/Search.astro", "content": "---\n// Pagefind search component\n---\n<div id=\"search\" class=\"search-container\">\n  <div id=\"search-input\"></div>\n</div>\n\n<script>\n  import '/pagefind/pagefind-ui.js'\n  new PagefindUI({ element: '#search-input', showSubResults: true })\n</script>\n\n<style>\n  .search-container {\n    max-width: 640px;\n    margin: 0 auto;\n  }\n</style>"}, "result": ""},
                    {"role": "assistant_tool", "name": "Bash", "input": {"command": "cd /Users/demo/projects/docs-site-astro && npx astro build && npx pagefind --site dist"}, "result": "▶ Building site...\n✓ Built in 2.3s\n\nRunning Pagefind v1.3.0\nIndexed 47 pages\nTotal index size: 89KB"},
                    {"role": "assistant_text", "text": "Pagefindで全文検索を実装しました。\n\n- ビルド後に47ページをインデックス化（89KB）\n- 検索UIコンポーネント `Search.astro` を追加\n- サブ結果表示有効、クライアントサイドで高速検索"},
                ],
                "date_offset_days": -10,
            },
        ],
    },
    {
        "dir_name": f"{DEMO_PROJECT_PREFIX}cli-tool-go",
        "cwd": "/Users/demo/projects/cli-tool-go",
        "sessions": [
            {
                "title": "CLIツールのインタラクティブモード追加",
                "branch": "feature/interactive-mode",
                "messages": [
                    {"role": "user", "text": "デプロイCLIにインタラクティブモードを追加して。環境選択→確認→実行のフローで"},
                    {"role": "assistant_tool", "name": "Read", "input": {"file_path": "/Users/demo/projects/cli-tool-go/cmd/deploy.go"}, "result": "package cmd\n\nimport (\n\t\"fmt\"\n\t\"github.com/spf13/cobra\"\n)\n\nvar deployCmd = &cobra.Command{\n\tUse:   \"deploy\",\n\tShort: \"Deploy the application\",\n\tRunE: func(cmd *cobra.Command, args []string) error {\n\t\tenv, _ := cmd.Flags().GetString(\"env\")\n\t\tif env == \"\" {\n\t\t\treturn fmt.Errorf(\"--env flag is required\")\n\t\t}\n\t\treturn runDeploy(env)\n\t},\n}"},
                    {"role": "assistant_tool", "name": "Bash", "input": {"command": "cd /Users/demo/projects/cli-tool-go && go get github.com/AlecAivazis/survey/v2"}, "result": "go: added github.com/AlecAivazis/survey/v2 v2.3.7"},
                    {"role": "assistant_tool", "name": "Edit", "input": {"file_path": "/Users/demo/projects/cli-tool-go/cmd/deploy.go", "old_string": "if env == \"\" {\n\t\t\treturn fmt.Errorf(\"--env flag is required\")\n\t\t}", "new_string": "if env == \"\" {\n\t\t\tenv = promptEnvironment()\n\t\t}\n\t\tif !confirmDeploy(env) {\n\t\t\tfmt.Println(\"Deploy cancelled.\")\n\t\t\treturn nil\n\t\t}"}, "result": ""},
                    {"role": "assistant_tool", "name": "Bash", "input": {"command": "cd /Users/demo/projects/cli-tool-go && go build ./... && echo 'Build OK'"}, "result": "Build OK"},
                    {"role": "assistant_text", "text": "インタラクティブモードを追加しました。\n\n- `--env`省略時: survey.jsで環境選択プロンプト表示\n- 確認ステップ: 選択環境を表示して `y/N` で確認\n- `N`でキャンセル可能\n- `--env`指定時は従来通り即座にデプロイ実行"},
                ],
                "date_offset_days": -12,
            },
        ],
    },
]


def make_uuid():
    return str(uuid.uuid4())


def make_timestamp(base: datetime, offset_minutes: int = 0):
    return (base + timedelta(minutes=offset_minutes)).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def build_session_jsonl(project, session_def):
    session_id = make_uuid()
    now = datetime.now(timezone.utc) + timedelta(days=session_def["date_offset_days"])
    lines = []

    # permission-mode
    lines.append(json.dumps({
        "type": "permission-mode",
        "permissionMode": "default",
        "sessionId": session_id,
    }))

    prev_uuid = None
    minute = 0

    for msg in session_def["messages"]:
        msg_uuid = make_uuid()
        ts = make_timestamp(now, minute)

        if msg["role"] == "user":
            entry = {
                "parentUuid": prev_uuid,
                "isSidechain": False,
                "promptId": make_uuid(),
                "type": "user",
                "message": {"role": "user", "content": msg["text"]},
                "uuid": msg_uuid,
                "timestamp": ts,
                "permissionMode": "default",
                "userType": "external",
                "entrypoint": "cli",
                "cwd": project["cwd"],
                "sessionId": session_id,
                "version": "2.1.92",
                "gitBranch": session_def.get("branch", "main"),
            }
            lines.append(json.dumps(entry, ensure_ascii=False))
            prev_uuid = msg_uuid
            minute += 1

        elif msg["role"] == "assistant_text":
            entry = {
                "parentUuid": prev_uuid,
                "isSidechain": False,
                "message": {
                    "model": "claude-sonnet-4-20250514",
                    "id": f"msg_{make_uuid()[:24]}",
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "text", "text": msg["text"]}],
                    "stop_reason": "end_turn",
                    "stop_sequence": None,
                    "stop_details": None,
                    "usage": {
                        "input_tokens": 1200 + minute * 300,
                        "output_tokens": 200 + minute * 50,
                        "cache_read_input_tokens": 800,
                        "cache_creation_input_tokens": 400,
                    },
                },
                "type": "assistant",
                "uuid": msg_uuid,
                "timestamp": ts,
                "sessionId": session_id,
            }
            lines.append(json.dumps(entry, ensure_ascii=False))
            prev_uuid = msg_uuid
            minute += 1

        elif msg["role"] == "assistant_tool":
            tool_id = f"toolu_{make_uuid()[:24]}"
            # assistant message with tool_use
            assistant_uuid = msg_uuid
            entry = {
                "parentUuid": prev_uuid,
                "isSidechain": False,
                "message": {
                    "model": "claude-sonnet-4-20250514",
                    "id": f"msg_{make_uuid()[:24]}",
                    "type": "message",
                    "role": "assistant",
                    "content": [{
                        "type": "tool_use",
                        "id": tool_id,
                        "name": msg["name"],
                        "input": msg["input"],
                    }],
                    "stop_reason": "tool_use",
                    "stop_sequence": None,
                    "stop_details": None,
                    "usage": {
                        "input_tokens": 1500 + minute * 300,
                        "output_tokens": 100 + minute * 30,
                        "cache_read_input_tokens": 1000,
                        "cache_creation_input_tokens": 500,
                    },
                },
                "type": "assistant",
                "uuid": assistant_uuid,
                "timestamp": ts,
                "sessionId": session_id,
            }
            lines.append(json.dumps(entry, ensure_ascii=False))
            prev_uuid = assistant_uuid
            minute += 1

            # tool_result (user message)
            result_uuid = make_uuid()
            result_ts = make_timestamp(now, minute)
            is_error = msg.get("is_error", False)
            result_entry = {
                "parentUuid": assistant_uuid,
                "isSidechain": False,
                "promptId": make_uuid(),
                "type": "user",
                "message": {
                    "role": "user",
                    "content": [{
                        "tool_use_id": tool_id,
                        "type": "tool_result",
                        "content": msg["result"],
                        "is_error": is_error,
                    }],
                },
                "uuid": result_uuid,
                "timestamp": result_ts,
                "toolUseResult": {
                    "stdout": msg["result"],
                    "stderr": "",
                    "interrupted": False,
                    "isImage": False,
                },
                "sourceToolAssistantUUID": assistant_uuid,
                "userType": "external",
                "sessionId": session_id,
            }
            lines.append(json.dumps(result_entry, ensure_ascii=False))
            prev_uuid = result_uuid
            minute += 1

    return session_id, "\n".join(lines) + "\n"


def make_history_entry(session_id, project_cwd, display_text, timestamp_ms):
    """history.jsonl 用のエントリを生成"""
    return json.dumps({
        "display": display_text,
        "timestamp": timestamp_ms,
        "project": project_cwd,
        "sessionId": session_id,
    }, ensure_ascii=False)


def main():
    # デモディレクトリをクリーンアップして再作成
    import shutil
    if os.path.exists(DEMO_DIR):
        shutil.rmtree(DEMO_DIR)
    os.makedirs(DEMO_PROJECTS, exist_ok=True)

    created = []
    history_lines = []

    for project in PROJECTS:
        proj_dir = os.path.join(DEMO_PROJECTS, project["dir_name"])
        os.makedirs(proj_dir, exist_ok=True)

        for session_def in project["sessions"]:
            session_id, content = build_session_jsonl(project, session_def)
            filepath = os.path.join(proj_dir, f"{session_id}.jsonl")
            with open(filepath, "w") as f:
                f.write(content)

            # history.jsonl エントリを生成（各メッセージ分）
            now = datetime.now(timezone.utc) + timedelta(days=session_def["date_offset_days"])
            minute = 0
            for msg in session_def["messages"]:
                if msg["role"] == "user":
                    ts_ms = int((now + timedelta(minutes=minute)).timestamp() * 1000)
                    history_lines.append(make_history_entry(
                        session_id, project["cwd"], msg["text"], ts_ms
                    ))
                elif msg["role"] == "assistant_text":
                    ts_ms = int((now + timedelta(minutes=minute)).timestamp() * 1000)
                    history_lines.append(make_history_entry(
                        session_id, project["cwd"], msg["text"], ts_ms
                    ))
                minute += 1

            created.append((project["dir_name"], session_def["title"], filepath))
            print(f"✓ {session_def['title']}")
            print(f"  → {filepath}")

    # history.jsonl を書き出し
    history_path = os.path.join(DEMO_DIR, "history.jsonl")
    with open(history_path, "w") as f:
        f.write("\n".join(history_lines) + "\n")
    print(f"\n✓ history.jsonl ({len(history_lines)} entries)")
    print(f"  → {history_path}")
    print(f"\n合計 {len(created)} セッションを作成しました")
    print(f"\nデモモードで起動:")
    print(f"  CLAUDE_DATA_DIR={DEMO_DIR} open /Applications/Claude\\ Sessions.app")


if __name__ == "__main__":
    main()
