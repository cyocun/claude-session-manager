# Claude Session Manager

[🇬🇧 English](./README.md) | [🇯🇵 日本語](./README.ja.md) | **🇨🇳 简体中文**

![status](https://img.shields.io/badge/status-private%20%2F%20WIP-orange)
![platform](https://img.shields.io/badge/platform-macOS%20(Apple%20Silicon)-lightgrey)
![license](https://img.shields.io/badge/license-Private-red)

一款用于浏览、搜索并恢复本地 Claude Code 历史记录 (`~/.claude`) 的原生 macOS 桌面应用。将分散在数十个项目中的会话汇聚为一个统一、可搜索、可直接使用的界面。

> **状态** — 私人实验性项目，仍在持续开发中。仅支持 macOS (Apple Silicon)。不提供公开支持，也不保证稳定性。

---

## 为什么要做这个

Claude Code CLI 会把每一次会话都保存在本地,却没有提供真正的跨会话搜索手段。一旦积累到几百个会话,历史就变成只写不读的状态。本应用把这份历史当作一等公民的可查询归档来对待:

- **真正能在实际历史上工作的混合搜索** — 词法 (BM25) 与语义 (向量) 两种结果通过 Reciprocal Rank Fusion 融合,针对嘈杂的聊天记录做了调优
- **日语优先的分词** — lindera + IPAdic,带 phrase-slop 匹配,使得助词和复合词不再拖累召回率
- **默认仅本地** — 会话永远不离开你的机器;唯一的出站流量是更新检查
- **成本透明度** — 输入 / 输出 / 缓存的 token 趋势以及按模型的 USD 估算,可按项目或会话查看
- **结构化的工具调用渲染** — `Bash`、`Edit`、`Read`、`Grep` 等以带 diff 高亮和语言感知语法着色的代码块呈现,而不是一堵 JSON 墙

## 差异化

| | 官方 Claude Code CLI | 一般的会话查看器 | **Claude Session Manager** |
|---|---|---|---|
| 跨项目浏览 | 手动 | 部分支持 | 自动扫描,按最近更新排序 |
| 全文搜索 | 无 | 仅子串匹配 | Tantivy BM25 + phrase slop |
| 语义搜索 | 无 | 无 | Multilingual-E5-Large + RRF 融合 |
| 日语分词 | 无 | 无 | lindera IPAdic |
| 工具调用渲染 | 纯文本 | 纯文本 | 结构化代码块 + diff + 语法高亮 |
| Token / 成本分析 | 无 | 无 | 完整仪表板(趋势、热力图、词云) |
| 终端恢复 | 仅 CLI | — | 启动 Terminal / iTerm / Warp / Ghostty / cmux |
| 隐私 | 本地 | 视情况而定 | 仅本地;出站流量 = 更新检查 |
| 自动更新 | 手动 | 视情况而定 | 经签名的 GitHub Releases,后台检查 |

---

## 功能

### 浏览

- 跨项目的会话列表,按最近更新排序
- 详情视图,按消息粒度渲染,并用结构化代码块呈现工具调用
- 侧边栏的项目统计(最近会话、总数、最后更新)
- 归档(可通过 toast 撤销)

### 搜索

- **全文 (BM25)** — 基于 Tantivy + lindera (IPAdic),支持短语匹配、模糊、前缀,以及对助词容忍的 slop
- **语义 (向量)** — 基于 Multilingual-E5-Large 嵌入,按用户轮次分块
- **混合** — BM25 与向量结果经 Reciprocal Rank Fusion (K=60) 融合,每条命中带有来源标签
- 过滤:时间范围、消息类型;排序:相关度 / 最新 / 最旧
- 会话内聊天搜索 (`⌘F`) 与跨会话全文搜索 (`⌘⇧F`)

### 分析

- 输入 / 输出 / 缓存 token 按小时 / 日 / 周 / 月的趋势
- 按模型的成本估算 (USD)
- 工具使用频次排行
- 活动热力图
- 高频词的词云

### 终端集成

- 一键恢复 (`⌘↵`) 到 Terminal.app / iTerm / Warp / Ghostty / cmux
- 原生生成并派发 `claude --resume`
- 从项目根目录开启新会话 (`⌘N`)

### 系统

- 经签名的 GitHub Releases 自动更新(启动时 + 每 6 小时检查一次)
- 主题选择(跟随系统 / 浅色 / 深色)
- macOS 原生行为:菜单栏、托盘、`⌘Tab`、置顶

---

## 安装

### 通过 DMG(推荐)

1. 从 [Releases](https://github.com/cyocun/claude-session-manager/releases/latest) 下载 `Claude.Sessions_*_aarch64.dmg`
2. 打开 DMG,将应用拖入 Applications
3. 首次启动因未经公证,会提示「无法验证开发者」 → **右键 → 打开** 即可绕过 Gatekeeper

### 从源码构建

前置:Node.js 18+、Rust stable、Xcode Command Line Tools。

```bash
git clone https://github.com/cyocun/claude-session-manager.git
cd claude-session-manager
npm install
npm run tauri:build
```

构建产物:

- `src-tauri/target/release/bundle/macos/Claude Sessions.app`
- `src-tauri/target/release/bundle/dmg/Claude Sessions_*.dmg`

---

## 快捷键

| 快捷键 | 动作 |
|---|---|
| `⌘F` | 在当前会话内搜索 |
| `⌘⇧F` | 跨会话全文搜索 |
| `⌘↵` | 在已配置的终端中恢复所选会话 |
| `⌘N` | 从项目根目录开启新会话 |
| `⌘⌫` | 归档所选会话(可通过 toast 撤销) |
| `⌘,` | 设置(主题 / 语言 / 终端) |

---

## 架构

```
claude-session-manager/
├── src-tauri/            # Tauri (Rust) 应用层
│   ├── src/commands/     # 按领域拆分的 #[tauri::command] 处理函数
│   └── tauri.conf.json
├── crates/
│   ├── csm-core/         # 不依赖 Tauri 的核心(搜索 / 会话解析 / 嵌入)
│   └── csm-mcp/          # MCP 服务器,作为独立二进制打包
└── frontend/             # 纯 TypeScript + HTML + CSS,无打包器
    ├── ts/               # 源码,通过 tsc 编译到 js/
    ├── js/               # 生成产物,纳入版本控制
    └── index.html
```

**设计原则**

- 不引入前端框架(Vite / Nuxt / React)。当前规模下它们无法带来净收益,而渲染问题也并非框架能解决的
- 不使用 Web Components。Shadow DOM 的代价高于其在这里带来的收益
- 搜索留在 Rust 侧(Tantivy + lindera)。浏览器不是做这件事的地方

### 数据路径

| 类别 | 路径 |
|---|---|
| 读取 | `~/.claude/history.jsonl`、`~/.claude/projects/**/{sessionId}.jsonl` |
| 写入 | `~/Library/Application Support/com.cyocun.claude-session-manager/archive.json` |
| 设置 | `~/Library/Application Support/com.cyocun.claude-session-manager/settings.json` |
| 搜索索引 | `~/Library/Application Support/com.cyocun.claude-session-manager/search-index/` |

不做任何云端同步。应用唯一的出站流量是 **更新检查**。

---

## 开发

```bash
npm install
npm run tauri:dev          # 以 Tauri dev 模式启动
npm run check:types        # 前端类型检查
npm run build:frontend     # 仅编译 TS → JS
cd src-tauri && cargo test # Rust 测试
```

每当修改了 TypeScript,都需要重新执行 `npm run build:frontend`。生成的 `frontend/js/**` 纳入 Git 管理,必须提交。

## 发布

1. 同时在 `src-tauri/Cargo.toml` 和 `src-tauri/tauri.conf.json` 中升级 `version`
2. `git commit -am "Bump version to X.Y.Z"`
3. `git tag vX.Y.Z && git push --follow-tags`
4. `.github/workflows/release.yml` 会自动构建、签名并发布 macOS arm64 版本(约 8–10 分钟)

完整的贡献者说明请见 [`CLAUDE.md`](CLAUDE.md)。

## 许可证

Private(个人项目)。不对外开放使用或再分发。
